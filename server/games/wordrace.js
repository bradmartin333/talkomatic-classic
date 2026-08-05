// server/games/wordrace.js
// Everyone plays at once on the same 4x4 grid, so this game never queues.
// Words must trace a path through touching tiles (diagonals count) and no
// tile may be reused inside one word. A word more than one player found is
// worth nothing to anybody, which is what pushes people off the obvious ones.

const { RACE } = require("./words");

const SIZE = 4;
const CELLS = SIZE * SIZE;
const MIN_LEN = 3;
const DURATION_MS = 90000;

// Boggle's dice, with the Qu face swapped out. The shipped word list has very
// few q-words, so a Qu tile would just be a dead square.
const DICE = [
  "AAEEGN", "ABBJOO", "ACHOPS", "AFFKPS",
  "AOOTTW", "CIMOTU", "DEILRX", "DELRVY",
  "DISTTY", "EEGHNW", "EEINSU", "EHRTVW",
  "EIOSST", "ELRTTY", "HIMNKU", "HLNNRZ",
];

// Every prefix of every valid word, so the grid solver can stop walking a
// path the moment it cannot become a word. Built once, lazily.
let PREFIXES = null;
function prefixes() {
  if (PREFIXES) return PREFIXES;
  PREFIXES = new Set();
  for (const w of RACE) {
    for (let i = 1; i <= w.length; i++) PREFIXES.add(w.slice(0, i));
  }
  return PREFIXES;
}

let NEIGHBORS = null;
function neighbors() {
  if (NEIGHBORS) return NEIGHBORS;
  NEIGHBORS = [];
  for (let i = 0; i < CELLS; i++) {
    const r = Math.floor(i / SIZE);
    const c = i % SIZE;
    const list = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
        list.push(nr * SIZE + nc);
      }
    }
    NEIGHBORS.push(list);
  }
  return NEIGHBORS;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function rollGrid() {
  const dice = shuffle(DICE.slice());
  return dice.map((d) => d[Math.floor(Math.random() * d.length)]);
}

// Can this word be traced through touching tiles without reusing one?
function pathExists(grid, word) {
  const w = word.toUpperCase();
  const adj = neighbors();
  const walk = (cell, at, used) => {
    if (at === w.length) return true;
    for (const n of adj[cell]) {
      if (used & (1 << n)) continue;
      if (grid[n] !== w[at]) continue;
      if (walk(n, at + 1, used | (1 << n))) return true;
    }
    return false;
  };
  for (let i = 0; i < CELLS; i++) {
    if (grid[i] !== w[0]) continue;
    if (walk(i, 1, 1 << i)) return true;
  }
  return false;
}

// Every dictionary word hiding in this grid. Used to score the grid before we
// commit to it, and to show "you found 12 of 74" at the end.
function solve(grid) {
  const pre = prefixes();
  const adj = neighbors();
  const found = new Set();
  const walk = (cell, built, used) => {
    const next = built + grid[cell].toLowerCase();
    if (!pre.has(next)) return;
    if (next.length >= MIN_LEN && RACE.has(next)) found.add(next);
    for (const n of adj[cell]) {
      if (used & (1 << n)) continue;
      walk(n, next, used | (1 << n));
    }
  };
  for (let i = 0; i < CELLS; i++) walk(i, "", 1 << i);
  return found;
}

// Reroll until the grid is worth playing. A dud grid is the fastest way to
// make this game feel broken.
function goodGrid() {
  let best = null;
  let bestCount = -1;
  for (let attempt = 0; attempt < 25; attempt++) {
    const grid = rollGrid();
    const words = solve(grid);
    if (words.size > bestCount) {
      best = { grid, words };
      bestCount = words.size;
    }
    if (words.size >= 40) break;
  }
  return best;
}

function points(word) {
  const n = word.length;
  if (n <= 4) return 1;
  if (n === 5) return 2;
  if (n === 6) return 3;
  if (n === 7) return 5;
  return 11;
}

function create(players) {
  const { grid, words } = goodGrid();
  const now = Date.now();
  const state = {
    grid,
    possible: words.size,
    players: players.map((p) => ({ userId: p.userId, username: p.username })),
    words: {},
    startedAt: now,
    endsAt: now + DURATION_MS,
    durationMs: DURATION_MS,
    over: false,
    finalScores: null,
  };
  for (const p of players) state.words[p.userId] = [];
  return state;
}

