// server/games/drawguess.js
// One player draws, everybody else types guesses. The word never leaves the
// server for anyone but the drawer, and strokes are only accepted from the
// drawer, so neither can be faked from a patched client.
//
// The rotation picks whoever has drawn least rather than walking an index, so
// people joining and leaving mid-game cannot skew whose turn it is or strand
// the turn on an empty seat. One player on their own sits in "waiting" until
// somebody else turns up, which is why this game accepts a single player.

const { DRAW, prettyPrompt } = require("./words");

const CHOOSE_MS = 15000;
const DRAW_MS = 80000;
const REVEAL_MS = 7000;
const ROUNDS = 2; // each player draws this many times
const MAX_STROKES = 6000;
const IDLE_SKIP_MS = 25000; // blank canvas this long and the turn is skipped
const COLORS = 8;

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
    guessed: [], // { userId, username, pts, at }
    strokes: [],
    rev: 0, // bumped on every canvas change, so a client can spot a gap
    used: [],
    over: false,
  };
  for (const p of state.players) state.drawn[p.userId] = 0;
  advance(state);
  return state;
}

function rounds(state) {
  return ROUNDS;
}

// Whoever has drawn fewest, oldest player first on a tie. Stable under joins
// and leaves, which an index into a rotation array is not.
function pickDrawer(state, exclude) {
  let best = null;
  for (const p of state.players) {
    if (exclude && p.userId === exclude) continue;
    const n = state.drawn[p.userId] || 0;
    if (n >= ROUNDS) continue;
    if (!best || n < best.n || (n === best.n && p.joinedAt < best.p.joinedAt))
      best = { p, n };
  }
  return best ? best.p : null;
}

// Decide what happens next: wait for company, hand out a word, or finish.
function advance(state) {
  state.guessed = [];
  state.strokes = [];
  state.rev++;
  state.word = null;
  state.choices = [];

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

function move(state, userId, mv) {
  if (state.over) return { ok: false, err: "This game is over." };
  const kind = mv && mv.kind;
  const isDrawer = userId === state.drawerId;
  const inGame = state.players.some((p) => p.userId === userId);
  if (!inGame) return { ok: false, err: "You are not in this game." };

  if (kind === "pick") {
    if (!isDrawer) return { ok: false, err: "You are not drawing." };
    if (state.phase !== "choosing") return { ok: false, err: "Too late." };
    const i = Number(mv.index);
    if (!Number.isInteger(i) || i < 0 || i >= state.choices.length)
      return { ok: false, err: "Pick one of the words." };
    startDrawing(state, state.choices[i]);
    return { ok: true };
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
    const end = state.strokes.length;
    let i = end - 1;
    while (i > 0 && !state.strokes[i].start) i--;
    state.strokes = state.strokes.slice(0, i);
    state.rev++;
    return {
      ok: true,
      quiet: true,
      relay: { kind: "strokes", strokes: state.strokes, rev: state.rev },
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
    const p = state.players.find((x) => x.userId === userId);
    state.guessed.push({
      userId,
      username: p ? p.username : "Someone",
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
      announce: `${p ? p.username : "Someone"} guessed it`,
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
    c: Number.isInteger(c) && c >= 0 && c < COLORS ? c : 0,
    w: Number.isFinite(w) ? Math.max(1, Math.min(28, w)) : 3,
  };
  if (s.start) out.start = 1; // first segment of a brush stroke, for undo
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

function view(state, userId) {
  const now = Date.now();
  const amDrawer = userId === state.drawerId;
  const revealing = state.phase === "reveal" || state.phase === "done";
  const drawer = state.players.find((p) => p.userId === state.drawerId);
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
    skipped: !!state.skipped,
    hint: !amDrawer && state.phase === "drawing" ? maskFor(state, now) : null,
    // Choices are the drawer's alone; others just see that a pick is pending.
    choices:
      amDrawer && state.phase === "choosing"
        ? state.choices.map(prettyPrompt)
        : null,
    // Deliberately no stroke array here: it is sent once on join and then
    // kept up to date by deltas. Shipping it on every push meant serialising
    // thousands of segments per viewer per change.
    rev: state.rev,
    strokeCount: state.strokes.length,
    guessed: state.guessed.map((g) => ({
      userId: g.userId,
      username: g.username,
      pts: g.pts,
      place: g.place,
    })),
    iGuessed: state.guessed.some((g) => g.userId === userId),
    canGuess:
      !amDrawer &&
      state.phase === "drawing" &&
      !state.guessed.some((g) => g.userId === userId),
    players: state.players
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((p) => ({
        userId: p.userId,
        username: p.username,
        score: p.score,
        drawing: p.userId === state.drawerId,
        got: state.guessed.some((g) => g.userId === p.userId),
        drawn: state.drawn[p.userId] || 0,
      })),
    over: state.over,
  };
}

function snapshotStrokes(state) {
  return { strokes: state.strokes, rev: state.rev };
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
    "Anyone can join partway through and draws on their turn.",
  ],
  // One person can open it and hold it while others turn up.
  minPlayers: 1,
  maxPlayers: 12,
  turnBased: false,
  joinInProgress: true,
  openMs: 8000,
  colors: COLORS,
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
  rounds,
};
