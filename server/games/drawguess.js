// server/games/drawguess.js
// One player draws, everybody else types guesses. The word never leaves the
// server for anyone but the drawer, and strokes are only accepted from the
// drawer, so neither can be faked from a patched client.
//
// The rotation picks whoever has drawn least rather than walking an index, so
// people joining and leaving mid-game cannot skew whose turn it is or strand
// the turn on an empty seat. Players can pass a turn or opt out of drawing
// entirely, and are then only picked if nobody else is willing.
//
// The canvas is versioned (state.rev). Strokes go out as deltas and the whole
// thing is only sent on request, which keeps this cheap with a crowd watching.

const { DRAW, prettyPrompt } = require("./words");

const CHOOSE_MS = 15000;
const DRAW_MS = 80000;
const REVEAL_MS = 7000;
const ROUNDS = 2; // each player draws this many times
const MAX_STROKES = 8000;
const IDLE_SKIP_MS = 25000; // blank canvas this long and the turn is skipped

// Ink. Sixteen is expressive without turning the toolbar into a paint program.
// Index 1 is white so it still reads on the dark paper.
const COLORS = [
  "#1b1b1b", "#ffffff", "#9e9e9e", "#6d4c41",
  "#e53935", "#ff7043", "#fb8c00", "#fdd835",
  "#c0ca33", "#43a047", "#00897b", "#00acc1",
  "#1e88e5", "#3949ab", "#8e24aa", "#d81b60",
];

// Paper. The drawer picks it, it lives on the canvas, so everybody sees the
// same thing and a late joiner gets it with their sync.
const BACKGROUNDS = ["#fdf5e6", "#ffffff", "#e8f2f7", "#eef3e2", "#232323"];

function pickWord(list, avoid) {
  for (let i = 0; i < 40; i++) {
    const w = list[Math.floor(Math.random() * list.length)];
    if (!avoid.has(w)) return w;
  }
  return list[Math.floor(Math.random() * list.length)];
}

function offerWords(used) {
  const avoid = new Set(used);
  return [
    pickWord(DRAW.easy, avoid),
    pickWord(DRAW.medium, avoid),
    pickWord(DRAW.hard, avoid),
  ];
}

function create(players) {
  const state = {
    players: players.map((p) => ({
      userId: p.userId,
      username: p.username,
      score: 0,
      joinedAt: Date.now(),
      noDraw: false, // opted out of taking a turn
    })),
    drawn: {}, // userId -> turns taken, drives the rotation
    turn: 0,
    drawerId: null,
    phase: "waiting",
    choices: [],
    word: null,
    lastWord: null,
    skipped: false,
    endsAt: 0,
    guessed: [], // { userId, username, pts, place, at }
    strokes: [],
    bg: 0,
    rev: 0, // bumped on every canvas change, so a client can spot a gap
    skipVotes: [], // userIds asking to move the round along
    used: [],
    over: false,
  };
  for (const p of state.players) state.drawn[p.userId] = 0;
  advance(state);
  return state;
}

// Whoever has drawn fewest, oldest player first on a tie. People who opted out
// are only considered when nobody else is willing, so a table of opt-outs still
// plays rather than deadlocking.
function pickDrawer(state) {
  const best = (skipOptOut) => {
    let found = null;
    for (const p of state.players) {
      if (skipOptOut && p.noDraw) continue;
      const n = state.drawn[p.userId] || 0;
      if (n >= ROUNDS) continue;
      if (!found || n < found.n || (n === found.n && p.joinedAt < found.p.joinedAt))
        found = { p, n };
    }
    return found ? found.p : null;
  };
  return best(true) || best(false);
}

// Decide what happens next: wait for company, hand out a word, or finish.
function advance(state) {
  state.guessed = [];
  state.strokes = [];
  state.skipVotes = [];
  state.rev++;
  state.word = null;
  state.choices = [];
  state.skipped = false;

  if (state.players.length < 2) {
    state.phase = "waiting";
    state.drawerId = null;
    state.endsAt = 0;
    return;
  }
  const next = pickDrawer(state);
  if (!next) {
    state.phase = "done";
    state.over = true;
    state.drawerId = null;
    state.endsAt = 0;
    return;
  }
  state.drawerId = next.userId;
  state.phase = "choosing";
  state.choices = offerWords(state.used);
  state.endsAt = Date.now() + CHOOSE_MS;
}

