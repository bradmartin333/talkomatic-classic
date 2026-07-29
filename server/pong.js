// server/pong.js
// Server-authoritative 1v1 pong, one game per room.
//
// Exactly two seats (left / right); everyone else with the overlay open
// spectates in a queue. First to WIN_SCORE takes the round: the winner keeps
// their seat, the loser goes to the back of the queue, the next spectator is
// seated, and the next round starts automatically after a countdown. With no
// spectators waiting, the same two players rematch.
//
// The simulation runs at 60 Hz with swept paddle collision (no tunnelling at
// high ball speed). State broadcasts go at 30 Hz and ONLY to sockets that have
// the overlay open, as a compact snapshot with a server timestamp so the
// client can interpolate. Names/avatars/queue go in a separate "pong meta"
// event that is only sent when the lineup or round state changes.

const FIELD_W = 1280;
const FIELD_H = 720;
const PADDLE_W = 14;
const PADDLE_H = 100;
const PADDLE_MARGIN = 36;
const PADDLE_SPEED = 2200; // px/s the paddle slews toward its target
const BALL_R = 10;
const SERVE_SPEED = 480;
const MAX_SPEED = 1150;
const SPEEDUP = 1.045; // per paddle hit
const MAX_BOUNCE_ANGLE = Math.PI / 3; // 60 degrees
const WIN_SCORE = 5;
const COUNTDOWN_MS = 3000; // before a round starts
const SERVE_DELAY_MS = 900; // freeze after each point
const NEXT_ROUND_MS = 7000; // winner screen duration

const games = new Map(); // roomId -> game
let ioGetter = null;

function io() {
  return ioGetter ? ioGetter() : null;
}

function createGame(roomId) {
  const game = {
    roomId,
    // userId -> { userId, name, avatar, socketId, joinedAt }
    participants: new Map(),
    seats: { left: null, right: null }, // userId or null
    queue: [], // userIds waiting for a seat, oldest first
    paddles: {
      left: { y: FIELD_H / 2, targetY: FIELD_H / 2 },
      right: { y: FIELD_H / 2, targetY: FIELD_H / 2 },
    },
    ball: { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: 0, prevY: FIELD_H / 2 },
    scores: { left: 0, right: 0 },
    status: "waiting", // waiting | countdown | playing | over
    countdownEndsAt: 0,
    serveAt: 0,
    nextRoundAt: 0,
    winner: null, // { side, name }
    lastTick: Date.now(),
    lastBroadcast: 0,
    interval: null,
  };
  game.interval = setInterval(() => tick(game), 1000 / 60);
  if (game.interval.unref) game.interval.unref();
  games.set(roomId, game);
  return game;
}

function getGame(roomId, create) {
  return games.get(roomId) || (create ? createGame(roomId) : null);
}

function destroyRoom(roomId) {
  const game = games.get(roomId);
  if (!game) return;
  clearInterval(game.interval);
  games.delete(roomId);
}

// ── Lineup ──────────────────────────────────────────────────────────────────

function seatOf(game, userId) {
  if (game.seats.left === userId) return "left";
  if (game.seats.right === userId) return "right";
  return null;
}

function seatPlayer(game, userId) {
  if (seatOf(game, userId)) return;
  const free = !game.seats.left ? "left" : !game.seats.right ? "right" : null;
  if (!free) {
    if (!game.queue.includes(userId)) game.queue.push(userId);
    return;
  }
  game.seats[free] = userId;
  game.queue = game.queue.filter((id) => id !== userId);
  game.paddles[free].y = FIELD_H / 2;
  game.paddles[free].targetY = FIELD_H / 2;
}

function promoteFromQueue(game) {
  while (game.queue.length) {
    const userId = game.queue[0];
    if (!game.participants.has(userId)) {
      game.queue.shift();
      continue;
    }
    seatPlayer(game, userId);
    return;
  }
}

function bothSeated(game) {
  return !!(game.seats.left && game.seats.right);
}

function parkBall(game) {
  game.ball.x = FIELD_W / 2;
  game.ball.y = FIELD_H / 2;
  game.ball.vx = 0;
  game.ball.vy = 0;
}

function beginRound(game) {
  game.scores.left = 0;
  game.scores.right = 0;
  game.winner = null;
  game.status = "countdown";
  game.countdownEndsAt = Date.now() + COUNTDOWN_MS;
  parkBall(game);
}

function toWaiting(game) {
  game.status = "waiting";
  game.scores.left = 0;
  game.scores.right = 0;
  game.winner = null;
  parkBall(game);
}

// ── Simulation ──────────────────────────────────────────────────────────────

function serve(game, dir) {
  game.ball.x = FIELD_W / 2;
  game.ball.y = FIELD_H / 2;
  const angle = (Math.random() * 0.5 - 0.25) * Math.PI; // within ±45°
  game.ball.vx = Math.cos(angle) * SERVE_SPEED * dir;
  game.ball.vy = Math.sin(angle) * SERVE_SPEED;
  game.serveAt = Date.now() + SERVE_DELAY_MS;
}

