# Talkoboard realtime: smooth drawing and cursors

How to build a collaborative drawing surface over Node.js + Socket.IO that feels
instant to draw on and never shows jittery, snapping, or "teleporting" cursors,
even when other people are on a 40 ms (or worse) connection.

This is the engineering reference for the Talkomatic Talkoboard. It is also a
general guide: the same model is what fast games (Fortnite, anything on Valve's
Source engine) and collaborative tools (Figma) use under the hood.

---

## TL;DR

There are two channels, and they get opposite treatment:

1. **Your own ink and your own cursor.** Render them locally, immediately, and
   never wait for the server. This is *client-side prediction*. Your input has
   literally zero added network latency, so drawing always feels instant.

2. **Everyone else's ink and cursor.** Render them on a small fixed delay and
   *interpolate* between the packets you actually received. This is *entity
   interpolation*. On a missing packet, **hold** the last position; never guess
   ahead. This is what removes jitter and snapping.

That is the whole trick. Everything below is detail and tuning.

---

## Why the naive version feels bad

The obvious implementation is: on every mouse move, send `{x, y}` to the server,
which relays it to everyone, and each client sets the cursor to that position the
instant the packet lands.

It feels terrible, for two reasons:

- **Packets do not arrive on a smooth clock.** You sample the pointer maybe 60 to
  120 times a second, but you only *send* every 40 to 50 ms (you have to throttle
  or you flood the room). On the receiving side those packets land every 40 to
  50 ms *plus* network variation (typically another 5 to 15 ms of jitter). If you
  move the cursor only when a packet lands, it advances in 12 to 15 visible jumps
  per second instead of 60+. The eye reads that as stutter and "snapping."

- **Extrapolation overshoots.** A common "fix" is to predict where the remote
  cursor is going and project past the last known point. The moment the other
  person stops or changes direction, your projection is wrong and the cursor
  visibly snaps back to the truth. That snap-back is worse than the original
  stutter.

So the naive version gives you stutter, and the naive fix gives you snapping.
Both are exactly what we do not want.

---

## The model: predict locally, interpolate remotely

### Pillar 1 - Client-side prediction (your input is zero added latency)

When you draw, the stroke appears under your pen on the same frame, drawn
straight to the canvas. You do **not** wait for the server to acknowledge
anything. The network send happens in parallel and is irrelevant to what you
see.

In the Talkoboard this is `onPointerMove` -> `drawSegmentsIncremental`: the new
segment is painted from the local stroke immediately, and the point is *also*
pushed to a network buffer for later. Your latency to your own ink is one frame
(~16 ms), no matter your ping. This is the single most important reason it feels
instant, and it is the same reason your own character in Fortnite moves the
instant you press a key while the server is still catching up.

### Pillar 2 - Batch the network, do not drip packets

Sending one packet per pointer sample is both wasteful and pointless (the
receiver cannot render faster than its screen refreshes anyway). Instead,
collect samples and flush them on a fixed cadence.

- Drawing points are buffered and flushed every `FLUSH_INTERVAL` (25 ms) as a
  `board stroke move` batch.
- Cursor position is throttled to one sample every `CURSOR_SEND_INTERVAL`
  (~40 to 50 ms).
- Points that are closer than `MIN_POINT_DISTANCE_SQ` to the previous point are
  dropped, so a slow careful line does not send hundreds of redundant points.

Batching cuts bandwidth and CPU dramatically and changes nothing about how the
result looks, because of Pillar 3.

### Pillar 3 - Entity interpolation (the anti-jitter core)

This is the part that makes other people's cursors smooth. Three rules:

**a) Render slightly in the past.** Pick a render delay (Talkoboard uses
`CURSOR_RENDER_DELAY`, ~70 to 90 ms). Instead of drawing remote cursors at "now,"
draw them at `now - renderDelay`. Because the delay is larger than the send
interval, by the time you need to draw a given moment you have *already received*
the packet on each side of it. You are always interpolating between two real,
known positions, never guessing.

**b) Buffer snapshots, tagged with local arrival time.** Every incoming cursor
packet is pushed into a small per-user buffer as `{t, x, y}`, where `t` is the
local clock when it arrived (not a server timestamp - this sidesteps all
clock-skew problems). You keep a short history, not just the latest value.

**c) One animation loop, linear interpolation, hold at the ends.** A single
`requestAnimationFrame` loop runs at the display refresh rate (60, 120, 144 Hz
- whatever the monitor does). Each frame it computes `renderTime = now -
renderDelay`, finds the two buffered snapshots that straddle `renderTime`, and
does a straight **linear** blend between them. When `renderTime` is past the
newest snapshot (the sender paused, or a packet is late), it **holds** at the
last known position and does not extrapolate.