function startDrawing(state, word) {
  state.skipped = false;
  state.word = word;
  state.used.push(word);
  state.choices = [];
  state.phase = "drawing";
  state.endsAt = Date.now() + DRAW_MS;
}

function toReveal(state) {
  state.phase = "reveal";
  state.lastWord = state.word;
  state.endsAt = Date.now() + REVEAL_MS;
  state.drawn[state.drawerId] = (state.drawn[state.drawerId] || 0) + 1;
  state.turn++;
  state.skipVotes = [];

  // The drawer earns from how many people got there. A word nobody can guess
  // is worth nothing, and one everybody gets instantly is not worth much.
  const guessers = state.players.length - 1;
  if (guessers > 0 && state.guessed.length) {
    addScore(
      state,
      state.drawerId,
      Math.round(40 + 60 * (state.guessed.length / guessers)),
    );
  }
}

// Hand the pen on without costing them a go, so "not this one" is cheap and
// people actually use it instead of sitting on the clock.
function passTurn(state) {
  const current = state.drawerId;
  const p = state.players.find((x) => x.userId === current);
  if (p) p.joinedAt = Date.now(); // back of the tie-break queue
  state.drawn[current] = (state.drawn[current] || 0) + 1;
  advance(state);
}

function addScore(state, userId, n) {
  const p = state.players.find((x) => x.userId === userId);
  if (p) p.score += n;
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// One-edit distance, used only to tell a guesser they were close. Never
// reveals anything they did not already type.
function nearMiss(a, b) {
  if (!a || !b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// Letters appear as the clock runs down, never more than half the word.
function maskFor(state, now) {
  if (!state.word) return "";
  const word = state.word;
  const left = Math.max(0, state.endsAt - now);
  const elapsed = 1 - left / DRAW_MS;
  const letters = word.replace(/-/g, "").length;
  const maxHints = Math.max(1, Math.floor(letters / 2) - 1);
  let hints = 0;
  if (elapsed > 0.4) hints = 1;
  if (elapsed > 0.65) hints = 2;
  if (elapsed > 0.85) hints = 3;
  hints = Math.min(hints, maxHints);

  // Same positions every time for a given word, so hints never flicker.
  let seed = 0;
  for (let i = 0; i < word.length; i++)
    seed = (seed * 31 + word.charCodeAt(i)) >>> 0;
  const idxs = [];
  for (let i = 0; i < word.length; i++) if (word[i] !== "-") idxs.push(i);
  const shown = new Set();
  for (let k = 0; k < hints && k < idxs.length; k++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    shown.add(idxs[seed % idxs.length]);
  }
  let out = "";
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "-") out += "  ";
    else out += shown.has(i) ? word[i] : "_";
  }
  return out;
}

// Who still has not got it. Drives the "waiting on" line.
function pending(state) {
  return state.players
    .filter(
      (p) =>
        p.userId !== state.drawerId &&
        !state.guessed.some((g) => g.userId === p.userId),
    )
    .map((p) => ({ userId: p.userId, username: p.username }));
}

// Once most people have it, the rest can be moved along rather than everybody
// sitting out the clock for one person who has wandered off.
function skipThreshold(state) {
  const guessers = Math.max(1, state.players.length - 1);
  return Math.ceil(guessers / 2);
}

function canSkip(state) {
  return (
    state.phase === "drawing" && state.guessed.length >= skipThreshold(state)
  );
}

function move(state, userId, mv) {
  if (state.over) return { ok: false, err: "This game is over." };
  const kind = mv && mv.kind;
  const isDrawer = userId === state.drawerId;
  const me = state.players.find((p) => p.userId === userId);
  if (!me) return { ok: false, err: "You are not in this game." };

  if (kind === "pick") {
    if (!isDrawer) return { ok: false, err: "You are not drawing." };
    if (state.phase !== "choosing") return { ok: false, err: "Too late." };
    const i = Number(mv.index);
    if (!Number.isInteger(i) || i < 0 || i >= state.choices.length)
      return { ok: false, err: "Pick one of the words." };
    startDrawing(state, state.choices[i]);
    return { ok: true };
  }

  // "Not this one" during the pick, without burning the clock.
  if (kind === "passTurn") {
    if (!isDrawer) return { ok: false, err: "It is not your turn to draw." };
    if (state.phase !== "choosing")
      return { ok: false, err: "Too late to pass this one." };
    if (state.players.length < 2)
      return { ok: false, err: "Nobody else to hand it to." };
    passTurn(state);
    return { ok: true, announce: `${me.username} passed on drawing` };
  }

  // A standing "leave me out of the drawing".
  if (kind === "noDraw") {
    const on = !!mv.on;
    if (me.noDraw === on) return { ok: true, quiet: true, selfPush: true };
    me.noDraw = on;
    // Opting out while holding the pen hands it straight over.
    if (on && isDrawer && state.phase === "choosing" && state.players.length > 1) {
      passTurn(state);
      return { ok: true, announce: `${me.username} would rather not draw` };
    }
    return {
      ok: true,
      announce: on
        ? `${me.username} would rather not draw`
        : `${me.username} is happy to draw again`,
    };
  }

  if (kind === "bg") {
    if (!isDrawer) return { ok: false, err: "Only the drawer can change that." };
    const i = Number(mv.index);
    if (!Number.isInteger(i) || i < 0 || i >= BACKGROUNDS.length)
      return { ok: false, err: "Unknown background." };
    if (state.bg === i) return { ok: true, quiet: true };
    state.bg = i;
    state.rev++;
    return { ok: true, quiet: true, relay: { kind: "bg", bg: i, rev: state.rev } };
  }

  if (kind === "stroke") {
    if (!isDrawer) return { ok: false, err: "You are not drawing." };
    if (state.phase !== "drawing") return { ok: false, err: "Not drawing yet." };
    if (state.strokes.length >= MAX_STROKES)
      return { ok: false, err: "Canvas is full, clear it." };
    const s = sanitizeStroke(mv.stroke);
    if (!s) return { ok: false, err: "Bad stroke." };
    state.strokes.push(s);
    state.rev++;
    return {
      ok: true,
      quiet: true,
      relay: { kind: "stroke", stroke: s, rev: state.rev },
    };
  }

  if (kind === "clear") {
    if (!isDrawer) return { ok: false, err: "You are not drawing." };
    state.strokes = [];
    state.rev++;
    return { ok: true, quiet: true, relay: { kind: "clear", rev: state.rev } };
  }

  if (kind === "undo") {
    if (!isDrawer) return { ok: false, err: "You are not drawing." };
    // Lines arrive as many short segments, so undo drops the last brush stroke
    // rather than the last segment, which would barely change the picture.
    let i = state.strokes.length - 1;
    while (i > 0 && !state.strokes[i].start) i--;
    state.strokes = state.strokes.slice(0, i);
    state.rev++;
    return {
      ok: true,
      quiet: true,
      relay: { kind: "strokes", strokes: state.strokes, rev: state.rev },
    };
  }

  // Move the round along when most people already have it.
  if (kind === "skip") {
    if (state.phase !== "drawing") return { ok: false, err: "Nothing to skip." };
    if (!canSkip(state))
      return { ok: false, err: "Give people a bit longer first." };
    if (state.skipVotes.includes(userId))
      return { ok: false, err: "You already voted to move on." };
    state.skipVotes.push(userId);
    const need = Math.ceil(state.players.length / 2);
    if (state.skipVotes.length >= need) {
      toReveal(state);
      return { ok: true, announce: "Moving on to the next turn" };
    }
    return {
      ok: true,
      announce: `${me.username} wants to move on (${state.skipVotes.length}/${need})`,
    };
  }

  if (kind === "guess") {
    if (state.phase !== "drawing")
      return { ok: false, err: "Nothing to guess right now." };
    if (isDrawer) return { ok: false, err: "You are drawing this one." };
    if (state.guessed.some((g) => g.userId === userId))
      return { ok: false, err: "You already got it." };

    const guess = normalize(mv.text);
    if (!guess) return { ok: false, err: "Type a guess." };
    const target = normalize(state.word);

    if (guess !== target) {
      return {
        ok: true,
        quiet: true,
        correct: false,
        close: nearMiss(guess, target),
      };
    }

    const now = Date.now();
    const frac = Math.max(0, Math.min(1, (state.endsAt - now) / DRAW_MS));
    const pts = 50 + Math.round(150 * frac);
    state.guessed.push({
      userId,
      username: me.username,
      pts,
      at: now,
      place: state.guessed.length + 1,
    });
    addScore(state, userId, pts);

    const everyone = state.guessed.length >= state.players.length - 1;
    if (everyone) toReveal(state);
    return {
      ok: true,
      correct: true,
      pts,
      place: state.guessed.length,
      announce: `${me.username} guessed it`,
    };
  }

  return { ok: false, err: "Unknown action." };
}

function sanitizeStroke(s) {
  if (!s || typeof s !== "object") return null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
  };
  const x0 = num(s.x0);
  const y0 = num(s.y0);
  const x1 = num(s.x1);
  const y1 = num(s.y1);
  if (x0 === null || y0 === null || x1 === null || y1 === null) return null;
  const c = Number(s.c);
  const w = Number(s.w);
  const out = {
    x0, y0, x1, y1,
    c: Number.isInteger(c) && c >= 0 && c < COLORS.length ? c : 0,
    w: Number.isFinite(w) ? Math.max(1, Math.min(40, w)) : 4,
  };
  if (s.start) out.start = 1; // first segment of a brush stroke, for undo
  if (s.e) out.e = 1; // eraser: painted in the current background
  return out;
}