function scorePoint(game, side) {
  game.scores[side] += 1;
  if (game.scores[side] >= WIN_SCORE) {
    const userId = game.seats[side];
    const p = userId && game.participants.get(userId);
    game.status = "over";
    game.winner = { side, name: (p && p.name) || "Player" };
    game.nextRoundAt = Date.now() + NEXT_ROUND_MS;
    parkBall(game);
    emitMeta(game);
    return;
  }
  // Serve toward the player who just conceded
  serve(game, side === "left" ? -1 : 1);
}

// Swept collision against one paddle face: detects the ball crossing the
// face's x during this step, so a fast ball can never tunnel through.
function collide(game, side, prevX) {
  const pad = game.paddles[side];
  const face =
    side === "left"
      ? PADDLE_MARGIN + PADDLE_W + BALL_R
      : FIELD_W - PADDLE_MARGIN - PADDLE_W - BALL_R;
  const movingToward = side === "left" ? game.ball.vx < 0 : game.ball.vx > 0;
  if (!movingToward) return;
  const crossed =
    side === "left"
      ? prevX >= face && game.ball.x <= face
      : prevX <= face && game.ball.x >= face;
  if (!crossed) return;
  const span = game.ball.x - prevX;
  const t = span === 0 ? 0 : (face - prevX) / span;
  const hitY = game.ball.prevY + (game.ball.y - game.ball.prevY) * t;
  const half = PADDLE_H / 2 + BALL_R;
  if (Math.abs(hitY - pad.y) > half) return;

  const rel = Math.max(-1, Math.min(1, (hitY - pad.y) / half));
  const speed = Math.min(
    MAX_SPEED,
    Math.hypot(game.ball.vx, game.ball.vy) * SPEEDUP,
  );
  const angle = rel * MAX_BOUNCE_ANGLE;
  const dir = side === "left" ? 1 : -1;
  game.ball.vx = Math.cos(angle) * speed * dir;
  game.ball.vy = Math.sin(angle) * speed;
  game.ball.x = face;
  game.ball.y = hitY;
}

function tick(game) {
  const now = Date.now();
  const dt = Math.min(0.05, Math.max(0, (now - game.lastTick) / 1000));
  game.lastTick = now;

  // Paddles slew toward their targets
  for (const side of ["left", "right"]) {
    const pad = game.paddles[side];
    const diff = pad.targetY - pad.y;
    const step = PADDLE_SPEED * dt;
    pad.y =
      Math.abs(diff) <= step ? pad.targetY : pad.y + Math.sign(diff) * step;
  }

  if (game.status === "countdown" && now >= game.countdownEndsAt) {
    game.status = "playing";
    serve(game, Math.random() < 0.5 ? 1 : -1);
    emitMeta(game);
  }

  if (game.status === "over" && now >= game.nextRoundAt) {
    // Loser to the back of the queue, next challenger takes the seat
    const losingSide =
      game.winner && game.winner.side === "left" ? "right" : "left";
    const loser = game.seats[losingSide];
    if (game.queue.length && loser) {
      game.seats[losingSide] = null;
      if (game.participants.has(loser)) game.queue.push(loser);
      promoteFromQueue(game);
    }
    if (bothSeated(game)) beginRound(game);
    else toWaiting(game);
    emitMeta(game);
  }

  if (game.status === "playing" && now >= game.serveAt) {
    game.ball.prevY = game.ball.y;
    const prevX = game.ball.x;
    game.ball.x += game.ball.vx * dt;
    game.ball.y += game.ball.vy * dt;

    if (game.ball.y - BALL_R < 0) {
      game.ball.y = BALL_R;
      game.ball.vy = Math.abs(game.ball.vy);
    } else if (game.ball.y + BALL_R > FIELD_H) {
      game.ball.y = FIELD_H - BALL_R;
      game.ball.vy = -Math.abs(game.ball.vy);
    }

    collide(game, "left", prevX);
    collide(game, "right", prevX);

    if (game.ball.x + BALL_R < 0) scorePoint(game, "right");
    else if (game.ball.x - BALL_R > FIELD_W) scorePoint(game, "left");
  }

  if (now - game.lastBroadcast >= 1000 / 30) {
    game.lastBroadcast = now;
    emitState(game);
  }
}

// ── Broadcast ───────────────────────────────────────────────────────────────

function participantSockets(game) {
  const server = io();
  if (!server) return [];
  const out = [];
  for (const p of game.participants.values()) {
    const s = server.sockets.sockets.get(p.socketId);
    if (s && s.pongOpen) out.push(s);
  }
  return out;
}

// Compact 30 Hz snapshot. t is the server clock so clients can interpolate.
function emitState(game) {
  const state = {
    t: Date.now(),
    st: game.status,
    b: [Math.round(game.ball.x), Math.round(game.ball.y)],
    l: Math.round(game.paddles.left.y),
    r: Math.round(game.paddles.right.y),
    s: [game.scores.left, game.scores.right],
    cd: game.status === "countdown" ? game.countdownEndsAt : 0,
    nr: game.status === "over" ? game.nextRoundAt : 0,
  };
  for (const s of participantSockets(game)) s.emit("pong state", state);
}

