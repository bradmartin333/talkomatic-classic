# Staff v5: session changelog

Everything built in this session, in detail. This is an internal reference (it
lists abuse thresholds and anti-fraud rules), so consider keeping it out of the
public repo, the same way `update.md` is gitignored.

Nothing here was committed. All changes are file edits for review.

---

## 1. Two-tier moderators (L1 / L2)

Mod keys now carry a `level` (1 = junior, 2 = full). Every privileged action is
gated by level on the server, the same way dev-vs-mod was already gated.

**Level 1 (junior) can:** kick (no ban), warn, force rename, and report. That
is the whole list. L1's kick is deliberately weak (the user can rejoin at once),
which is the point of probation: a junior can interrupt but cannot stop a
determined troll alone, so they have to escalate.

**Level 2 (full) can:** everything L1 can, plus kick + room ban, IP block,
close room, lock room, slow mode, wipe typed text, clear Talkoboard, and
spectate. This is exactly today's moderator.

**Developers** are unchanged and can do everything.

**Grant / promote chain (enforced server-side):**

- Devs grant L2 keys and promote L1 to L2.
- Full (L2) mods can mint L1 keys, but cannot promote anyone and cannot act on
  other staff.
- L1 mods enforce only. They cannot grant or promote.

Backward compatibility: any key already in `mod-keys.json` with no `level` field
loads as L2, so no existing moderator was downgraded.

Badges: L2 shows a cyan `MOD` badge, L1 shows a purple `JR MOD` badge, in both
the room and the lobby. The badge updates live when a key is promoted or
demoted (no reload needed).

Where it lives:

- `server/roles.js`: `level` on each record, default 2 when missing,
  `grantModKey(label, level)`, `setModLevel(hash, level)`, level in
  `validateKey` / `listModKeys`.
- `server.js`: sets `socket.modLevel` on connect.
- `server/rooms.js`: `getUserModLevel`, `requireModLevel(socket, n)`, level gates
  on ban/IP block/close/lock/slow/wipe/board-clear/spectate, L1 kick forced to
  no-ban, `dev set mod level` (by hash) and `dev set mod level for user` (by
  userId), both dev-only; `dev grant mod to user` opened to L2 (forced L1).
- Client: `currentUserModLevel` tracked in `lobby-client.js` and `room-client.js`,
  level-aware menus and the staff panel, level selector on grant, promote /
  demote / grant-L1 in the dashboard and in-room.

## 2. Durable device identity and active-vs-new

Each browser keeps a random device id mirrored across localStorage, a cookie,
and IndexedDB, so clearing one layer self-heals from another. It is not a login
and is never trusted for anything privileged; it only powers "active vs new"
and invite credit.

- `public/js/identity.js` (new, loaded before the lobby and room clients):
  resolves the id synchronously from localStorage or cookie so it is ready for
  the socket handshake, then reconciles IndexedDB in the background. If
  localStorage was cleared but a backup still had the id, the user gets one
  gentle warning that their stats live in this browser.
- `server/identity.js` (new): `identity.json` per device with first seen, the
  set of distinct days seen, accumulated active minutes, and a participation
  counter. `isActive(deviceId)` is true at 2 or more distinct days, 15 or more
  minutes, and 10 or more participation ticks. Stored compactly, debounced,
  pruned, and capped.
- `server/rooms.js` records presence on connect, a throttled participation tick
  from the chat path, and session time on disconnect; it sends a compact
  activity summary to the client as `identity status`.

The defense is that faking an "active" identity takes real elapsed calendar
time and sustained presence per identity, which is expensive at scale.

## 3. Mod-abuse detection

`server/modwatch.js` keeps a short rolling log of each mod key's recent actions
and raises a single staff flag (full mods and devs) when the pattern looks like
misuse. It never auto-punishes; it surfaces the pattern with the mod's recent
actions attached, so a human decides.

Signals (all tunable in one block at the top of the file):

- more than 12 actions in 5 minutes,
- more than 60 actions in 60 minutes,
- 70 percent or more of recent actions (when there are at least 8) are kicks,
- the same user hit 4 or more times in 5 minutes,
- 6 or more different users hit in 5 minutes.

A flag is rate-limited to one per key per 10 minutes. Devs are not watched
(dev keys are owner-only). The flag text includes the reasons and the last 10
actions for context.

## 4. Unified staff inbox (dashboard)

The dashboard has one inbox that collects reports, mod applications, and
mod-abuse flags in a single feed, plus invite milestones. It is visible to full
mods and devs only; junior mods never receive these.

- `server/audit.js`: a `notification` entry type with a `minLevel` (2 = full
  mods and devs). `broadcast()` and `recent()` honor `minLevel` so juniors are
  excluded; `recordNotification(...)` also pushes a live `staff notice` toast to
  qualifying staff who are not on the dashboard, so nothing is missed.
- `public/mod.html` / `public/js/mod.js`: the Inbox filter with an unread badge,
  gated by `data-min2`. Each entry shows whether it is a report, an application,
  an abuse flag, or an invite milestone.

## 5. Reports (everyone can report anyone)