Two details that matter:

- **Linear, not eased.** It is tempting to use a CSS `ease-in-out` transition.
  Do not. Easing slows the cursor at the start and end of every 40 ms hop, so it
  pulses "fast-slow-fast-slow." Linear keeps a constant speed across hops, which
  reads as one smooth motion. (Liveblocks found the same thing building Figma-
  style cursors: linear is smoother than easing for this exact reason.)

- **rAF, not a timer.** Driving the position from `requestAnimationFrame` means
  the cursor moves on *every* frame the monitor draws, decoupled entirely from
  the 40 ms packet clock. A 144 Hz screen gets 144 smooth cursor updates per
  second out of ~25 packets per second.

---

## Cursors versus strokes: interpolate the point, append the path

A subtle but important distinction, and the reason the Talkoboard interpolates
cursors but *not* strokes:

- A **cursor** is a single moving point. Between two packets it was somewhere you
  were not told about, so you reconstruct that "somewhere" by interpolating. If
  you do not, it teleports.

- A **stroke** is an accumulating path. You are sent every point in order
  (`board stroke start` / `move` / `end`), and you draw the whole path so far by
  connecting them. There is no gap to invent: you render exactly the line the
  other person drew, point for point. Connecting consecutive points with a line
  (and smoothing the full redraw with quadratic beziers through the midpoints)
  is already continuous. Interpolating a stroke would mean *delaying* ink for no
  visual gain.

So: moving entities get interpolation; growing paths get appended and smoothed.
Mixing these up (interpolating strokes, or appending cursor packets) is the most
common way people make this feel wrong.

---

## Is this really "near zero lag, like Fortnite"? Yes - the honest accounting

It is worth being precise instead of hand-wavy, because "no lag" is not literally
true for *remote* data and pretending otherwise leads to bad engineering.

- **Your own input: 0 ms added.** Local prediction draws your ink and your cursor
  on the next frame regardless of ping. This is genuinely as fast as a single-
  player paint app. There is nothing to improve here; the network is not in the
  loop.

- **Everyone else: ~70 to 100 ms behind reality, and that is correct.** You see
  other people in the recent past by exactly the render delay plus their share of
  network latency. For drawing and cursors this is imperceptible - nobody can
  tell whether a stranger's cursor is where it is "now" or where it was 80 ms ago,
  because they have no other reference for "now." What they *can* instantly tell
  is whether the motion is smooth. So we trade a tiny, invisible amount of
  staleness for large, very visible smoothness. That is the same trade Valve's
  Source engine makes (default interpolation period 100 ms) and the same one
  Gabriel Gambetta describes in his fast-paced multiplayer series: "every player
  sees itself in the present and sees other entities in the past."

In Fortnite terms: your build piece snaps up the instant you click (prediction),
while the other player you are watching is rendered an interpolation-window in the
past so they glide instead of stutter. At 40 ms ping it feels like no delay
because the only delay is on the half of the picture where you cannot perceive
delay anyway. This is the best achievable result over the public internet without
lying to the user (e.g. faking motion with extrapolation, which then snaps).

**Conclusion: yes, this is the right way, and it is the same way the games you are
thinking of do it.** There is no technique that makes *remote* data appear with
zero latency, because information cannot arrive before it is sent. What you can do
- and what this does - is make the local half truly instant and the remote half
truly smooth.

---

## Tuning constants (Talkomatic values)

| Constant | Value | Why |
| --- | --- | --- |
| `FLUSH_INTERVAL` (stroke points) | 25 ms | ~40 batches/sec; dense enough to feel live, sparse enough to not flood. |
| `CURSOR_SEND_INTERVAL` | ~40 to 50 ms | ~20 to 25 cursor packets/sec per person. |
| `CURSOR_RENDER_DELAY` | ~70 to 90 ms | Must exceed the send interval so there are always two snapshots to blend. |
| `CURSOR_TIMEOUT` | 3000 ms | No packet for 3 s -> hide that cursor entirely. |
| `MIN_POINT_DISTANCE_SQ` | 2.25 (1.5 px) | Drop near-duplicate points before they ever hit the wire. |

Rule of thumb for the render delay: set it to **1.5x to 2x the send interval**.
Too small and you run out of buffer between packets (back to stutter); too large
and remote cursors feel laggy. 70 to 90 ms is the sweet spot for a 40 to 50 ms
send rate.

---

## Would variable / adaptive interpolation help?

Short answer: **not worth it for this app.** Mostly wasted effort.

Adaptive interpolation means measuring each sender's effective packet rate and
jitter and growing or shrinking that viewer's render delay to match - a bigger
buffer for a flaky connection, a tighter one for a clean LAN. It is a real
technique and games with competitive stakes (where 30 ms of staleness changes who
wins a fight) do implement it.