function tick(state, now) {
  if (state.over) return false;
  if (state.phase === "waiting") return false;

  // A drawer who has not put a single mark down is not drawing, they have
  // wandered off. Cut the turn short rather than make everyone sit it out.
  if (
    state.phase === "drawing" &&
    !state.strokes.length &&
    now > state.endsAt - DRAW_MS + IDLE_SKIP_MS
  ) {
    state.skipped = true;
    toReveal(state);
    return true;
  }

  if (!state.endsAt || now < state.endsAt) return false;

  if (state.phase === "choosing") {
    startDrawing(state, state.choices[0]);
    return true;
  }
  if (state.phase === "drawing") {
    toReveal(state);
    return true;
  }
  if (state.phase === "reveal") {
    advance(state);
    return true;
  }
  return false;
}

// Somebody walked in on a game already running. They play from the next turn,
// and if the game was parked waiting for company it starts right now.
function addPlayer(state, p) {
  if (state.over) return false;
  if (state.players.some((x) => x.userId === p.userId)) return false;
  state.players.push({
    userId: p.userId,
    username: p.username,
    score: 0,
    joinedAt: Date.now(),
    noDraw: false,
  });
  state.drawn[p.userId] = 0;
  if (state.phase === "waiting") {
    advance(state);
    return true;
  }
  return true;
}