function seatInfo(game, side) {
  const userId = game.seats[side];
  if (!userId) return null;
  const p = game.participants.get(userId);
  return p ? { name: p.name, avatar: p.avatar || null } : null;
}

// Lineup + rules. Sent only when something about it changes; the "you" field
// is personalized per socket.
function emitMeta(game) {
  const base = {
    field: { w: FIELD_W, h: FIELD_H },
    paddle: { w: PADDLE_W, h: PADDLE_H, margin: PADDLE_MARGIN },
    ballR: BALL_R,
    winScore: WIN_SCORE,
    left: seatInfo(game, "left"),
    right: seatInfo(game, "right"),
    queue: game.queue
      .filter((id) => game.participants.has(id))
      .map((id) => game.participants.get(id).name),
    watching: Math.max(
      0,
      game.participants.size -
        (game.seats.left ? 1 : 0) -
        (game.seats.right ? 1 : 0),
    ),
    status: game.status,
    winner: game.winner,
  };
  for (const s of participantSockets(game)) {
    const userId = s.handshake?.session?.userId;
    const seat = userId ? seatOf(game, userId) : null;
    s.emit("pong meta", {
      ...base,
      you: seat || "spectator",
      queuePos: seat ? 0 : game.queue.indexOf(userId) + 1 || 0,
    });
  }
}

// ── Membership ──────────────────────────────────────────────────────────────

function openFor(game, socket) {
  const userId = socket.handshake?.session?.userId;
  if (!userId) return;
  const name = socket.handshake?.session?.username || "Anonymous";
  const avatar = socket.handshake?.session?.avatar || null;
  const existing = game.participants.get(userId);
  if (existing) {
    existing.socketId = socket.id;
    existing.name = name;
    existing.avatar = avatar;
  } else {
    game.participants.set(userId, {
      userId,
      name,
      avatar,
      socketId: socket.id,
      joinedAt: Date.now(),
    });
  }
  // Take a free seat, otherwise join the queue
  if (!seatOf(game, userId)) {
    if (!bothSeated(game)) seatPlayer(game, userId);
    else if (!game.queue.includes(userId)) game.queue.push(userId);
  }
  if (game.status === "waiting" && bothSeated(game)) beginRound(game);
  emitMeta(game);
  emitState(game);
}

function leave(roomId, userId) {
  const game = games.get(roomId);
  if (!game || !userId) return;
  const seat = seatOf(game, userId);
  game.participants.delete(userId);
  game.queue = game.queue.filter((id) => id !== userId);

  if (seat) {
    game.seats[seat] = null;
    promoteFromQueue(game);
    // A player leaving voids the round in progress
    if (bothSeated(game)) beginRound(game);
    else toWaiting(game);
  }

  if (game.participants.size === 0) {
    destroyRoom(roomId);
    return;
  }
  emitMeta(game);
}

// ── Socket wiring ───────────────────────────────────────────────────────────

function registerSocket(socket, socketIo) {
  // rooms.js passes its lazy io() getter; accept a bare io instance too.
  ioGetter = typeof socketIo === "function" ? socketIo : () => socketIo;

  socket.on("pong open", () => {
    try {
      const roomId = socket.roomId;
      const userId = socket.handshake?.session?.userId;
      if (!roomId || !userId || socket.spectating) return;
      socket.pongOpen = true;
      const game = getGame(roomId, true);
      openFor(game, socket);
    } catch (e) {
      console.error("pong open error:", e);
    }
  });

  socket.on("pong close", () => {
    try {
      socket.pongOpen = false;
      const roomId = socket.roomId;
      const userId = socket.handshake?.session?.userId;
      if (roomId && userId) leave(roomId, userId);
    } catch (e) {
      console.error("pong close error:", e);
    }
  });

  socket.on("pong target", (data) => {
    try {
      const roomId = socket.roomId;
      const userId = socket.handshake?.session?.userId;
      if (!roomId || !userId || !socket.pongOpen) return;
      const game = games.get(roomId);
      if (!game) return;
      const seat = seatOf(game, userId);
      if (!seat) return;
      const y = Number(data?.y);
      if (!Number.isFinite(y)) return;
      const clamped = Math.max(0, Math.min(1, y));
      game.paddles[seat].targetY = Math.max(
        PADDLE_H / 2,
        Math.min(FIELD_H - PADDLE_H / 2, clamped * FIELD_H),
      );
    } catch (e) {
      // input path stays silent
    }
  });

  socket.on("disconnect", () => {
    try {
      if (!socket.pongOpen) return;
      const roomId = socket.roomId;
      const userId = socket.handshake?.session?.userId;
      if (roomId && userId) leave(roomId, userId);
    } catch (e) {}
  });
}

module.exports = { registerSocket, leave, destroyRoom, games };