For a drawing board it earns very little:

- The render delay is *per viewer per remote user*, and the buffer already
  absorbs normal jitter. A late packet just means one extra frame of "hold,"
  which nobody notices on a cursor.
- The downside risk is real: a delay that changes while you watch makes the
  cursor subtly speed up and slow down on its own, which can look *worse* than a
  fixed, slightly-too-large delay.
- There is no competitive stakes here. Being 90 ms versus 60 ms behind on someone
  else's doodle is invisible.

The one cheap, robust thing that captures 90% of the benefit without the
downside: pick a fixed delay near the high end of comfortable (the ~80 ms we use)
so even a jittery sender almost always has two snapshots to blend, and let the
"hold on starvation" rule cover the rare gap. That is a fixed buffer sized for the
worst common case, which is simpler and steadier than a moving target.

If this were a real-time *game* with hit detection, the answer would flip and
adaptive buffering (plus lag compensation) would be worth it. For collaborative
drawing, fixed-delay interpolation is the correct level of effort.

---

## Would Konva or Fabric help?

Short answer: **no, and they would not be allowed here anyway.**

Konva and Fabric are *scene-graph* canvas libraries. They keep an object model of
shapes (rectangles, paths, images) and re-render it for you, with hit detection,
selection handles, transforms, and z-ordering. They are excellent for an editor
where you select and move discrete objects (a diagram tool, a design canvas).

They do not help here, for several reasons:

- **They solve a problem we do not have.** The hard part of this feature is the
  *network smoothness* (prediction + interpolation), which lives entirely in how
  you time and blend packets. A scene-graph library does nothing for that; you
  would still write the exact same interpolation loop on top of it.

- **They can make freehand drawing slower, not faster.** For dense freehand ink,
  retaining every stroke as a live, hit-testable scene-graph node costs more
  memory and CPU than what we do now: draw segments straight to a raw 2D context
  incrementally, and only do a full bezier redraw on pan/zoom. Raw canvas is the
  fast path for ink; object models are the fast path for *editable shapes*.

- **They fight the architecture.** Our strokes are a flat list of points streamed
  start/move/end and rendered immediately. There is no object to select, drag, or
  re-layer, so the entire value proposition of the library is unused weight.

- **Project constraint.** Talkomatic has a hard rule of no build step and no new
  runtime dependencies. Adding a canvas framework violates that directly, for
  features we would not use.

If the Talkoboard ever grows into a true object editor (move a shape after
drawing it, multi-select, layers), revisit Konva at that point. For streamed
freehand ink with smooth multiplayer cursors, raw canvas plus the interpolation
model above is both faster and simpler.

---

## What the Talkoboard actually does (file map)

- `public/js/talkoboard.js`
  - **Local prediction:** `onPointerDown` / `onPointerMove` /
    `drawSegmentsIncremental` draw your stroke immediately while buffering points
    for the network.
  - **Batching:** `flush` (points, every `FLUSH_INTERVAL`) and
    `sendCursorPosition` (throttled to `CURSOR_SEND_INTERVAL`).
  - **Remote strokes:** `handleRemoteStrokeStart/Move/End` append and
    incrementally render the other person's path; `renderStrokeSmooth` does the
    bezier-through-midpoints smoothing on full redraws.
  - **Remote cursors (interpolated):** `updateRemoteCursor` buffers snapshots;
    `_cursorFrame` / `_sampleCursor` / `_pruneCursorBuf` run the rAF loop that
    renders each cursor at `now - CURSOR_RENDER_DELAY`, linearly blended, holding
    on starvation. Positions are buffered in **world** coordinates and converted
    with `worldToScreen` each frame, so cursors stay glued to the board correctly
    even while you pan or zoom.
- `server/rooms.js` - the `board cursor`, `board stroke *`, and `board chat`
  handlers simply relay between people in the same room and store stroke history
  so a late joiner sees the existing drawing. The server does no interpolation;
  all smoothing is client-side, which is correct (the server should stay a dumb,
  fast relay).

---

## References

- Gabriel Gambetta, *Fast-Paced Multiplayer (Part III): Entity Interpolation* -
  https://www.gabrielgambetta.com/entity-interpolation.html
- Valve, *Source Multiplayer Networking* (interpolation, default 100 ms) -
  https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking
- Liveblocks, *How to animate multiplayer cursors* (linear beats easing) -
  https://liveblocks.io/blog/how-to-animate-multiplayer-cursors
- SnapNet, *Netcode Architectures Part 3: Snapshot Interpolation* -
  https://snapnet.dev/blog/netcode-architectures-part-3-snapshot-interpolation/