function removePlayer(state, userId) {
  const was = state.drawerId === userId;
  state.players = state.players.filter((p) => p.userId !== userId);
  state.guessed = state.guessed.filter((g) => g.userId !== userId);
  state.skipVotes = state.skipVotes.filter((v) => v !== userId);
  delete state.drawn[userId];

  if (state.players.length < 2) {
    // Not enough people left to play. Park rather than end, so one person can
    // hold the game open until somebody else arrives.
    if (state.players.length === 0) {
      state.over = true;
      state.phase = "done";
    } else {
      advance(state);
    }
    return true;
  }
  if (was) {
    advance(state);
    return true;
  }
  // The drawer may now be the only one left who has not guessed.
  if (
    state.phase === "drawing" &&
    state.guessed.length >= state.players.length - 1
  ) {
    toReveal(state);
    return true;
  }
  return false;
}

function turnOf() {
  return null; // the drawer is on a clock; guessers are not, so no turn timer
}

function isOver(state) {
  return !!state.over;
}

function result(state) {
  const ranked = state.players.slice().sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const tied =
    ranked.filter((p) => p.score === (top ? top.score : 0)).length > 1;
  return {
    winnerId: !top || tied || !top.score ? null : top.userId,
    draw: tied && !!top && top.score > 0,
    scores: ranked.map((p) => ({
      userId: p.userId,
      username: p.username,
      score: p.score,
    })),
  };
}