Every user has a report flag on other users' rows, including on staff, so a
normal user can flag a problem user or a misbehaving moderator.

- The report opens a category picker (Spam, Harassment, Hate speech, NSFW,
  Impersonation, Threats, Moderator abuse, Other) plus an optional detail box.
- `server/reports.js` (new): an in-memory tally per target with distinct-reporter
  counting (by device, so one person cannot inflate the number), a 24h window,
  caps, and a `summary()` / `forTarget()` for drill-down.
- The report notification names the target (and tags staff targets), the
  category, the detail, and how many distinct people have reported that user
  recently, so devs and full mods can see how many reported someone and why.
- Rate-limited to one report per 30 seconds per socket.

## 6. Mod applications

Active members apply from the lobby; the application lands in the staff inbox;
a dev or full mod approves; the server mints an L1 key and delivers it silently
to that browser (delivered now if they are online, otherwise claimed on their
next connect). Approval is the gate; nothing is ever auto-accepted.

- `server/applications.js` (new): `mod-applications.json`, one pending per
  device, word-filtered answers, claim-on-next-connect so no plaintext key is
  ever stored.
- The lobby "Become a moderator" link is gated to active members and hidden
  entirely from current staff.
- The dashboard "Applications" tab (full mods and devs) lists pending and
  resolved applications with approve and reject (with an optional private
  reason).

## 7. Invites and leaderboard

Each device gets a short, stable invite code and a personal link
(`/?ref=CODE`). Visiting with a ref records, once, who referred you.

- A referral only counts when the invitee becomes active (section 2) and does
  not share an IP with the inviter, so self-farming on one network does not pay.
- 10 active invites auto-files a (human-reviewed) mod application for the
  inviter. It never grants a role by itself.
- 100 active invites is a visible stretch goal labelled "developer access". It
  grants nothing; it only notifies devs.
- `server/invites.js` (new): `invites.json`, credit logic, `invitees()` so an
  inviter can see who they invited and whether each one is active or still
  pending, `leaderboard()` and `rankOf()`.
- The lobby Leaderboard link opens a redesigned, themed modal: a prominent
  personal invite link with a copy button, stat chips (active invites, rank,
  pending), milestone progress bars, the list of people you invited with a live
  Active or Pending status, and the top inviters.

## 8. UI, menu, and cleanup

- JR MOD (purple) and MOD (cyan) badges are now clearly different colors.
- Removed the Contributors and Apps links from the lobby menu.
- "Become a moderator" is hidden for current devs and mods.
- Every em dash was removed from the staff v5 files and replaced with a hyphen.

## 9. Per-room max size

A developer inside a room can set that room's capacity (2 to 50) without
touching any other room. The global default stays 5.

- `server/rooms.js`: a `roomCapacity(room)` helper returns the per-room
  `room.maxSize` override when set, otherwise the global default. It is used by
  the join capacity check and by the room formatters, so both enforcement and
  the lobby "X/N people" display follow the override. A new dev-only
  `dev set room size` event sets `room.maxSize` for the room the dev is in.