function move(state, userId, mv) {
  if (state.over) return { ok: false, err: "The race is over." };
  if (!state.words[userId]) return { ok: false, err: "You are not in this race." };

  const raw = String((mv && mv.word) || "").trim().toLowerCase();
  if (!/^[a-z]+$/.test(raw)) return { ok: false, err: "Letters only." };
  if (raw.length < MIN_LEN)
    return { ok: false, err: `At least ${MIN_LEN} letters.` };
  if (state.words[userId].includes(raw))
    return { ok: false, err: "Already found." };
  if (!RACE.has(raw)) return { ok: false, err: "Not in the word list." };
  if (!pathExists(state.grid, raw))
    return { ok: false, err: "Those letters do not connect." };

  state.words[userId].push(raw);
  // The word itself is nobody else's business, but the running count is half
  // the tension, so that much goes out to the table as a small delta.
  return {
    ok: true,
    quiet: true,
    selfPush: true, // their private word list changed, so they need a resend
    accepted: raw,
    pts: points(raw),
    relay: {
      kind: "counts",
      counts: state.players.map((p) => ({
        userId: p.userId,
        count: (state.words[p.userId] || []).length,
      })),
    },
  };
}

function tick(state, now) {
  if (state.over) return false;
  if (now < state.endsAt) return false;
  finish(state);
  return true;
}

function finish(state) {
  // A word more than one player found scores zero for everyone who had it.
  const counts = new Map();
  for (const uid of Object.keys(state.words)) {
    for (const w of state.words[uid]) counts.set(w, (counts.get(w) || 0) + 1);
  }
  state.finalScores = state.players.map((p) => {
    const mine = state.words[p.userId] || [];
    let score = 0;
    const detail = mine.map((w) => {
      const dup = (counts.get(w) || 0) > 1;
      const pts = dup ? 0 : points(w);
      score += pts;
      return { word: w, pts, dup };
    });
    detail.sort((a, b) => b.pts - a.pts || a.word.localeCompare(b.word));
    return {
      userId: p.userId,
      username: p.username,
      score,
      words: detail,
    };
  });
  state.finalScores.sort((a, b) => b.score - a.score);
  state.over = true;
}

function turnOf() {
  return null; // simultaneous, nobody is ever "on the clock"
}

function isOver(state) {
  return !!state.over;
}

function result(state) {
  if (!state.over) return { winnerId: null, draw: false, scores: [] };
  const top = state.finalScores[0];
  const tied =
    state.finalScores.filter((s) => s.score === top.score).length > 1;
  return {
    winnerId: tied || !top.score ? null : top.userId,
    draw: tied,
    scores: state.finalScores.map((s) => ({
      userId: s.userId,
      score: s.score,
    })),
  };
}

// Each player sees their own words and everyone else's count, never their
// list. Handing out the other lists would just be free answers.
function view(state, userId) {
  const mine = state.words[userId] || [];
  return {
    grid: state.grid,
    size: SIZE,
    endsAt: state.endsAt,
    durationMs: state.durationMs,
    over: state.over,
    possible: state.possible,
    myWords: mine.map((w) => ({ word: w, pts: points(w) })),
    myScore: mine.reduce((n, w) => n + points(w), 0),
    players: state.players.map((p) => ({
      userId: p.userId,
      username: p.username,
      count: (state.words[p.userId] || []).length,
    })),
    finalScores: state.over ? state.finalScores : null,
  };
}

module.exports = {
  id: "wordrace",
  name: "Word Race",
  icon: { emoji: "🔤" },
  blurb: "Same grid, everyone at once. Ninety seconds. Nobody waits.",
  howTo: [
    "Everyone gets the same letters and ninety seconds.",
    "Letters must touch, including diagonally, and no tile twice in one word.",
    "Longer words score more. A word two people find scores nothing for either.",
  ],
  minPlayers: 2,
  maxPlayers: 20,
  turnBased: false,
  openMs: 20000,
  create,
  move,
  turnOf,
  tick,
  isOver,
  result,
  view,
  // exported for tests
  _pathExists: pathExists,
  _solve: solve,
  _points: points,
};