function snapshotStrokes(state) {
  return { strokes: state.strokes, rev: state.rev, bg: state.bg };
}

function view(state, userId) {
  const now = Date.now();
  const amDrawer = userId === state.drawerId;
  const revealing = state.phase === "reveal" || state.phase === "done";
  const drawer = state.players.find((p) => p.userId === state.drawerId);
  const me = state.players.find((p) => p.userId === userId);
  const done = state.players.reduce(
    (n, p) => n + Math.min(ROUNDS, state.drawn[p.userId] || 0),
    0,
  );
  return {
    phase: state.phase,
    endsAt: state.endsAt,
    phaseMs:
      state.phase === "drawing"
        ? DRAW_MS
        : state.phase === "choosing"
          ? CHOOSE_MS
          : REVEAL_MS,
    turn: done,
    totalTurns: state.players.length * ROUNDS,
    rounds: ROUNDS,
    drawerId: state.drawerId,
    drawerName: drawer ? drawer.username : null,
    amDrawer,
    // The word goes to the drawer only, and to everyone once it is revealed.
    word: amDrawer ? prettyPrompt(state.word) : null,
    reveal: revealing ? prettyPrompt(state.lastWord || state.word) : null,
    hint: !amDrawer && state.phase === "drawing" ? maskFor(state, now) : null,
    choices:
      amDrawer && state.phase === "choosing"
        ? state.choices.map(prettyPrompt)
        : null,
    // No stroke array here: sent once on join, then kept current by deltas.
    rev: state.rev,
    bg: state.bg,
    backgrounds: BACKGROUNDS,
    colors: COLORS,
    strokeCount: state.strokes.length,
    guessed: state.guessed.map((g) => ({
      userId: g.userId,
      username: g.username,
      pts: g.pts,
      place: g.place,
    })),
    waitingOn: state.phase === "drawing" ? pending(state) : [],
    iGuessed: state.guessed.some((g) => g.userId === userId),
    canGuess:
      !amDrawer &&
      state.phase === "drawing" &&
      !state.guessed.some((g) => g.userId === userId),
    iNoDraw: !!(me && me.noDraw),
    canSkip: canSkip(state),
    skipVotes: state.skipVotes.length,
    skipNeeded: Math.ceil(state.players.length / 2),
    iSkipped: state.skipVotes.includes(userId),
    players: state.players
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((p) => ({
        userId: p.userId,
        username: p.username,
        score: p.score,
        drawing: p.userId === state.drawerId,
        got: state.guessed.some((g) => g.userId === p.userId),
        noDraw: !!p.noDraw,
        drawn: state.drawn[p.userId] || 0,
      })),
    over: state.over,
  };
}

module.exports = {
  id: "drawguess",
  name: "Draw & Guess",
  icon: { emoji: "🎨" },
  blurb: "One person draws, everyone else races to name it.",
  howTo: [
    "The drawer picks a word and has eighty seconds to draw it.",
    "Everyone else types guesses. The faster you get it, the more you score.",
    "The drawer scores from how many people work it out.",
    "Not feeling it? Pass the turn, or opt out of drawing for the whole game.",
    "Once half the room has guessed, anyone can vote to move on.",
  ],
  // One person can open it and hold it while others turn up.
  minPlayers: 1,
  maxPlayers: 12,
  turnBased: false,
  joinInProgress: true,
  openMs: 8000,
  colors: COLORS,
  backgrounds: BACKGROUNDS,
  create,
  move,
  turnOf,
  tick,
  isOver,
  result,
  view,
  addPlayer,
  removePlayer,
  snapshotStrokes,
};