- The in-room staff panel control is now "Max size (this room)" and sends the
  per-room event. The lobby dev panel still has the global default ("Max room
  size") for new and other rooms.
- The per-room size lives on the in-memory room (rooms are not reloaded on
  restart, so it lasts as long as the room).

## 10. Device-type icon per user

Each user row in a room shows a small icon at the left for the device class:
mobile, tablet, TV, computer, or a question mark for unknown.

- `server/rooms.js`: `deviceTypeFromUA(ua)` derives a coarse class from the
  user agent on connect and attaches it to the room user payload through
  `formatUserForSocket`, so it covers the room user list and the live
  "user joined" broadcast. Purely cosmetic, never used for anything privileged.
- `public/js/room-client.js`: a FontAwesome icon per class with a tooltip,
  rendered at the start of each row.

## 11. Lobby menu layout

Long menu items (Update Notes, Staff/Dev Dashboard, Become a moderator) now span
the full width as their own rows via a `.wide` class, so two-word labels no
longer wrap awkwardly in the two-column grid. The Apps and Contributors links
were removed.

## 12. Live names + locations on the leaderboard

identity records now store the display name AND location, refreshed on every
sign-in or rename (identity.setName), so the People-you-invited list and the top
inviters always show a member's current username and location rather than an old
guest name. The leaderboard also auto-refreshes while open.

## 13. Persistence across restarts

invites.json, identity.json, and mod-applications.json save debounced during
normal operation and now also flush synchronously on a clean shutdown
(SIGINT/SIGTERM/beforeExit, wired in server.js), so recent invite credits, names,
and applications survive a restart or redeploy.

## 14. Top inviter trophies

The top 3 inviters get a trophy to the left of their username in the lobby and in
rooms: gold (1st), silver (2nd), bronze (3rd), using images/icons/trophy-gold.png,
trophy-silver.png, and trophy-bronze.png. invites.rankBadge(deviceId) computes the
rank; the user payload carries only inviteRank (the device id is never sent). A
missing PNG hides the badge gracefully.

## 15. Leaderboard redesign

The leaderboard modal is now two tabs:

- Global leaderboard: username / location on the left, total invites on the
  right; gold/silver/bronze trophies for the top 3 (with the name tinted to
  match) then plain numbered rows; 25 per page with Prev/Next pagination; and a
  live "Refreshing in Ns" countdown that auto-updates the board so names and
  ranks stay current.
- Your invites: the personal invite link with copy, stat chips, milestone
  progress bars, and the list of people you invited with live Active/Pending
  status.

## 16. One active room tab, lobby allowed

The single-tab guard moved from connect-time to room-join time and only pauses
other tabs that are in a room. You can now watch the lobby in one tab and chat in
another; mod.html is always exempt. Only a second room tab pauses the first.

## 17. Clearer "become a moderator" gate

The small, confusing toast was replaced with a themed modal that shows progress
toward each active threshold (days visited, active minutes, chat activity), for
example "Days visited: 1 of 2". identity.summary now includes the need thresholds.

## 18. Reports tab in the dashboard

A new Reports tab (full mods + devs) lists reported users grouped by target,
showing the distinct-reporter count, a category breakdown, recent reasons, and
whether the user is currently online and in which room. For online targets it
offers quick actions: Kick, and IP block for 1h / 24h / 7d (plus Permanent for
devs), which reuse the existing staff kick / staff ip block handlers. Backed by a
new `staff get reports` event; `server/reports.js` now also stores the target's
name so offline reports still show who they were.

## 19. Dashboard counts load immediately

The left-panel badges (Ban list, Moderators, Sessions, Applications, Reports)
used to show 0 until you opened each tab. They are now fetched as soon as the
dashboard authorizes, so the counts are correct on load.

## 20. Leaderboard fixed and given its own modal

Fixed a bug where the leaderboard was stuck on "Loading" and could not switch
tabs (the refresh setup nulled the body reference right after it was set).
Rebuilt it as its own large, centered, responsive modal (not the small shared
one): big on desktop, full-screen and centered on mobile, with the two tabs
(Global leaderboard, Your invites), the paginated trophy board, and the live
refresh countdown. Closes on the X, the backdrop, or Escape.

## Files

New:

- `server/identity.js`, `server/modwatch.js`, `server/applications.js`,
  `server/invites.js`, `server/reports.js`
- `public/js/identity.js`

Changed:

- `server/roles.js`, `server.js`, `server/rooms.js`, `server/audit.js`
- `public/js/lobby-client.js`, `public/js/room-client.js`, `public/js/mod.js`
- `public/index.html`, `public/room.html`, `public/mod.html`
- `.gitignore`

Cache versions bumped: `lobby-client.js` 2.12.0, `room-client.js` 3.8.0,
`mod.js` 3.3.0; new `identity.js` 1.0.0.

Image assets to add (referenced by the trophy badges and leaderboard, the code
hides them gracefully until they exist): `public/images/icons/trophy-gold.png`,
`trophy-silver.png`, `trophy-bronze.png`.

New gitignored runtime stores: `identity.json`, `invites.json`,
`mod-applications.json`. In-memory only (reset on restart by design):
mod-abuse windows and the report tally.

## New socket events

Client to server: `invite ref`, `leaderboard get`, `user report`,
`mod application submit`, `mod applications list`, `mod application review`,
`dev set mod level`, `dev set mod level for user`, `dev set room size`.

Server to client: `identity status`, `staff notice`, `report received`,
`mod application result`, `mod applications`, `leaderboard data`,
`staff level changed`, and `invite stats`.

## Tunable constants

- Active thresholds: top of `server/identity.js`.
- Abuse thresholds: `THRESHOLDS` in `server/modwatch.js`.
- Invite milestones: `MILESTONE_MOD` (10) and `MILESTONE_DEV` (100) in
  `server/invites.js`.
- Report categories and the 30s rate limit: `server/rooms.js`.

## Security properties

- Every privileged action is re-checked on the server by key hash and level.
  The client only hides what a role cannot do.
- No path grants power automatically. Invites and applications only ever produce
  a human-approved L1 key. The 100-invite developer goal is display only and is
  hard-blocked from escalating.
- IP addresses stay dev-only across the inbox, applications, and the leaderboard
  (names come from usernames, never IPs).
- All user text in new UI is rendered as text content or escaped, so it is XSS
  safe.

## Manual verification (two browsers, real keys)

1. Grant a junior key (dashboard, Grant mod, Junior). In a second window confirm
   kick and warn work, but ban, IP block, close, lock, slow, wipe, clear board,
   and spectate are absent and rejected if forced. Badge reads JR MOD (purple).
2. As a dev, promote that key to L2. The extra powers appear live; the badge
   turns cyan MOD.
3. Spam quick kicks as a mod and confirm a mod-abuse flag reaches the inbox for
   full mods and devs only, with the recent action list attached.
4. As a normal user, use the report flag on someone (or on a mod): pick a
   category, send it, and confirm staff see it with the running report count.
5. As an active member, use Become a moderator; approve it from the Applications
   tab; that browser becomes a junior mod.
6. Open the Leaderboard, copy your link, open it from a different browser and IP,
   make that browser genuinely active, and confirm your credited count and the
   invited-people list update.
