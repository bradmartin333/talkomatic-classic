// server/rooms.js
// Room management, chat processing, AFK handling, socket events, cleanup.
// Includes anti-spam (pressure cleanup, per-IP limits), vote-kick, dev mode
// (force-kick, vanish, hide, color), and Talkoboard stroke storage.

const path = require("path");
const fs = require("fs").promises;
const { DATA_DIR } = require("./datadir");
const {
  CONFIG,
  ERROR_CODES,
  wordFilter,
  state,
  createErrorResponse,
  normalize,
  promisifySessionSave,
  sanitizeMessage,
  sanitizeName,
  enforceCharacterLimit,
  enforceUsernameLimit,
  enforceLocationLimit,
  enforceRoomNameLimit,
  isReservedName,
  isListedName,
} = require("./state");
const {
  chatUpdateLimiter,
  typingLimiter,
  detectBotBehavior,
  isBlacklisted,
  createIPBasedUser,
  validateObject,
} = require("./security");

// Effective capacity for a room: a per-room override (set by a dev inside the
// room) wins over the global default, so raising one room to 50 never changes
// the 10-person limit in other rooms.
function roomCapacity(room) {
  const n = room && Number(room.maxSize);
  return Number.isFinite(n) && n >= 2
    ? Math.floor(n)
    : CONFIG.LIMITS.MAX_ROOM_CAPACITY;
}


function deviceTypeFromUA(ua) {
  if (!ua || typeof ua !== "string") return "unknown";

  const s = ua.toLowerCase();
  const E_READER_RE = /(kindle|pocketbook|kobo|nook|remarkable|noteair|nova[0-9]color|poke[0-9]color|tabultracpro|volta|kf[ot]t|kfsow[ai]|kfjw[ai]|kfthw[ai]|kfapw[ai])/i;

  // highest priority

  if (/(talkobot|robot|crawler|spider|slurp|curl|wget|node)/i.test(s))
    return "bot";

  if (/(raspbian|raspberry pi)/i.test(s))
    return "raspi";

  if (/(projector|projector build|smart projector|sti[0-9]+ build)/i.test(s)) // why? have some whimsy -- why not?
    return "projector";

  if (/fridge|refrigerator|familyhub|family hub/i.test(s))
    return "refrigerator";

  if (/(oculusbrowser|vision pro|visionos|vive|valve index|windows mixed reality|pico|vr|xr|x4000)/i.test(s))
    return "vr";

  if (/(playstation|ps[1-5]|xbox|nintendo)/i.test(s))
    return "console";

  if (/(watchos|apple watch|wear os|wearos|galaxy watch|tizen watch|smartwatch)/i.test(s))
    return "watch";

  if (/(smart-?tv|googletv|apple tv|tv safari|androidtv|crkey|roku|aft[a-z]|netcast|web0s|webos|tizen|hbbtv|bravia|viera)/i.test(s))
    return "tv";

  if ((/(ipad|tablet|playbook|portalgo)/i.test(s) || (/android/i.test(s) && !/mobile/i.test(s))) &&
    !E_READER_RE.test(s)
  ) return "tablet";

  // kindle fire models: kfot, kftt, kfsowi, kfjwa, kfjwi, kfthwa, kfthwi, kfapwa, kfapwi
  if (E_READER_RE.test(s)) 
    return "ereader";

  if (/(android automotive|androidauto|carplay|tesla|mbux|sync|qtcarbrowser)/i.test(s))
    return "car";

  if (/(blackberry|bb10|nokia)/i.test(s) && !/android/i.test(s))
    return "qwerty";

  if (/(mobi|iphone|ipod|android|blackberry|bb10|nokia|iemobile|opera mini|windows phone)/i.test(s))
    return "mobile";

  if (/(windows|macintosh|mac os|linux|cros|x11)/i.test(s))
    return "desktop";

  // lowest priority

  return "unknown";
}

// io is accessed through state so it is available after server.js init
function io() {
  return state.io;
}

// ── Talkoboard: Server-Side Stroke Storage (ephemeral) ──────────────────────

const boardState = new Map(); // roomId → { strokes: [], active: Map<userId, stroke> }
const MAX_BOARD_STROKES = 2000;
const MAX_POINTS_PER_STROKE = 5000;

function getBoardState(roomId) {
  if (!boardState.has(roomId)) {
    boardState.set(roomId, { strokes: [], active: new Map() });
  }
  return boardState.get(roomId);
}

function cleanupBoardState(roomId) {
  boardState.delete(roomId);
}

function finalizeBoardUserStroke(roomId, userId) {
  const bs = boardState.get(roomId);
  if (!bs) return;
  const active = bs.active.get(userId);
  if (active && active.points && active.points.length > 0) {
    bs.strokes.push(active);
    if (bs.strokes.length > MAX_BOARD_STROKES) {
      bs.strokes = bs.strokes.slice(-MAX_BOARD_STROKES);
    }
    saveBoardSoon();
  }
  bs.active.delete(userId);
}

// Validate a gradient-brush spec from the client: 2-8 hex color stops, else
// null (a plain solid-color stroke). Trusts nothing about it but the shape.
function sanitizeGradient(g) {
  if (!Array.isArray(g)) return null;
  const out = [];
  for (const c of g) {
    if (typeof c === "string" && /^#[0-9a-fA-F]{3,6}$/.test(c))
      out.push(c.slice(0, 7));
    if (out.length >= 8) break;
  }
  return out.length >= 2 ? out : null;
}

// ── Talkoboard persistence ──────────────────────────────────────────────────
// The board lives in memory; persist each room's FINALIZED strokes (not the
// in-progress ones) to disk so a restart or redeploy keeps the drawing instead
// of wiping it. Mirrors the room save: atomic tmp+rename, debounced during
// normal use, with a synchronous flush on a clean shutdown.
const BOARD_PATH = path.join(DATA_DIR, "board.json");
let boardSavePending = false;

function serializeBoards() {
  const out = {};
  for (const [roomId, bs] of boardState) {
    if (bs && Array.isArray(bs.strokes) && bs.strokes.length) {
      out[roomId] = bs.strokes;
    }
  }
  return out;
}

async function saveBoard() {
  try {
    const tmp = BOARD_PATH + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(serializeBoards()), "utf8");
    await fs.rename(tmp, BOARD_PATH);
  } catch (e) {
    console.error("Error saving board:", e);
  }
}

// Debounced save, so a burst of strokes writes once rather than per stroke.
function saveBoardSoon() {
  if (boardSavePending) return;
  boardSavePending = true;
  setTimeout(() => {
    boardSavePending = false;
    saveBoard().catch(() => {});
  }, 10000);
}

// Synchronous flush for a clean shutdown (mirrors the other stores), so strokes
// drawn seconds before a restart are not lost in the debounce window.
function saveBoardSync() {
  try {
    const fsSync = require("fs");
    const tmp = BOARD_PATH + ".tmp";
    fsSync.writeFileSync(tmp, JSON.stringify(serializeBoards()), "utf8");
    fsSync.renameSync(tmp, BOARD_PATH);
  } catch (e) {
    console.error("Board flush failed:", e);
  }
}

// Restore saved strokes on boot, only for rooms that still exist (so a deleted
// room's board does not linger). Must run AFTER loadRooms().
function loadBoard() {
  try {
    const raw = require("fs").readFileSync(BOARD_PATH, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return;
    let n = 0;
    for (const [roomId, strokes] of Object.entries(obj)) {
      if (!state.rooms.has(roomId) || !Array.isArray(strokes)) continue;
      boardState.set(roomId, {
        strokes: strokes.slice(-MAX_BOARD_STROKES),
        active: new Map(),
      });
      n++;
    }
    if (n) console.log(`Loaded board strokes for ${n} room(s).`);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Error loading board:", err);
  }
}

// ── Multiplayer Piano: Server-Side Room State (ephemeral) ───────────────────
// One shared 88-key piano per room. We keep only presence/ownership/moderation
// here - individual notes are relayed live and never stored. Mirrors the board:
// trust nothing from the client, validate every action by the session userId.

const pianoState = new Map(); // roomId → { crown, onlyOwner, muted:Set, open:Set }

// Per-message / per-second flood caps. A human chord is a handful of events in a
// flush window; anything past these is black-MIDI spam and gets dropped.
const PIANO_MIN_KEY = 0;
const PIANO_MAX_KEY = 87;
const PIANO_MAX_NOTES_PER_MSG = 32; // note-ons relayed per message (offs uncapped)
const PIANO_MAX_NOTES_PER_SEC = 200; // note-ons relayed per second per player
const PIANO_MAX_MSGS_PER_SEC = 30;

function getPianoState(roomId) {
  if (!pianoState.has(roomId)) {
    pianoState.set(roomId, {
      crown: null,
      onlyOwner: false,
      muted: new Set(),
      open: new Set(),
    });
  }
  return pianoState.get(roomId);
}

function cleanupPianoState(roomId) {
  pianoState.delete(roomId);
}

// Public crown/lock snapshot for clients (resolves the holder's name).
function pianoMeta(roomId) {
  const ps = pianoState.get(roomId);
  if (!ps) return { crown: null, crownName: null, onlyOwner: false };
  let crownName = null;
  if (ps.crown) {
    const room = state.rooms.get(roomId);
    const u = room && room.users.find((x) => x.id === ps.crown);
    crownName = u ? u.username : null;
  }
  return { crown: ps.crown, crownName, onlyOwner: ps.onlyOwner };
}

// Drop a user's piano presence (modal close, leave, disconnect, ghost). Frees a
// stuck "only owner" lock if the crown holder vanishes. Mute only clears on a
// full room exit so a troll can't reopen the panel to unmute themselves.
function pianoDropPresence(roomId, userId, clearMute) {
  const ps = pianoState.get(roomId);
  if (!ps) return;
  if (clearMute) ps.muted.delete(userId);
  const wasOpen = ps.open.delete(userId);
  let crownChanged = false;
  if (ps.crown === userId) {
    ps.crown = null;
    ps.onlyOwner = false;
    crownChanged = true;
  }
  if (!io()) return;
  if (wasOpen) {
    // Hide a vanished dev's departure from non-devs, the same way their arrival
    // and activity are hidden.
    const room = state.rooms.get(roomId);
    const u = room && room.users.find((x) => x.id === userId);
    const hide = !!(u && u.isDev && u.isVanished);
    emitToRoomMaybeHidden(roomId, hide, "piano user status", {
      userId,
      open: false,
    });
  }
  if (crownChanged) emitPianoCrown(roomId);
}

// ── User Counting ───────────────────────────────────────────────────────────

function getUserRoomsCount(userId) {
  for (const [, room] of state.rooms) {
    if (room.users && room.users.some((u) => u.id === userId)) return 1;
  }
  return 0;
}

// Counts whether this username/location is ALREADY occupying a room, used to
// enforce one identity per room. Ignores:
//   • the caller's own userId (so re-joining across the lobby→room navigation,
//     where a brief duplicate entry exists, never blocks them), and
//   • ghosts - matching entries whose socket is already gone (a stale session
//     the server hasn't cleaned yet). Without this, a disconnected ghost with
//     the same name would block the real user even after clearing cookies.
function getUsernameLocationRoomsCount(username, location, excludeUserId) {
  const uLow = normalize(username);
  const lLow = normalize(location);
  for (const [, room] of state.rooms) {
    if (!room.users) continue;
    for (const u of room.users) {
      if (excludeUserId && u.id === excludeUserId) continue;
      if (normalize(u.username) === uLow && normalize(u.location) === lLow) {
        if (findSocketByUserId(u.id)) return 1; // only a LIVE duplicate blocks
      }
    }
  }
  return 0;
}

function getUserCurrentRoom(userId) {
  for (const [roomId, room] of state.rooms) {
    if (room.users && room.users.some((u) => u.id === userId)) return roomId;
  }
  return null;
}

// ── Anti-Spam: Per-IP Room Counting ─────────────────────────────────────────

function getRoomCountByIP(clientIp) {
  if (!io() || !clientIp) return 0;
  const roomIds = new Set();
  for (const [, s] of io().sockets.sockets) {
    if (s.clientIp === clientIp && s.roomId) {
      roomIds.add(s.roomId);
    }
  }
  return roomIds.size;
}

// ── Anti-Spam: Pressure System ──────────────────────────────────────────────
// Solo rooms get a shorter time-to-live as the total room count rises.

function getSoloRoomTTL() {
  const totalRooms = state.rooms.size;
  const tiers = CONFIG.LIMITS.PRESSURE_TIERS;
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (totalRooms >= tiers[i].threshold) return tiers[i].ttl;
  }
  return tiers[0].ttl;
}

function isHealthyRoom(room) {
  if (room.users && room.users.length >= 2) return true;
  const age = Date.now() - (room.createdAt || room.lastActiveTime || 0);
  return age < CONFIG.LIMITS.HEALTHY_ROOM_AGE_MS;
}

function getHealthyRoomCount() {
  let count = 0;
  for (const [, room] of state.rooms) {
    if (isHealthyRoom(room)) count++;
  }
  return count;
}

async function pressureCleanup() {
  const now = Date.now();
  const ttl = getSoloRoomTTL();
  const toDelete = [];

  for (const [roomId, room] of state.rooms) {
    if (roomId === MAIN_ROOM_ID) continue;
    if (room.users && room.users.length >= 2) continue;
    if (room.users && room.users.length === 1) {
      const soloSince = state.roomSoloSince.get(roomId);
      if (soloSince && now - soloSince >= ttl) {
        // Staff and bots are exempt: a dev, mod, or bot can hold a room open
        // indefinitely, the same way staff bypass AFK and capacity. Never
        // solo-close on them.
        const soloSocket = findSocketByUserId(room.users[0].id, roomId);
        if (soloSocket && (soloSocket.isDev || soloSocket.isMod || soloSocket.isBot))
          continue;
        toDelete.push(roomId);
      }
    } else if (!room.users || room.users.length === 0) {
      if (now - room.lastActiveTime > CONFIG.TIMING.ROOM_DELETION_TIMEOUT) {
        toDelete.push(roomId);
      }
    }
  }

  if (toDelete.length === 0) return;

  for (const roomId of toDelete) {
    const room = state.rooms.get(roomId);
    if (!room) continue;

    if (room.users && room.users.length === 1) {
      const soloUser = room.users[0];
      const soloSocket = findSocketByUserId(soloUser.id, roomId);
      if (soloSocket) {
        soloSocket.emit("afk timeout", {
          message:
            "Your room was closed due to extended single-occupancy. " +
            "You can create a new room anytime.",
          redirectTo: "/",
        });
        await leaveRoom(soloSocket, soloUser.id);
      }
    }

    state.rooms.delete(roomId);
    state.roomSoloSince.delete(roomId);
    state.roomLastChatActivity.delete(roomId);
    cleanupBoardState(roomId);
    if (state.roomDeletionTimers.has(roomId)) {
      clearTimeout(state.roomDeletionTimers.get(roomId));
      state.roomDeletionTimers.delete(roomId);
    }
  }

  updateLobby();
  await debouncedSaveRooms();
  const currentTTL = Math.round(ttl / 1000);
  console.log(
    `[PRESSURE] Cleaned ${toDelete.length} solo room(s) | ` +
    `Total: ${state.rooms.size} | TTL: ${currentTTL}s`,
  );
}

function updateRoomSoloTracking(roomId) {
  const room = state.rooms.get(roomId);
  if (!room) {
    state.roomSoloSince.delete(roomId);
    return;
  }
  if (room.users && room.users.length === 1) {
    if (!state.roomSoloSince.has(roomId)) {
      state.roomSoloSince.set(roomId, Date.now());
    }
  } else {
    state.roomSoloSince.delete(roomId);
  }
}

function findSocketByUserId(userId, roomId) {
  if (!io()) return null;
  for (const [, s] of io().sockets.sockets) {
    if (
      s.handshake?.session?.userId === userId &&
      (!roomId || s.roomId === roomId)
    ) {
      return s;
    }
  }
  return null;
}

function findSocketsByUserId(userId) {
  const result = [];
  if (!io() || !userId) return result;
  for (const [, s] of io().sockets.sockets) {
    if (s.handshake?.session?.userId === userId) result.push(s);
  }
  return result;
}

// ── Room Utilities ──────────────────────────────────────────────────────────

function calculateCurrentRoomLimit() {
  if (!CONFIG.FEATURES.ENABLE_DYNAMIC_SCALING)
    return CONFIG.LIMITS.BASE_MAX_ROOMS;
  const total = getTotalUserCount();
  const perCycle =
    CONFIG.LIMITS.BASE_MAX_ROOMS * CONFIG.LIMITS.MAX_ROOM_CAPACITY;
  const cycles = Math.floor(total / perCycle);
  return Math.max(
    CONFIG.LIMITS.BASE_MAX_ROOMS +
    cycles * CONFIG.LIMITS.ROOM_SCALING_INCREMENT,
    CONFIG.LIMITS.BASE_MAX_ROOMS,
  );
}

function getTotalUserCount() {
  let total = 0;
  for (const [, room] of state.rooms) {
    if (room.users) total += room.users.length;
  }
  return total;
}

function roomNameExists(name) {
  const n = normalize(name);
  for (const [, room] of state.rooms) {
    if (normalize(room.name) === n) return true;
  }
  return false;
}

function getRoomStatistics() {
  const totalRooms = state.rooms.size;
  const currentLimit = calculateCurrentRoomLimit();
  const healthyRooms = getHealthyRoomCount();
  const types = { public: 0, "semi-private": 0, private: 0 };
  let roomsWithUsers = 0;
  let soloRooms = 0;
  let totalUsers = 0;

  for (const [, room] of state.rooms) {
    if (types[room.type] !== undefined) types[room.type]++;
    // Count only visible users for public stats
    const visibleUsers = (room.users || []).filter(
      (u) => !(u.isDev && u.isVanished),
    );
    totalUsers += visibleUsers.length;
    if (visibleUsers.length > 0) roomsWithUsers++;
    if (visibleUsers.length === 1) soloRooms++;
  }

  return {
    totalRooms,
    totalUsers,
    currentLimit,
    healthyRooms,
    soloRooms,
    roomsWithUsers,
    emptyRooms: totalRooms - roomsWithUsers,
    roomTypes: types,
    currentSoloTTL: Math.round(getSoloRoomTTL() / 1000),
    hardCap: CONFIG.LIMITS.HARD_MAX_ROOMS,
    utilizationPercentage:
      totalRooms > 0
        ? Math.round(
          (totalUsers / (totalRooms * CONFIG.LIMITS.MAX_ROOM_CAPACITY)) * 100,
        )
        : 0,
  };
}

function generateRoomId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getCurrentMessages(usersInRoom) {
  const msgs = {};
  if (Array.isArray(usersInRoom)) {
    usersInRoom.forEach((u) => {
      msgs[u.id] = state.userMessageBuffers.get(u.id) || "";
    });
  }
  return msgs;
}

// ── Dev Mode: Visibility Helpers (vanish / hide) ────────────────────────────

// Vanished devs do not count toward room capacity
function getJoinableUserCount(room) {
  return (room?.users || []).filter((u) => !(u.isDev && u.isVanished)).length;
}

function getRecipientUserId(socket) {
  return socket?.handshake?.session?.userId || null;
}

// Vanished devs are only visible to themselves and other devs.
// Hidden devs are visible to everyone but without flair.
function canRecipientSeeDevUser(recipientSocket, user) {
  if (!user) return false;
  if (!user.isDev) return true;
  if (!user.isVanished) return true;
  const recipientUserId = getRecipientUserId(recipientSocket);
  if (recipientUserId && recipientUserId === user.id) return true;
  if (recipientSocket?.isDev) return true;
  return false;
}

// Formats one user for one recipient. Returns null if not visible.
// Hidden devs are stripped of all dev flair.
function formatUserForSocket(user, recipientSocket) {
  if (!user) return null;

  if (!canRecipientSeeDevUser(recipientSocket, user)) return null;

  const formatted = {
    id: user.id,
    username: user.username,
    location: user.location,
    deviceType: user.deviceType || "unknown",
  };
  // Discord avatar: validated snowflake id + CDN hash only; clients rebuild
  // the cdn.discordapp.com URL themselves.
  if (user.avatar) formatted.avatar = user.avatar;

  // Hidden staff render as plain users to everyone EXCEPT a dev recipient: a
  // dev always needs to know who is staff, so a hidden (or vanished) dev/mod
  // keeps their role when seen by a dev, with isHidden/isVanished markers so the
  // dev can tell they are concealed from normal users.
  const recipientIsDev = !!recipientSocket?.isDev;
  if (user.isHidden && !recipientIsDev) {
    return formatted;
  }


  if (user.isDev) {
    formatted.isDev = true;
    // Keep the loud color off the concealed view - the crown + marker is enough
    // for a dev to identify them without making them look fully public.
    if (user.devColor && !user.isHidden) formatted.devColor = user.devColor;
    if (user.isVanished) formatted.isVanished = true;
    if (user.isHidden) formatted.isHidden = true;
  } else if (user.isMod) {
    // Mod badge is distinct from the dev crown; mods are never vanished.
    formatted.isMod = true;
    formatted.modLevel = user.modLevel || 2;
    if (user.isHidden) formatted.isHidden = true;
  }

  return formatted;
}

function filterUsersForSocket(users, recipientSocket) {
  return (users || [])
    .map((user) => formatUserForSocket(user, recipientSocket))
    .filter(Boolean);
}

// The "spectate joined" payload, filtered for this recipient. A non-staff
// spectator's socket has isDev/isMod false, so the filters strip vanished devs
// and staff flair for free.
function spectatePayload(socket, room) {
  const createdAt = room.createdAt || room.lastActiveTime || 0;
  return {
    roomId: room.id,
    roomName: room.name,
    roomType: room.type,
    layout: room.layout,
    isDev: !!socket.isDev,
    isMod: !!socket.isMod,
    modLevel: socket.isMod ? socket.modLevel || 2 : 0,
    locked: !!room.locked,
    slowMode: !!room.slowMode,
    spotlight: !!room.spotlight,
    users: filterUsersForSocket(room.users || [], socket),
    votes: filterVotesForSocket(room, socket),
    muteVotes: filterMuteVotesForSocket(room, socket),
    mutedBotIds: Array.from(room.mutedBotIds || []),
    currentMessages: filterCurrentMessagesForSocket(room, socket),
    createdAt: createdAt,
    uptime: Date.now() - createdAt,
  };
}

// Votes involving invisible (vanished) users are hidden from non-devs
function filterVotesForSocket(room, recipientSocket) {
  const votes = room?.votes || {};
  const roomUsers = room?.users || [];
  const byId = new Map(roomUsers.map((u) => [u.id, u]));
  const filtered = {};

  for (const [voterId, targetId] of Object.entries(votes)) {
    const voter = byId.get(voterId);
    const target = byId.get(targetId);
    if (!voter || !target) continue;
    if (!canRecipientSeeDevUser(recipientSocket, voter)) continue;
    if (!canRecipientSeeDevUser(recipientSocket, target)) continue;
    filtered[voterId] = targetId;
  }
  return filtered;
}

// Bot-mute votes involving invisible (vanished) voters are hidden from non-devs
function filterMuteVotesForSocket(room, recipientSocket) {
  const muteVotes = room?.muteVotes || {};
  const roomUsers = room?.users || [];
  const byId = new Map(roomUsers.map((u) => [u.id, u]));
  const filtered = {};

  for (const [voterId, targetId] of Object.entries(muteVotes)) {
    const voter = byId.get(voterId);
    const target = byId.get(targetId);
    if (!voter || !target) continue;
    if (!canRecipientSeeDevUser(recipientSocket, voter)) continue;
    if (!canRecipientSeeDevUser(recipientSocket, target)) continue;
    filtered[voterId] = targetId;
  }
  return filtered;
}

function filterCurrentMessagesForSocket(room, recipientSocket) {
  const messages = {};
  for (const user of room?.users || []) {
    if (!canRecipientSeeDevUser(recipientSocket, user)) continue;
    messages[user.id] = state.userMessageBuffers.get(user.id) || "";
  }
  return messages;
}

// Lobby-list view of a room, tailored to one recipient
function formatRoomForSocket(room, recipientSocket) {
  const users = filterUsersForSocket(room.users || [], recipientSocket);
  const joinableCount = getJoinableUserCount(room);

  const createdAt = room.createdAt || room.lastActiveTime || 0;
  return {
    id: room.id,
    name: room.name,
    type: room.type,
    layout: room.layout,
    createdAt: createdAt,
    uptime: Date.now() - createdAt,
    isFull: joinableCount >= roomCapacity(room),
    userCount: joinableCount,
    visibleUserCount: users.length,
    lastChatActivity: state.roomLastChatActivity.get(room.id) || 0,
    spotlight: !!room.spotlight,
    locked: !!room.locked,
    capacity: roomCapacity(room),
    users,
  };
}

// Full in-room state, tailored to one recipient
function formatRoomStateForSocket(room, recipientSocket) {
  const users = filterUsersForSocket(room.users || [], recipientSocket);
  const joinableCount = getJoinableUserCount(room);

  const createdAt = room.createdAt || room.lastActiveTime || 0;
  return {
    id: room.id,
    name: room.name,
    type: room.type,
    layout: room.layout,
    createdAt: createdAt,
    uptime: Date.now() - createdAt,
    users,
    votes: filterVotesForSocket(room, recipientSocket),
    muteVotes: filterMuteVotesForSocket(room, recipientSocket),
    mutedBotIds: Array.from(room.mutedBotIds || []),
    currentMessages: filterCurrentMessagesForSocket(room, recipientSocket),
    isFull: joinableCount >= roomCapacity(room),
    userCount: joinableCount,
    visibleUserCount: users.length,
    capacity: roomCapacity(room),
    locked: !!room.locked,
    slowMode: !!room.slowMode,
    spotlight: !!room.spotlight,
  };
}

// ── Per-Socket Emission Helpers (visibility-aware) ──────────────────────────

function emitRoomSnapshot(roomId) {
  if (!io()) return;
  const room = state.rooms.get(roomId);
  if (!room) return;
  for (const [, socket] of io().sockets.sockets) {
    if (!socket.connected || socket.roomId !== roomId) continue;
    socket.emit("room update", formatRoomStateForSocket(room, socket));
  }
}

function emitLobbySnapshot() {
  if (!io()) return;
  const rooms = Array.from(state.rooms.values()).filter(
    (r) => r.type !== "private",
  );
  for (const [, socket] of io().sockets.sockets) {
    if (!socket.connected || !socket.rooms?.has("lobby")) continue;
    const data = rooms.map((room) => formatRoomForSocket(room, socket));
    socket.emit("lobby update", data);
  }
}

function emitRoomVoteUpdates(roomId) {
  if (!io()) return;
  const room = state.rooms.get(roomId);
  if (!room) return;
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== roomId) continue;
    recipient.emit("update votes", filterVotesForSocket(room, recipient));
  }
}

function emitRoomMuteVoteUpdates(roomId) {
  if (!io()) return;
  const room = state.rooms.get(roomId);
  if (!room) return;
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== roomId) continue;
    recipient.emit("update mute votes", {
      muteVotes: filterMuteVotesForSocket(room, recipient),
      mutedBotIds: Array.from(room.mutedBotIds || []),
    });
  }
}

// Recomputes whether a bot should be muted from the current vote tally and
// applies any state transition: blanking its live panel for everyone and
// signaling its own socket (so a cooperative bot script can pause itself),
// symmetrically in both directions since a mute vote is reversible.
function recomputeBotMuteState(room, targetUserId) {
  if (!room.mutedBotIds) room.mutedBotIds = new Set();
  const votesFor = Object.values(room.muteVotes || {}).filter(
    (v) => v === targetUserId,
  ).length;
  const isMuted = votesFor > Math.floor(room.users.length / 2);
  const wasMuted = room.mutedBotIds.has(targetUserId);
  if (isMuted === wasMuted) return;

  const targetSocket = findSocketByUserId(targetUserId, room.id);
  if (isMuted) {
    room.mutedBotIds.add(targetUserId);
    const target = room.users.find((u) => u.id === targetUserId);
    state.userMessageBuffers.set(targetUserId, "");
    if (io()) {
      for (const [, recipient] of io().sockets.sockets) {
        if (!recipient.connected || recipient.roomId !== room.id) continue;
        recipient.emit("chat update", {
          userId: targetUserId,
          username: target?.username,
          diff: { type: "full-replace", text: "" },
        });
      }
    }
    targetSocket?.emit("bot muted", { muted: true });
  } else {
    room.mutedBotIds.delete(targetUserId);
    targetSocket?.emit("bot muted", { muted: false });
  }
}

function emitRoomUserLeft(roomId, userId, leftUser) {
  if (!io()) return;
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== roomId) continue;
    if (!canRecipientSeeDevUser(recipient, leftUser)) continue;
    recipient.emit("user left", userId);
  }
}

function emitRoomUserJoined(room, joinedUser) {
  if (!io()) return;
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== room.id) continue;
    // The joining user gets "room joined" instead
    const recipientUserId = getRecipientUserId(recipient);
    if (recipientUserId === joinedUser.id) continue;
    if (!canRecipientSeeDevUser(recipient, joinedUser)) continue;
    const visibleUser = formatUserForSocket(joinedUser, recipient);
    if (!visibleUser) continue;
    recipient.emit("user joined", {
      ...visibleUser,
      roomName: room.name,
      roomType: room.type,
    });
  }
}

function emitRoomTyping(socket, userId, username, isTyping) {
  if (!socket.roomId || !io()) return;
  const room = state.rooms.get(socket.roomId);
  if (!room) return;
  const senderUser = room.users?.find((u) => u.id === userId);
  for (const [, recipient] of io().sockets.sockets) {
    if (
      !recipient.connected ||
      recipient.roomId !== socket.roomId ||
      recipient.id === socket.id
    )
      continue;
    if (!canRecipientSeeDevUser(recipient, senderUser)) continue;
    recipient.emit("user typing", { userId, username, isTyping });
  }
}

function emitRoomChatUpdate(socket, payload) {
  if (!socket.roomId || !io()) return;
  const room = state.rooms.get(socket.roomId);
  if (!room) return;
  const senderUser = room.users?.find((u) => u.id === payload.userId);
  for (const [, recipient] of io().sockets.sockets) {
    if (
      !recipient.connected ||
      recipient.roomId !== socket.roomId ||
      recipient.id === socket.id
    )
      continue;
    if (!canRecipientSeeDevUser(recipient, senderUser)) continue;
    recipient.emit("chat update", payload);
  }
}

// ── Sub-app (Piano / Talkoboard) broadcast helpers, vanish-aware ────────────
// The piano and the board relay presence and activity straight to the room.
// Left raw, those streams reveal a vanished dev to ANY client reading the
// socket - including an unofficial one - even though room chat and typing
// already hide them. These helpers carry the same visibility rule into the live
// sub-apps: a vanished dev's events reach only other devs (and, when asked,
// themselves), so an invisible admin never surfaces through the piano or board.
// The common case (sender not vanished) keeps the fast native broadcast.
function emitSubAppEvent(socket, event, payload, includeSender) {
  const roomId = socket.roomId;
  if (!roomId || !io()) return;
  if (!socket.isVanished) {
    if (includeSender) io().to(roomId).emit(event, payload);
    else socket.to(roomId).emit(event, payload);
    return;
  }
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== roomId) continue;
    if (recipient.id === socket.id) {
      if (includeSender) recipient.emit(event, payload);
      continue;
    }
    if (recipient.isDev) recipient.emit(event, payload);
  }
}

// Room-scoped emit for a presence drop with no originating socket (close,
// disconnect, ghost cleanup). `hide` keeps a vanished dev's departure from
// reaching non-devs, mirroring emitSubAppEvent.
function emitToRoomMaybeHidden(roomId, hide, event, payload) {
  if (!io() || !roomId) return;
  if (!hide) {
    io().to(roomId).emit(event, payload);
    return;
  }
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== roomId) continue;
    if (recipient.isDev) recipient.emit(event, payload);
  }
}

// Crown snapshot for one recipient. A vanished dev holding the crown reads as
// "no crown" to anyone who cannot see them, so the holder (and any lock they
// set) never leaks through the crown broadcast.
function pianoMetaFor(roomId, recipient) {
  const ps = pianoState.get(roomId);
  if (!ps) return { crown: null, crownName: null, onlyOwner: false };
  if (ps.crown) {
    const room = state.rooms.get(roomId);
    const holder = room && room.users.find((u) => u.id === ps.crown);
    if (holder && !canRecipientSeeDevUser(recipient, holder))
      return { crown: null, crownName: null, onlyOwner: false };
  }
  return pianoMeta(roomId);
}

// Per-recipient crown broadcast so the redaction above reaches every viewer.
function emitPianoCrown(roomId) {
  if (!io()) return;
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== roomId) continue;
    recipient.emit("piano crown", pianoMetaFor(roomId, recipient));
  }
}

// ── Dev Mode: Room / Lobby Context ──────────────────────────────────────────

function getDevRoomContext(roomId) {
  if (!io()) return {};
  const ctx = {};
  const room = state.rooms.get(roomId);
  const roomUsers = new Map((room?.users || []).map((u) => [u.id, u]));
  for (const [, s] of io().sockets.sockets) {
    if (s.roomId !== roomId || !s.handshake?.session?.userId) continue;
    const userId = s.handshake.session.userId;
    const roomUser = roomUsers.get(userId);
    if (roomUser?.isHidden) continue;
    ctx[userId] = { d: s.clientIp || "unknown" };
  }
  return ctx;
}

// IP overlay is dev-only for safety: mods can still kick / ban / IP-block a
// user (the server resolves the IP for them) but never SEE raw IP addresses.
function sendDevRoomContext(roomId) {
  if (!io()) return;
  const ctx = getDevRoomContext(roomId);
  for (const [, s] of io().sockets.sockets) {
    if (s.isDev && s.roomId === roomId) {
      s.emit("dev context", ctx);
    }
  }
}

// Devs idle in the lobby receive semi-private access codes
function sendDevLobbyContext() {
  if (!io()) return;
  const devSockets = [];
  for (const [, s] of io().sockets.sockets) {
    if (s.isDev && !s.roomId) devSockets.push(s);
  }
  if (devSockets.length === 0) return;

  const data = {};
  for (const [roomId, room] of state.rooms) {
    if (room.type === "semi-private" && room.accessCode) {
      data[roomId] = room.accessCode;
    }
  }
  for (const s of devSockets) {
    s.emit("dev lobby context", data);
  }
}

// ── Room Save / Load ────────────────────────────────────────────────────────

async function saveRooms(force = false) {
  const now = Date.now();
  // The throttle keeps routine saves cheap; a forced save (clean shutdown)
  // bypasses it so the very latest room state survives the restart.
  if (!force && now - state.lastSaveTimestamp < state.SAVE_INTERVAL_MIN) return;
  try {
    const data = Array.from(state.rooms.entries()).map(([id, room]) => {
      return [
        id,
        {
          ...room,
          users: (room.users || []).map((u) => {
            const clean = { ...u };
            delete clean.isVanished; // ephemeral, never persisted
            return clean;
          }),
          bannedUserIds: Array.from(room.bannedUserIds || []),
        },
      ];
    });
    const tmp = path.join(DATA_DIR, "rooms.json.tmp");
    const final = path.join(DATA_DIR, "rooms.json");
    await fs.writeFile(tmp, JSON.stringify(data), "utf8");
    await fs.rename(tmp, final);
    state.lastSaveTimestamp = now;
    console.log("Rooms saved successfully.");
  } catch (err) {
    console.error("Error saving rooms:", err);
    try {
      await fs.unlink(path.join(DATA_DIR, "rooms.json.tmp"));
    } catch (_) { }
  }
}

const debouncedSaveRooms = async () => {
  if (state.saveRoomsPending) return;
  state.saveRoomsPending = true;
  setTimeout(async () => {
    try {
      await saveRooms();
    } catch (e) {
      console.error("Debounced save error:", e);
    } finally {
      state.saveRoomsPending = false;
    }
  }, 10000);
};

async function loadRooms() {
  if (!CONFIG.FEATURES.LOAD_ROOMS_ON_STARTUP) {
    console.log("Starting with empty rooms (room loading disabled)");
    state.rooms = new Map();
    return;
  }
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, "rooms.json"), "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      state.rooms = new Map();
      return;
    }

    state.rooms = new Map(
      arr.map((item) => {
        if (item[1]) {
          if (item[1].users && item[1].users.length > 0) {
            console.log(
              `Clearing ${item[1].users.length} stale user(s) from room: ${item[1].name || item[0]}`,
            );
          }
          item[1].users = [];
          item[1].lastActiveTime = Date.now();
          item[1].bannedUserIds = new Set(
            Array.isArray(item[1].bannedUserIds)
              ? item[1].bannedUserIds
              : typeof item[1].bannedUserIds === "object"
                ? Object.values(item[1].bannedUserIds)
                : [],
          );
        }
        return item;
      }),
    );
    console.log(`Loaded ${state.rooms.size} rooms from disk (users cleared).`);
    for (const [roomId] of state.rooms) {
      startRoomDeletionTimer(roomId);
    }
  } catch (err) {
    if (err.code === "ENOENT")
      console.log("rooms.json not found. Starting fresh.");
    else console.error("Error loading rooms:", err);
    state.rooms = new Map();
  }
}

// ── Main Room ────────────────────────────────────────────────────────────────
// One fixed, always-there room. There is no lobby/room-list UI any more - the
// client signs in and goes straight here - so it must exist before anyone can
// join it, and never expire the way an ordinary empty room would.

// Six characters: joinRoom() rejects any roomId whose length isn't 6, matching
// the format generateRoomId() produces. "000001" can never collide with a
// generated id (those never carry a leading zero).
const MAIN_ROOM_ID = "000001";

function ensureMainRoom() {
  if (state.rooms.has(MAIN_ROOM_ID)) return;
  const now = Date.now();
  state.rooms.set(MAIN_ROOM_ID, {
    id: MAIN_ROOM_ID,
    name: "Talkomatic",
    type: "public",
    layout: "horizontal",
    users: [],
    accessCode: null,
    votes: {},
    muteVotes: {},
    mutedBotIds: new Set(),
    bannedUserIds: new Set(),
    lastActiveTime: now,
    createdAt: now,
  });
}

// ── Room Timers ─────────────────────────────────────────────────────────────

function startRoomDeletionTimer(roomId) {
  if (roomId === MAIN_ROOM_ID) return;
  if (state.roomDeletionTimers.has(roomId)) {
    clearTimeout(state.roomDeletionTimers.get(roomId));
  }
  const timer = setTimeout(async () => {
    const room = state.rooms.get(roomId);
    if (room && room.users.length === 0) {
      state.rooms.delete(roomId);
      state.roomDeletionTimers.delete(roomId);
      state.roomSoloSince.delete(roomId);
      state.roomLastChatActivity.delete(roomId);
      cleanupBoardState(roomId);
      updateLobby();
      await debouncedSaveRooms();
      console.log(`Room ${roomId} deleted (empty timeout).`);
    }
  }, CONFIG.TIMING.ROOM_DELETION_TIMEOUT);
  state.roomDeletionTimers.set(roomId, timer);
}

// ── Lobby / Room Broadcasts ─────────────────────────────────────────────────

function updateLobby() {
  if (!io()) return;
  try {
    state.apiCache.delete("socket_rooms_dev");
    state.apiCache.delete("socket_rooms_normal");
    emitLobbySnapshot();
    sendDevLobbyContext();
  } catch (err) {
    console.error("updateLobby error:", err);
  }
}

function updateRoom(roomId) {
  if (!io()) return;
  const room = state.rooms.get(roomId);
  if (room) {
    emitRoomSnapshot(roomId);
  }
}

// ── AFK ─────────────────────────────────────────────────────────────────────

function clearAFKTimers(userId) {
  if (state.afkWarningTimers.has(userId)) {
    clearTimeout(state.afkWarningTimers.get(userId));
    state.afkWarningTimers.delete(userId);
  }
  if (state.afkTimers.has(userId)) {
    clearTimeout(state.afkTimers.get(userId));
    state.afkTimers.delete(userId);
  }
}

function setupAFKTimers(socket, userId) {
  clearAFKTimers(userId);
  if (!socket || !socket.roomId) return;
  if (socket.isDev || socket.isMod || socket.isBot) return; // staff and bots bypass AFK
  if (socket.boardOpen) return; // drawing on the board counts as active
  if (socket.pianoOpen) return; // playing the piano counts as active

  state.afkWarningTimers.set(
    userId,
    setTimeout(() => {
      if (socket.connected)
        socket.emit("afk warning", {
          message: "You have been inactive.",
          secondsRemaining: 30,
        });
    }, CONFIG.TIMING.AFK_WARNING_TIME),
  );
  state.afkTimers.set(
    userId,
    setTimeout(
      () => handleAFKTimeout(socket, userId),
      CONFIG.LIMITS.MAX_AFK_TIME,
    ),
  );
}

async function handleAFKTimeout(socket, userId) {
  if (!socket || !socket.roomId) return;
  console.log(`AFK timeout: ${userId} in room ${socket.roomId}`);
  socket.emit("afk timeout", {
    message: "Removed from room due to inactivity.",
    redirectTo: "/",
  });
  await leaveRoom(socket, userId);
  clearAFKTimers(userId);
}

// ── Chat Processing ─────────────────────────────────────────────────────────

function checkChatCircuit() {
  const now = Date.now();
  const cs = state.chatCircuitState;
  if (cs.isOpen && now - cs.lastFailure > cs.resetTimeout) {
    cs.isOpen = false;
    cs.failures = 0;
  }
  if (!cs.isOpen && cs.failures > cs.threshold) {
    cs.isOpen = true;
    cs.lastFailure = now;
    console.warn("Chat circuit breaker opened");
  }
  return !cs.isOpen;
}

// Slow mode lengthens the broadcast cadence for a room: keystrokes are still
// captured, the room just sees full-replace updates less often.
function getBatchInterval(roomId) {
  const room = roomId ? state.rooms.get(roomId) : null;
  return room && room.slowMode
    ? CONFIG.TIMING.SLOW_MODE_BATCH_INTERVAL
    : CONFIG.TIMING.BATCH_PROCESSING_INTERVAL;
}

// Applies queued diffs to the user's message buffer in rate-limited batches,
// sanitizes the result, and broadcasts a full-replace to the room.
// ── "@name" mentions inside a room ──────────────────────────────────────────
// The textbox is live, so a name sitting in the text must nudge its owner
// once, when it appears, and not again on every keystroke after it. The edge
// is remembered per speaker, and a cooldown stops a delete-and-retype loop
// from being used to pester somebody.
const mentionEdge = new WeakMap(); // socket -> Set of userIds currently named
const mentionCooldown = new Map(); // "speaker|target" -> ts
const MENTION_COOLDOWN_MS = 60000;

function notifyRoomMentions(socket, userId, text) {
  const roomId = socket.roomId;
  const room = roomId ? state.rooms.get(roomId) : null;
  if (!room) return;
  const lower = text.toLowerCase();
  const speaker = socket.handshake.session?.username || "Someone";
  const named = new Set();
  const now = Date.now();

  for (const u of room.users || []) {
    if (!u || u.id === userId || !u.username) continue;
    if (!lower.includes("@" + u.username.toLowerCase())) continue;
    named.add(u.id);
  }

  const before = mentionEdge.get(socket) || new Set();
  mentionEdge.set(socket, named);

  for (const targetId of named) {
    if (before.has(targetId)) continue; // already named a keystroke ago
    const key = userId + "|" + targetId;
    if (now - (mentionCooldown.get(key) || 0) < MENTION_COOLDOWN_MS) continue;
    mentionCooldown.set(key, now);
    for (const s of findSocketsByUserId(targetId)) {
      if (s.roomId !== roomId) continue;
      s.emit("room mention", { by: speaker, roomId });
    }
  }

  if (mentionCooldown.size > 800)
    for (const [k, t] of mentionCooldown)
      if (now - t > MENTION_COOLDOWN_MS) mentionCooldown.delete(k);
}

async function processPendingChatUpdates(userId, socket) {
  try {
    if (!state.pendingChatUpdates.has(userId) || !socket || !socket.roomId)
      return;
    const pending = state.pendingChatUpdates.get(userId);
    if (!pending || pending.diffs.length === 0) return;

    if (state.batchProcessingTimers.has(userId)) {
      clearTimeout(state.batchProcessingTimers.get(userId));
      state.batchProcessingTimers.delete(userId);
    }

    let msg = state.userMessageBuffers.get(userId) || "";
    const username = socket.handshake.session.username || "Anonymous";

    let shouldRateLimit = false;
    try {
      await chatUpdateLimiter.consume(
        userId,
        Math.min(1 + Math.floor(pending.diffs.length / 10), 2),
      );
    } catch (e) {
      shouldRateLimit = true;
      if (e.msBeforeNext > 1000)
        socket.emit("message", { type: "warning", text: "Slow down typing" });
    }

    const limit = shouldRateLimit
      ? Math.min(10, CONFIG.LIMITS.BATCH_SIZE_LIMIT)
      : CONFIG.LIMITS.BATCH_SIZE_LIMIT;
    const batch = pending.diffs.splice(0, limit);

    for (const diff of batch) {
      if (diff.type === "full-replace") {
        msg = diff.text || "";
      } else if (diff.type === "add") {
        diff.index = Math.min(diff.index, msg.length);
        const space = CONFIG.LIMITS.MAX_MESSAGE_LENGTH - msg.length;
        diff.text = (diff.text || "").substring(0, space);
        msg = msg.slice(0, diff.index) + diff.text + msg.slice(diff.index);
      } else if (diff.type === "delete") {
        diff.index = Math.min(diff.index, msg.length);
        diff.count = Math.min(diff.count, msg.length - diff.index);
        msg = msg.slice(0, diff.index) + msg.slice(diff.index + diff.count);
      } else if (diff.type === "replace") {
        diff.index = Math.min(diff.index, msg.length);
        const rLen = (diff.text || "").length;
        const end = Math.min(diff.index + rLen, msg.length);
        msg = msg.slice(0, diff.index) + (diff.text || "") + msg.slice(end);
      }
    }

    msg = sanitizeMessage(msg);
    state.userMessageBuffers.set(userId, msg);

    // Typing "@someone" in a room nudges that person. Their name may contain
    // spaces, so this matches against the actual roster rather than trying to
    // guess where a name ends.
    if (msg.includes("@")) notifyRoomMentions(socket, userId, msg);

    if (socket.roomId) {
      state.roomLastChatActivity.set(socket.roomId, Date.now());
    }

    emitRoomChatUpdate(socket, {
      userId,
      username,
      diff: { type: "full-replace", text: msg },
    });

    setupAFKTimers(socket, userId);

    if (pending.diffs.length > 0) {
      state.batchProcessingTimers.set(
        userId,
        setTimeout(
          () => processPendingChatUpdates(userId, socket),
          getBatchInterval(socket.roomId),
        ),
      );
    } else {
      state.pendingChatUpdates.delete(userId);
    }
    if (state.chatCircuitState.failures > 0) state.chatCircuitState.failures--;
  } catch (err) {
    console.error("processPendingChatUpdates error:", err);
    state.pendingChatUpdates.delete(userId);
  }
}

// ── Leave / Join Room ───────────────────────────────────────────────────────

async function leaveRoom(socket, userId) {
  try {
    const roomId = socket.roomId;
    if (!roomId) return;
    clearAFKTimers(userId);

    finalizeBoardUserStroke(roomId, userId);
    pianoDropPresence(roomId, userId, true);

    const room = state.rooms.get(roomId);
    if (room) {
      // Ownership guard. leaveRoom is keyed only by userId, but during the
      // lobby->room handoff two sockets briefly share one userId. When the old
      // (lobby / superseded) socket disconnects it must NOT evict the membership
      // the newer room socket just added, or that room tab loses its own row and
      // textbox until a manual refresh. If a live successor socket already owns
      // this room for this userId, just detach this stale socket and keep the
      // membership intact.
      const successor = [...io().sockets.sockets.values()].find(
        (s) =>
          s !== socket &&
          s.connected &&
          s.roomId === roomId &&
          s.handshake?.session?.userId === userId,
      );
      if (successor) {
        socket.leave(roomId);
        socket.roomId = null;
        return;
      }

      const leftUser = room.users.find((u) => u.id === userId);
      room.users = room.users.filter((u) => u.id !== userId);
      room.lastActiveTime = Date.now();

      if (room.votes) {
        delete room.votes[userId];
        for (const vid in room.votes) {
          if (room.votes[vid] === userId) delete room.votes[vid];
        }
        emitRoomVoteUpdates(roomId);
      }

      if (room.muteVotes) {
        const affectedTargets = new Set();
        if (room.muteVotes[userId]) affectedTargets.add(room.muteVotes[userId]);
        delete room.muteVotes[userId];
        for (const vid in room.muteVotes) {
          if (room.muteVotes[vid] === userId) delete room.muteVotes[vid];
        }
        room.mutedBotIds?.delete(userId);
        for (const targetId of affectedTargets)
          recomputeBotMuteState(room, targetId);
        emitRoomMuteVoteUpdates(roomId);
      }

      socket.leave(roomId);
      emitRoomUserLeft(roomId, userId, leftUser);
      updateRoom(roomId);
      sendDevRoomContext(roomId);
      updateRoomSoloTracking(roomId);

      if (room.users.length === 0) startRoomDeletionTimer(roomId);
    }

    if (socket.handshake.session) {
      if (socket.handshake.session.validatedRooms?.[roomId])
        delete socket.handshake.session.validatedRooms[roomId];
      socket.handshake.session.currentRoom = null;
      await promisifySessionSave(socket.handshake.session).catch((e) =>
        console.error("Session save in leaveRoom:", e),
      );
    }
    state.userMessageBuffers.delete(userId);
    state.devUsers.delete(userId);

    socket.roomId = null;
    socket.join("lobby");
    updateLobby();
    await debouncedSaveRooms();
  } catch (err) {
    console.error("leaveRoom error:", err);
    if (socket?.emit)
      socket.emit(
        "error",
        createErrorResponse(ERROR_CODES.SERVER_ERROR, "Error leaving room."),
      );
  }
}

function joinRoom(socket, roomId, userId) {
  try {
    if (!roomId || typeof roomId !== "string" || roomId.length !== 6) {
      return socket.emit(
        "error",
        createErrorResponse(
          ERROR_CODES.NOT_FOUND,
          "Room not found (invalid ID).",
        ),
      );
    }
    const room = state.rooms.get(roomId);
    if (!room)
      return socket.emit(
        "error",
        createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
      );
    const isStaff = !!socket.isDev || !!socket.isMod;

    if (room.bannedUserIds?.has(userId) && !isStaff)
      return socket.emit(
        "error",
        createErrorResponse(
          ERROR_CODES.FORBIDDEN,
          "You are banned from this room.",
        ),
      );

    // Maintenance mode and per-room locks block new joins for everyone but staff.
    if (state.maintenance && !isStaff)
      return socket.emit(
        "error",
        createErrorResponse(
          ERROR_CODES.FORBIDDEN,
          "Talkomatic is in maintenance mode. New joins are paused while " +
          "people finish their conversations. Please try again shortly.",
          null,
          true,
        ),
      );

    if (room.locked && !isStaff)
      return socket.emit(
        "error",
        createErrorResponse(
          ERROR_CODES.FORBIDDEN,
          "This room is locked. No new joins are allowed right now.",
          null,
          true,
        ),
      );

    let { username, location } = socket.handshake.session || {};
    if (!username || !location) {
      username = "Anonymous";
      location = "On The Web";
    }

    const clientIp = socket.clientIp || socket.handshake.address;
    if (CONFIG.FEATURES.ENABLE_BOT_PROTECTION) {
      if (isBlacklisted(userId, clientIp))
        return socket.emit(
          "error",
          createErrorResponse(ERROR_CODES.FORBIDDEN, "Access denied."),
        );
      if (detectBotBehavior(userId, clientIp))
        return socket.emit(
          "error",
          createErrorResponse(
            ERROR_CODES.RATE_LIMITED,
            "Too many join attempts.",
          ),
        );
    }

    // Staff sit in as many rooms at once as they have tabs open: watching three
    // rooms is the job, and being bounced out of one to look at another was the
    // main reason moderators spectated instead of joining.
    const isAnon = username === "Anonymous" && location === "On The Web";
    if (!isAnon && !isStaff) {
      const curRoom = getUserCurrentRoom(userId);
      if (curRoom && curRoom !== roomId) {
        const name = state.rooms.get(curRoom)?.name || "Unknown";
        return socket.emit(
          "error",
          createErrorResponse(
            ERROR_CODES.FORBIDDEN,
            `You are already in "${name}". Leave first.`,
            { currentRoomId: curRoom, currentRoomName: name },
            true,
          ),
        );
      }
      if (
        getUsernameLocationRoomsCount(username, location, userId) >=
        CONFIG.LIMITS.MAX_ROOMS_PER_USER
      ) {
        return socket.emit(
          "error",
          createErrorResponse(
            ERROR_CODES.FORBIDDEN,
            "This username/location is already in a room.",
          ),
        );
      }
    }

    if (!room.users) room.users = [];
    if (!room.votes) room.votes = {};
    if (!room.muteVotes) room.muteVotes = {};
    if (!room.mutedBotIds) room.mutedBotIds = new Set();

    // Staff bypass room capacity (can always enter a full room to handle a
    // report); normal users check the visible count.
    //
    // Exclude the joining user's OWN entry from the count. The lobby->room
    // handoff briefly leaves a stale membership for this same userId in
    // room.users (the lobby socket full-joins before navigating to room.html);
    // the dedup filter just below removes it, but that runs AFTER this check.
    // Counting the phantom self would fill the last slot and bounce an
    // otherwise-valid join at exactly capacity-1 (e.g. 9/10 -> "room full").
    const joinableUserCount = (room.users || []).filter(
      (u) => u.id !== userId && !(u.isDev && u.isVanished),
    ).length;
    if (!isStaff && joinableUserCount >= roomCapacity(room))
      return socket.emit(
        "room full",
        createErrorResponse(ERROR_CODES.ROOM_FULL, "Room is full."),
      );

    clearAFKTimers(userId);
    room.users = room.users.filter((u) => u.id !== userId);
    socket.join(roomId);

    room.users.push({
      id: userId,
      username,
      location,
      isDev: !!socket.isDev,
      isMod: !!socket.isMod,
      modLevel: socket.isMod ? socket.modLevel || 2 : undefined,
      isHidden: !!socket.isHidden,
      isVanished: !!socket.isVanished,
      deviceType: socket.deviceType || "unknown",
      deviceId: socket.deviceId || null,
      avatar: socket.handshake.session?.avatar || null,
    });

    if (socket.isDev) {
      state.devUsers.add(userId);
    }

    room.lastActiveTime = Date.now();
    socket.roomId = roomId;

    // One active room tab per browser: pause any OTHER tab of this session that
    // is also in a room. Lobby-only tabs and the Mod Log are left alone, so a
    // user can watch the lobby in one tab and chat in another.
    //
    // Staff are exempt, otherwise the multi-room allowance above is undone the
    // moment they open the second room: each new tab would kill the last.
    if (socket.handshake?.sessionID && !socket.isModLog && !isStaff) {
      const sid = socket.handshake.sessionID;
      for (const [, other] of io().sockets.sockets) {
        if (other.id === socket.id || other.isBot || other.isModLog) continue;
        if (other.handshake?.sessionID !== sid) continue;
        if (!other.roomId) continue; // lobby-only tab stays active
        try {
          other.emit("session superseded", {});
          other.disconnect(true);
        } catch (_) { }
      }
    }

    setupAFKTimers(socket, userId);
    updateRoomSoloTracking(roomId);

    // Session save must complete before emitting join success, so the
    // room page can rejoin via the session without an access code in the URL
    if (socket.handshake.session) {
      socket.handshake.session.currentRoom = roomId;
      socket.handshake.session.save((err) => {
        if (err)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.SERVER_ERROR,
              "Session save failed.",
            ),
          );
        emitJoinSuccess(socket, room, userId, username, location);
      });
    } else {
      emitJoinSuccess(socket, room, userId, username, location);
    }
    debouncedSaveRooms().catch(() => { });
  } catch (err) {
    console.error("joinRoom error:", err);
    socket.emit(
      "error",
      createErrorResponse(
        ERROR_CODES.SERVER_ERROR,
        "Unexpected error joining room.",
      ),
    );
  }
}

function emitJoinSuccess(socket, room, userId, username, location) {
  const joinedUser = room.users?.find((u) => u.id === userId) || {
    id: userId,
    username,
    location,
    isDev: !!socket.isDev,
    isMod: !!socket.isMod,
    modLevel: socket.isMod ? socket.modLevel || 2 : undefined,
    isHidden: !!socket.isHidden,
    isVanished: !!socket.isVanished,
  };

  // The joining user always sees themselves in full
  const createdAt = room.createdAt || room.lastActiveTime || 0;
  socket.emit("room joined", {
    protocol: CONFIG.VERSIONS.PROTOCOL,
    roomId: room.id,
    userId,
    username,
    location,
    isDev: !!socket.isDev,
    isMod: !!socket.isMod,
    modLevel: socket.isMod ? socket.modLevel || 2 : 0,
    isHidden: !!socket.isHidden,
    isVanished: !!socket.isVanished,
    roomName: room.name,
    roomType: room.type,
    locked: !!room.locked,
    slowMode: !!room.slowMode,
    spotlight: !!room.spotlight,
    maxSize: roomCapacity(room),
    users: filterUsersForSocket(room.users || [], socket),
    layout: room.layout,
    votes: filterVotesForSocket(room, socket),
    muteVotes: filterMuteVotesForSocket(room, socket),
    mutedBotIds: Array.from(room.mutedBotIds || []),
    currentMessages: filterCurrentMessagesForSocket(room, socket),
    createdAt: createdAt,
    uptime: Date.now() - createdAt
  });

  socket.leave("lobby");

  emitRoomUserJoined(room, joinedUser);
  updateRoom(room.id);
  updateLobby();

  if (state.roomDeletionTimers.has(room.id)) {
    clearTimeout(state.roomDeletionTimers.get(room.id));
    state.roomDeletionTimers.delete(room.id);
  }
  sendDevRoomContext(room.id);
}

function handleTyping(socket, userId, username, isTyping) {
  if (!socket.roomId) return;
  if (state.typingTimeouts.has(userId))
    clearTimeout(state.typingTimeouts.get(userId));

  if (isTyping) {
    emitRoomTyping(socket, userId, username, true);
    state.typingTimeouts.set(
      userId,
      setTimeout(() => {
        emitRoomTyping(socket, userId, username, false);
        state.typingTimeouts.delete(userId);
      }, CONFIG.TIMING.TYPING_TIMEOUT),
    );
  } else {
    emitRoomTyping(socket, userId, username, false);
    state.typingTimeouts.delete(userId);
  }
}

// ── Socket Event Registration ───────────────────────────────────────────────

// Set by the entry point: returns the id of the client code being served, so a
// page that reconnects after a deploy can tell it is running something old.
let getBuildId = null;

function registerSocketHandlers(opts) {
  if (opts && typeof opts.buildId === "function") getBuildId = opts.buildId;

  io().on("connection", (socket) => {
    const clientIp = socket.clientIp || socket.handshake.address;

    // Give the per-IP connection slot back, registered before anything else and
    // kept separate from the main disconnect handler further down. The slot is
    // taken in the connect middleware, so if any setup below threw before the
    // handlers were attached, that slot would never come back and the IP would
    // creep up to the cap until it could not connect at all ("Too many
    // connections"). The process survives thrown errors, so this must not
    // depend on the rest of this function running.
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased || !socket.clientIp) return;
      slotReleased = true;
      const c = state.ipConnections.get(socket.clientIp) || 0;
      if (c > 1) state.ipConnections.set(socket.clientIp, c - 1);
      else state.ipConnections.delete(socket.clientIp);
    };
    socket.on("disconnect", releaseSlot);

    // Which build of the client code this server is serving. A page that
    // reconnects after a deploy compares it with the one it loaded and reloads
    // itself if it is behind, which is the only way a room page picks up new
    // scripts and styles: it rejoins in place rather than reloading.
    if (getBuildId) socket.emit("server build", { id: getBuildId() });

    socket.deviceType = deviceTypeFromUA(socket.handshake.headers["user-agent"]);

    // Wraps handlers so one error cannot crash the process; disconnects
    // sockets that error repeatedly
    function safe(fn) {
      return async (...args) => {
        try {
          await fn(...args);
        } catch (err) {
          console.error(`Socket error [${fn.name || "?"}] ${clientIp}:`, err);
          try {
            socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.SERVER_ERROR,
                "Internal server error.",
              ),
            );
            socket._errCount = (socket._errCount || 0) + 1;
            if (socket._errCount > 10) socket.disconnect(true);
          } catch (_) { }
        }
      };
    }

    // ── Check Sign-In Status ────────────────────────────────────────────
    socket.on(
      "check signin status",
      safe(async () => {
        let { username, location, userId, isIPBased } =
          socket.handshake.session || {};
        if (
          !username &&
          CONFIG.FEATURES.ENABLE_IP_BASED_USERS &&
          socket.browserDetection?.isBrowser
        ) {
          const ipUser = createIPBasedUser(socket.clientIp);
          username = ipUser.username;
          location = ipUser.location;
          userId = ipUser.userId;
          isIPBased = true;
          if (socket.handshake.session) {
            Object.assign(socket.handshake.session, {
              username,
              location,
              userId,
              isIPBased: true,
            });
            await promisifySessionSave(socket.handshake.session).catch(
              () => { },
            );
          }
        }
        if (username && location && userId) {
          if (socket.isDev) {
            state.devUsers.add(userId);
          }

          socket.emit("signin status", {
            isSignedIn: true,
            username,
            location,
            userId,
            isIPBased: !!isIPBased,
            isBot: !!socket.isBot,
            isDev: !!socket.isDev,
            isMod: !!socket.isMod,
            modLevel: socket.isMod ? socket.modLevel || 2 : 0,
            isHidden: !!socket.isHidden,
          });
          socket.join("lobby");
          state.users.set(userId, {
            id: userId,
            username,
            location,
            isIPBased,
          });
          updateLobby();
        } else {
          socket.emit("signin status", {
            isSignedIn: false,
            isBot: !!socket.isBot,
            isDev: !!socket.isDev,
            isMod: !!socket.isMod,
            modLevel: socket.isMod ? socket.modLevel || 2 : 0,
          });
        }
      }),
    );

    // ── Join Lobby ──────────────────────────────────────────────────────
    socket.on(
      "join lobby",
      safe(async (data) => {
        if (!data || typeof data !== "object")
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Invalid data."),
          );
        const valErr = validateObject(data, {
          username: { rule: "username" },
          location: { rule: "location" },
          avatar: { rule: "avatar" },
        });
        if (valErr) return socket.emit("validation_error", valErr);

        // Optional Discord avatar. Only the validated snowflake + hash are
        // kept; sending avatar:null (or omitting it) clears the stored one.
        const pfpBlocked = false;
        const avatar =
          !pfpBlocked && data.avatar && typeof data.avatar === "object"
            ? {
                id: String(data.avatar.discordId),
                hash: String(data.avatar.hash).toLowerCase(),
                animated: !!data.avatar.animated,
              }
            : null;

        // Identity fields are sanitized (zalgo/RTL stripped) before the
        // word filter runs, so obfuscated slurs are cleaned then caught
        let username = enforceUsernameLimit(sanitizeName(data.username));
        let location = enforceLocationLimit(
          sanitizeName(data.location || "On The Web"),
        );

        // Sanitization can empty a name made entirely of stripped
        // characters; reject instead of admitting a blank user
        if (!username) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Username contains no valid characters.",
            ),
          );
        }
        if (!location) location = "On The Web";

        if (CONFIG.FEATURES.ENABLE_WORD_FILTER) {
          if (wordFilter.checkText(username).hasOffensiveWord)
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.VALIDATION_ERROR,
                "Username contains forbidden words.",
              ),
            );
          if (wordFilter.checkText(location).hasOffensiveWord)
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.VALIDATION_ERROR,
                "Location contains forbidden words.",
              ),
            );
        }

        // Reserved staff names only validate for connections carrying a
        // dev or mod key, so trolls cannot impersonate staff.
        if (isReservedName(username) && !socket.isDev && !socket.isMod) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "That username is reserved. Please choose another.",
            ),
          );
        }

        const userId = socket.handshake.sessionID;
        if (!socket.handshake.session)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.SERVER_ERROR,
              "Session not available.",
            ),
          );
        Object.assign(socket.handshake.session, {
          username,
          location,
          userId,
          isIPBased: false,
          avatar,
        });
        await promisifySessionSave(socket.handshake.session);
        state.users.set(userId, { id: userId, username, location });

        // If they are already in a room, update their live user record so the
        // avatar shows without a rejoin.
        for (const room of state.rooms.values()) {
          const u = (room.users || []).find((x) => x.id === userId);
          if (u && u.avatar !== avatar) {
            u.avatar = avatar;
            emitRoomSnapshot(room);
          }
        }


        if (socket.isDev) {
          state.devUsers.add(userId);
        }

        socket.join("lobby");
        updateLobby();
        socket.emit("signin status", {
          isSignedIn: true,
          username,
          location,
          userId,
          isIPBased: false,
          isBot: !!socket.isBot,
          isDev: !!socket.isDev,
          isMod: !!socket.isMod,
          modLevel: socket.isMod ? socket.modLevel || 2 : 0,
          isHidden: !!socket.isHidden,
          avatar,
        });
      }),
    );


    // ── Talkoboard: stroke lifecycle + state sync ───────────────────────

    socket.on(
      "board open",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return; // spectators are read-only
        socket.boardOpen = true;
        clearAFKTimers(socket.handshake.session.userId);

        const bs = getBoardState(socket.roomId);
        const room = state.rooms.get(socket.roomId);
        const activeObj = {};
        for (const [uid, stroke] of bs.active) {
          // Hide a vanished dev's in-progress stroke from a non-dev newcomer.
          const u = room && room.users.find((x) => x.id === uid);
          if (u && !canRecipientSeeDevUser(socket, u)) continue;
          activeObj[uid] = stroke;
        }
        socket.emit("board state", {
          strokes: bs.strokes,
          active: activeObj,
        });

        emitSubAppEvent(
          socket,
          "board user status",
          { userId: socket.handshake.session.userId, open: true },
          false,
        );
      }),
    );

    // ── Talkoboard: who drew a stroke (staff only) ──────────────────────
    // Every stroke already carries its author server-side, so a moderator
    // looking at something they have to act on can find out who put it there
    // instead of guessing or clearing the whole board. The lookup is by stroke
    // id and answered from server state, so a client cannot fish for names, and
    // a vanished dev stays invisible exactly as they are everywhere else.
    socket.on(
      "board who drew",
      safe(async (data) => {
        if (!socket.roomId) return;
        const id = typeof data?.id === "string" ? data.id : null;
        if (!id) return;

        const bs = getBoardState(socket.roomId);
        let stroke = bs.strokes.find((s) => s.id === id);
        if (!stroke) {
          for (const [, s] of bs.active) {
            if (s && s.id === id) {
              stroke = s;
              break;
            }
          }
        }
        if (!stroke || !stroke.owner)
          return socket.emit("board stroke author", { id, unknown: true });

        const room = state.rooms.get(socket.roomId);
        const user = room?.users?.find((u) => u.id === stroke.owner);
        if (user && !canRecipientSeeDevUser(socket, user))
          return socket.emit("board stroke author", { id, unknown: true });

        socket.emit("board stroke author", {
          id,
          userId: stroke.owner,
          username: user ? user.username : null,
          present: !!user,
        });
      }),
    );

    socket.on(
      "board stroke start",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        const userId = socket.handshake.session.userId;

        if (
          !data ||
          typeof data.color !== "string" ||
          typeof data.size !== "number"
        )
          return;
        if (
          !data.point ||
          typeof data.point.x !== "number" ||
          typeof data.point.y !== "number"
        )
          return;

        // Optional client-supplied id lets the drawer undo/redo this exact
        // stroke later. Ownership for undo is enforced server-side via `owner`,
        // never by trusting the id, so a forged id can't touch anyone else's work.
        const strokeId =
          typeof data.id === "string" && data.id.length <= 64 ? data.id : null;

        const stroke = {
          id: strokeId,
          owner: userId,
          points: [{ x: data.point.x, y: data.point.y }],
          color: data.color.slice(0, 7),
          size: Math.min(Math.max(data.size, 1), 50),
          eraser: !!data.eraser,
          gradient: data.eraser ? null : sanitizeGradient(data.gradient),
        };

        const bs = getBoardState(socket.roomId);
        finalizeBoardUserStroke(socket.roomId, userId);
        bs.active.set(userId, stroke);

        emitSubAppEvent(socket, "board stroke start", {
          userId,
          id: stroke.id,
          color: stroke.color,
          size: stroke.size,
          eraser: stroke.eraser,
          gradient: stroke.gradient,
          point: stroke.points[0],
        }, false);
      }),
    );

    socket.on(
      "board stroke move",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        const userId = socket.handshake.session.userId;

        if (!data?.points || !Array.isArray(data.points)) return;
        if (data.points.length > 200) return;

        const bs = getBoardState(socket.roomId);
        const active = bs.active.get(userId);
        if (!active) return;

        const validPoints = [];
        for (const p of data.points) {
          if (typeof p.x === "number" && typeof p.y === "number") {
            validPoints.push({ x: p.x, y: p.y });
          }
        }
        if (validPoints.length === 0) return;

        active.points.push(...validPoints);

        if (active.points.length > MAX_POINTS_PER_STROKE) {
          active.points = active.points.slice(-MAX_POINTS_PER_STROKE);
        }

        emitSubAppEvent(socket, "board stroke move", {
          userId,
          points: validPoints,
        }, false);
      }),
    );

    socket.on(
      "board stroke end",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        const userId = socket.handshake.session.userId;
        finalizeBoardUserStroke(socket.roomId, userId);
        emitSubAppEvent(socket, "board stroke end", { userId }, false);
      }),
    );

    // ── Undo: remove one of YOUR OWN completed strokes, board-wide ──────
    socket.on(
      "board stroke remove",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        const userId = socket.handshake.session.userId;
        const id = data?.id;
        if (typeof id !== "string" || id.length > 64) return;

        const bs = getBoardState(socket.roomId);
        // Ownership enforced here - you can only remove a stroke you own.
        const idx = bs.strokes.findIndex(
          (s) => s.id === id && s.owner === userId,
        );
        if (idx !== -1) {
          bs.strokes.splice(idx, 1);
          saveBoardSoon();
        } else {
          // Could still be the user's active (unfinished) stroke
          const active = bs.active.get(userId);
          if (active && active.id === id) bs.active.delete(userId);
          else return;
        }
        emitSubAppEvent(socket, "board stroke remove", { id }, false);
      }),
    );

    // ── Redo: re-add a stroke you previously undid, board-wide ──────────
    socket.on(
      "board stroke add",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        const userId = socket.handshake.session.userId;
        const s = data?.stroke;
        if (!s || typeof s !== "object") return;
        if (typeof s.id !== "string" || s.id.length > 64) return;
        if (!Array.isArray(s.points) || s.points.length === 0) return;

        const points = [];
        for (const p of s.points) {
          if (typeof p?.x === "number" && typeof p?.y === "number") {
            points.push({ x: p.x, y: p.y });
            if (points.length >= MAX_POINTS_PER_STROKE) break;
          }
        }
        if (points.length === 0) return;

        const stroke = {
          id: s.id,
          owner: userId,
          points,
          color: typeof s.color === "string" ? s.color.slice(0, 7) : "#000000",
          size: Math.min(Math.max(Number(s.size) || 3, 1), 50),
          eraser: !!s.eraser,
          gradient: s.eraser ? null : sanitizeGradient(s.gradient),
        };

        const bs = getBoardState(socket.roomId);
        if (bs.strokes.some((x) => x.id === stroke.id)) return; // dedupe
        bs.strokes.push(stroke);
        if (bs.strokes.length > MAX_BOARD_STROKES) {
          bs.strokes = bs.strokes.slice(-MAX_BOARD_STROKES);
        }
        saveBoardSoon();
        emitSubAppEvent(socket, "board stroke add", { userId, stroke }, false);
      }),
    );

    socket.on(
      "board close",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        const userId = socket.handshake.session.userId;
        socket.boardOpen = false;
        finalizeBoardUserStroke(socket.roomId, userId);
        setupAFKTimers(socket, userId);
        emitSubAppEvent(
          socket,
          "board user status",
          { userId, open: false },
          false,
        );
      }),
    );

    socket.on(
      "board cursor",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        if (typeof data?.x !== "number" || typeof data?.y !== "number") return;
        emitSubAppEvent(
          socket,
          "board cursor",
          {
            userId: socket.handshake.session.userId,
            username: socket.handshake.session.username || "Anonymous",
            x: data.x,
            y: data.y,
          },
          false,
        );
      }),
    );

    socket.on(
      "board chat",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        if (!data?.text || typeof data.text !== "string") return;
        const text = data.text.slice(0, 200);
        emitSubAppEvent(
          socket,
          "board chat",
          {
            userId: socket.handshake.session.userId,
            username: socket.handshake.session.username || "Anonymous",
            text,
            timestamp: Date.now(),
          },
          true,
        );
      }),
    );

    socket.on(
      "board clear",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        // Any staff can wipe the board: it is one room's drawing and the only
        // way to remove something drawn that should not be on screen.
        if (!socket.isDev && !socket.isMod) return;
        const bs = boardState.get(socket.roomId);
        if (bs) {
          bs.strokes = [];
          bs.active.clear();
        }
        saveBoardSoon(); // persist the cleared board so a restart can't restore it
        io().to(socket.roomId).emit("board clear");
      }),
    );

    // ── Multiplayer Piano: presence, notes, cursor, chat, crown, mute ───
    // Every handler proves identity from the session (never the payload),
    // scopes to socket.roomId, and re-validates ownership/lock/mute server-side.

    socket.on(
      "piano open",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return; // spectators are read-only
        const userId = socket.handshake.session.userId;
        socket.pianoOpen = true;
        clearAFKTimers(userId);

        const ps = getPianoState(socket.roomId);
        ps.open.add(userId);

        // Tell the newcomer who is already at the piano + the crown/mute state.
        const room = state.rooms.get(socket.roomId);
        const participants = [];
        for (const uid of ps.open) {
          if (uid === userId) continue;
          const u = room && room.users.find((x) => x.id === uid);
          // Hide a vanished dev at the piano from a non-dev newcomer.
          if (u && !canRecipientSeeDevUser(socket, u)) continue;
          participants.push({ userId: uid, username: u ? u.username : "User" });
        }
        socket.emit("piano participants", { participants });
        socket.emit("piano crown", pianoMetaFor(socket.roomId, socket));
        socket.emit("piano muted", { muted: Array.from(ps.muted) });

        // Announce the newcomer to everyone else (hidden from non-devs when the
        // newcomer is a vanished dev).
        emitSubAppEvent(
          socket,
          "piano user status",
          {
            userId,
            username: socket.handshake.session.username || "Anonymous",
            open: true,
          },
          false,
        );
      }),
    );

    socket.on(
      "piano close",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        const userId = socket.handshake.session.userId;
        socket.pianoOpen = false;
        setupAFKTimers(socket, userId);
        // Keep mute across a close so it can't be self-cleared.
        pianoDropPresence(socket.roomId, userId, false);
      }),
    );

    socket.on(
      "piano notes",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        const userId = socket.handshake.session.userId;
        if (!data || !Array.isArray(data.notes) || data.notes.length === 0)
          return;

        const ps = getPianoState(socket.roomId);
        // Must have announced presence (be "at the piano") to broadcast. Stops a
        // modified client from streaming notes while staying off the participant
        // list - which would also dodge the per-user mute, since both the mute
        // UI and presence key off ps.open.
        if (!ps.open.has(userId)) return;
        if (ps.muted.has(userId)) return; // staff-muted: silenced server-side

        // "Only owner can play": only the crown holder or staff may sound notes.
        const isStaff = !!(socket.isDev || socket.isMod);
        if (ps.onlyOwner && ps.crown !== userId && !isStaff) return;

        // Inline per-second flood guard (no async work per note; mirrors how the
        // board clamps points). A new 1s window resets the counters.
        const now = Date.now();
        if (!socket._pianoWin || now - socket._pianoWin.t >= 1000) {
          socket._pianoWin = { t: now, notes: 0, msgs: 0 };
        }
        const win = socket._pianoWin;
        if (++win.msgs > PIANO_MAX_MSGS_PER_SEC) return;

        const clean = [];
        let onCount = 0;
        const list = data.notes;
        const limit = Math.min(list.length, 256); // hard bound on work per message
        for (let i = 0; i < limit; i++) {
          const ev = list[i];
          if (!ev || typeof ev.n !== "number") continue;
          const n = ev.n | 0;
          if (n < PIANO_MIN_KEY || n > PIANO_MAX_KEY) continue;
          let d = typeof ev.d === "number" ? ev.d : 0;
          if (!(d >= 0)) d = 0;
          if (d > 250) d = 250;
          d = d | 0;

          if (ev.s === 1) {
            // Note-offs ALWAYS relay - throttling them would leave keys/voices
            // stuck on everyone else's screen.
            clean.push({ n, s: 1, d });
            continue;
          }
          // Throttle only note-ONs (per second + per message) so a bot or
          // black-MIDI flood can't lag the room.
          if (++win.notes > PIANO_MAX_NOTES_PER_SEC) continue;
          if (++onCount > PIANO_MAX_NOTES_PER_MSG) continue;
          let v = typeof ev.v === "number" ? ev.v : 0.6;
          if (!(v > 0)) v = 0.6;
          if (v > 1) v = 1;
          clean.push({ n, v: Math.round(v * 1000) / 1000, d });
        }
        if (clean.length === 0) return;

        emitSubAppEvent(socket, "piano notes", { userId, notes: clean }, false);
      }),
    );

    socket.on(
      "piano cursor",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        if (typeof data?.x !== "number" || typeof data?.y !== "number") return;
        // Only players actually at the piano broadcast a cursor (mirrors notes).
        if (!getPianoState(socket.roomId).open.has(socket.handshake.session.userId))
          return;
        // x,y are fractions (0..1) of the keyboard area, resolution-independent.
        const x = Math.max(0, Math.min(1, data.x));
        const y = Math.max(0, Math.min(1, data.y));
        emitSubAppEvent(
          socket,
          "piano cursor",
          {
            userId: socket.handshake.session.userId,
            username: socket.handshake.session.username || "Anonymous",
            x,
            y,
          },
          false,
        );
      }),
    );

    socket.on(
      "piano chat",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        if (!data?.text || typeof data.text !== "string") return;
        // Only players actually at the piano may post to its chat.
        if (!getPianoState(socket.roomId).open.has(socket.handshake.session.userId))
          return;
        const text = sanitizeMessage(data.text).slice(0, 200);
        if (!text.trim()) return;
        // Relay raw; each client applies its own word filter on display, matching
        // the room's per-viewer automod toggle.
        emitSubAppEvent(
          socket,
          "piano chat",
          {
            userId: socket.handshake.session.userId,
            username: socket.handshake.session.username || "Anonymous",
            text,
            timestamp: Date.now(),
          },
          true,
        );
      }),
    );

    // Claim the crown. Restricted to staff (devs + mods): the crown gates the
    // "only owner can play" lock, so only higher-level users may hold it.
    socket.on(
      "piano crown claim",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        const isStaff = !!(socket.isDev || socket.isMod);
        if (!isStaff) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "Only staff can hold the crown.",
            ),
          );
        }
        const userId = socket.handshake.session.userId;
        const ps = getPianoState(socket.roomId);
        ps.crown = userId;
        emitPianoCrown(socket.roomId);
      }),
    );

    // Drop the crown (holder or staff). Clears any "only owner" lock with it.
    socket.on(
      "piano crown drop",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        const userId = socket.handshake.session.userId;
        const ps = getPianoState(socket.roomId);
        const isStaff = !!(socket.isDev || socket.isMod);
        if (ps.crown !== userId && !isStaff) return;
        ps.crown = null;
        ps.onlyOwner = false;
        emitPianoCrown(socket.roomId);
      }),
    );

    // Toggle "only owner can play" (crown holder or staff only).
    socket.on(
      "piano set lock",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        const userId = socket.handshake.session.userId;
        const ps = getPianoState(socket.roomId);
        const isStaff = !!(socket.isDev || socket.isMod);
        if (ps.crown !== userId && !isStaff) return;
        ps.onlyOwner = !!(data && data.onlyOwner);
        emitPianoCrown(socket.roomId);
      }),
    );

    // ── Create Room ─────────────────────────────────────────────────────
    socket.on(
      "create room",
      safe(async (data) => {
        if (!data || typeof data !== "object")
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Invalid data."),
          );
        const userId = socket.handshake.session?.userId;
        if (!userId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.UNAUTHORIZED,
              "Sign in to create a room.",
            ),
          );

        // Maintenance mode and the live room-creation flag block new rooms for
        // everyone but staff.
        const creatorIsStaff = !!socket.isDev || !!socket.isMod;
        if (state.maintenance && !creatorIsStaff)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "Talkomatic is in maintenance mode. Creating new rooms is paused " +
              "while people finish their conversations.",
              null,
              true,
            ),
          );
        if (!CONFIG.FEATURES.ENABLE_ROOM_CREATION && !creatorIsStaff)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "Room creation is temporarily disabled.",
              null,
              true,
            ),
          );

        const valErr = validateObject(data, {
          name: { rule: "roomName" },
          type: { rule: "roomType" },
          layout: { rule: "layout" },
          accessCode: { rule: "accessCode", context: data.type },
        });
        if (valErr) return socket.emit("validation_error", valErr);

        const { username, location } = socket.handshake.session;
        if (
          normalize(username) === "anonymous" &&
          normalize(location) === "on the web"
        )
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "Anonymous users cannot create rooms.",
            ),
          );

        if (state.rooms.size >= CONFIG.LIMITS.HARD_MAX_ROOMS) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.ROOM_LIMIT_REACHED,
              "Server is at maximum capacity. Please try again shortly.",
            ),
          );
        }

        const healthyCount = getHealthyRoomCount();
        const limit = calculateCurrentRoomLimit();
        if (healthyCount >= limit) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.ROOM_LIMIT_REACHED,
              `Room limit reached (${limit}). Try again in a moment.`,
            ),
          );
        }

        // Staff can already sit in several rooms at once (see joinRoom), so the
        // one-room limit does not apply to opening another one either.
        if (
          !creatorIsStaff &&
          getUsernameLocationRoomsCount(username, location, userId) >=
          CONFIG.LIMITS.MAX_ROOMS_PER_USER
        )
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.FORBIDDEN, "Already in a room."),
          );
        if (
          !creatorIsStaff &&
          getUserRoomsCount(userId) >= CONFIG.LIMITS.MAX_ROOMS_PER_USER
        )
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.FORBIDDEN, "Already in a room."),
          );

        const now = Date.now();
        if (
          now - (state.lastRoomCreationTimes.get(userId) || 0) <
          CONFIG.TIMING.ROOM_CREATION_COOLDOWN
        )
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.RATE_LIMITED,
              "Creating rooms too fast.",
            ),
          );

        const ipRoomCount = getRoomCountByIP(clientIp);
        if (ipRoomCount >= CONFIG.LIMITS.MAX_ROOMS_PER_IP) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.RATE_LIMITED,
              "Too many rooms from this connection.",
            ),
          );
        }

        const lastIpCreation = state.ipLastRoomCreation.get(clientIp) || 0;
        if (now - lastIpCreation < CONFIG.LIMITS.IP_ROOM_CREATION_COOLDOWN) {
          const waitSec = Math.ceil(
            (CONFIG.LIMITS.IP_ROOM_CREATION_COOLDOWN - (now - lastIpCreation)) /
            1000,
          );
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.RATE_LIMITED,
              `Please wait ${waitSec}s before creating another room.`,
            ),
          );
        }

        // Room names get the same zalgo/RTL sanitization as usernames
        let roomName = enforceRoomNameLimit(sanitizeName(data.name));
        if (!roomName) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Room name contains no valid characters.",
            ),
          );
        }
        if (roomNameExists(roomName))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.ROOM_NAME_EXISTS,
              "Room name already exists.",
            ),
          );
        if (
          CONFIG.FEATURES.ENABLE_WORD_FILTER &&
          wordFilter.checkText(roomName).hasOffensiveWord
        )
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Room name contains forbidden words.",
            ),
          );

        state.lastRoomCreationTimes.set(userId, now);
        state.ipLastRoomCreation.set(clientIp, now);

        let roomId,
          attempts = 0;
        do {
          roomId = generateRoomId();
          attempts++;
          if (attempts > CONFIG.LIMITS.MAX_ID_GEN_ATTEMPTS)
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.SERVER_ERROR,
                "Could not generate room ID.",
              ),
            );
        } while (state.rooms.has(roomId));

        state.rooms.set(roomId, {
          id: roomId,
          name: roomName,
          type: data.type,
          layout: data.layout,
          users: [],
          accessCode: data.type === "semi-private" ? data.accessCode : null,
          votes: {},
          muteVotes: {},
          mutedBotIds: new Set(),
          bannedUserIds: new Set(),
          lastActiveTime: now,
          createdAt: now,
        });

        // Creator's access code is validated into the session up front,
        // so the room page can join without the code in the URL
        if (data.type === "semi-private" && data.accessCode) {
          if (!socket.handshake.session.validatedRooms)
            socket.handshake.session.validatedRooms = {};
          socket.handshake.session.validatedRooms[roomId] = data.accessCode;
          await promisifySessionSave(socket.handshake.session).catch(() => { });
        }

        state.apiCache.delete("public_rooms");
        socket.emit("room created", roomId);
        updateLobby();
        await debouncedSaveRooms();
        const stats = getRoomStatistics();
        console.log(
          `Room created: ${roomId} (${roomName}) by IP:${clientIp} | ` +
          `Total: ${stats.totalRooms}/${stats.hardCap} | ` +
          `Healthy: ${stats.healthyRooms}/${stats.currentLimit} | ` +
          `Solo TTL: ${stats.currentSoloTTL}s`,
        );
      }),
    );

    // ── Join Room ───────────────────────────────────────────────────────
    socket.on(
      "join room",
      safe(async (data) => {
        if (!data?.roomId)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Invalid data."),
          );
        const room = state.rooms.get(data.roomId);
        if (!room)
          return socket.emit(
            "room not found",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
          );

        let { username, location, userId } = socket.handshake.session || {};
        if (!userId) {
          userId = socket.handshake.sessionID;
          if (socket.handshake.session) {
            socket.handshake.session.userId = userId;
            if (!username) socket.handshake.session.username = "Anonymous";
            if (!location) socket.handshake.session.location = "On The Web";
          } else
            return socket.emit(
              "error",
              createErrorResponse(ERROR_CODES.SERVER_ERROR, "Session error."),
            );
        }
        username = username || "Anonymous";
        location = location || "On The Web";

        // Early copy of the one-room-at-a-time rule, so a normal user is turned
        // away before any of the join work happens. Staff are exempt here for
        // the same reason as in joinRoom: watching several rooms is the job.
        const isAnon = username === "Anonymous" && location === "On The Web";
        if (!isAnon && !socket.isDev && !socket.isMod) {
          const cur = getUserCurrentRoom(userId);
          if (cur && cur !== data.roomId) {
            const n = state.rooms.get(cur)?.name || "Unknown";
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.FORBIDDEN,
                `Already in "${n}". Leave first.`,
                { currentRoomId: cur, currentRoomName: n },
                true,
              ),
            );
          }
        }

        // Semi-private rooms: session-validated codes skip the prompt. Only devs
        // bypass the code (they can see codes anyway); mods enter it like a normal
        // user, or moderate read-only via spectate, which needs no code.
        const bypassAccessCode = socket.isDev;
        if (room.type === "semi-private" && !bypassAccessCode) {
          const validated =
            socket.handshake.session.validatedRooms?.[data.roomId];
          let code = data.accessCode;
          if (validated) code = validated;
          else if (!code) return socket.emit("access code required");
          if (
            typeof code !== "string" ||
            code.length !== 6 ||
            !/^\d+$/.test(code)
          )
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.VALIDATION_ERROR,
                "Invalid access code format.",
              ),
            );
          if (room.accessCode !== code)
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.FORBIDDEN,
                "Incorrect access code.",
              ),
            );
          if (!validated && socket.handshake.session) {
            if (!socket.handshake.session.validatedRooms)
              socket.handshake.session.validatedRooms = {};
            socket.handshake.session.validatedRooms[data.roomId] = code;
            await promisifySessionSave(socket.handshake.session).catch(
              () => { },
            );
          }
        }
        joinRoom(socket, data.roomId, userId);
      }),
    );

    // ── Vote Kick ───────────────────────────────────────────────────────
    socket.on(
      "vote",
      safe(async (data) => {
        if (!data?.targetUserId) return;
        const userId = socket.handshake.session?.userId;
        const roomId = socket.roomId;
        if (!roomId || !userId) return;
        const room = state.rooms.get(roomId);
        if (
          !room ||
          !room.users.find((u) => u.id === userId) ||
          userId === data.targetUserId
        )
          return;
        // Votes are only accepted at or above the minimum room size
        if (room.users.length < CONFIG.LIMITS.MIN_USERS_FOR_VOTING) return;
        if (!room.users.find((u) => u.id === data.targetUserId)) return;
        if (!room.votes) room.votes = {};
        if (room.votes[userId] === data.targetUserId) delete room.votes[userId];
        else room.votes[userId] = data.targetUserId;
        emitRoomVoteUpdates(roomId);
        const votesAgainst = Object.values(room.votes).filter(
          (v) => v === data.targetUserId,
        ).length;
        if (votesAgainst > Math.floor(room.users.length / 2)) {
          const target = findSocketByUserId(data.targetUserId, roomId);
          if (target) {
            target.emit("kicked");
            if (!room.bannedUserIds) room.bannedUserIds = new Set();
            room.bannedUserIds.add(data.targetUserId);
            await leaveRoom(target, data.targetUserId);
          }
        }
      }),
    );

    // ── Vote Mute (bots only) ──────────────────────────────────────────
    socket.on(
      "vote mute",
      safe(async (data) => {
        if (!data?.targetUserId) return;
        const userId = socket.handshake.session?.userId;
        const roomId = socket.roomId;
        if (!roomId || !userId) return;
        const room = state.rooms.get(roomId);
        if (
          !room ||
          !room.users.find((u) => u.id === userId) ||
          userId === data.targetUserId
        )
          return;
        if (!room.users.find((u) => u.id === data.targetUserId)) return;
        const targetSocket = findSocketByUserId(data.targetUserId, roomId);
        if (!targetSocket?.isBot) return; // only bots are vote-mutable
        if (!room.muteVotes) room.muteVotes = {};
        if (room.muteVotes[userId] === data.targetUserId)
          delete room.muteVotes[userId];
        else room.muteVotes[userId] = data.targetUserId;
        recomputeBotMuteState(room, data.targetUserId);
        emitRoomMuteVoteUpdates(roomId);
      }),
    );

    socket.on(
      "leave room",
      safe(async () => {
        const userId = socket.handshake.session?.userId;
        if (userId) {
          clearAFKTimers(userId);
          await leaveRoom(socket, userId);
        }
      }),
    );

    // ── Chat Updates (diff-based, batched) ──────────────────────────────
    socket.on(
      "chat update",
      safe(async (data) => {
        if (!checkChatCircuit())
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.CIRCUIT_OPEN,
              "System temporarily unavailable.",
            ),
          );
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        // Spectators are read-only; frozen users are input-locked by staff.
        if (socket.spectating) return;
        if (socket.frozen) return;
        const userId = socket.handshake.session.userId;
        // A vote-muted bot is silenced server-side until the vote is withdrawn.
        if (state.rooms.get(socket.roomId)?.mutedBotIds?.has(userId)) return;
        if (!data?.diff || typeof data.diff !== "object")
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Invalid chat data."),
          );
        const { diff } = data;
        if (!["full-replace", "add", "delete", "replace"].includes(diff.type))
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Unknown diff type."),
          );
        if (
          (diff.type === "add" ||
            diff.type === "replace" ||
            diff.type === "full-replace") &&
          typeof diff.text !== "string"
        )
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "Diff text must be string.",
            ),
          );
        if (diff.text) diff.text = enforceCharacterLimit(diff.text);
        if (
          diff.type !== "full-replace" &&
          (typeof diff.index !== "number" || diff.index < 0)
        )
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Invalid diff index."),
          );
        if (
          diff.type === "delete" &&
          (typeof diff.count !== "number" || diff.count < 0)
        )
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "Invalid delete count.",
            ),
          );

        if (!state.pendingChatUpdates.has(userId))
          state.pendingChatUpdates.set(userId, { diffs: [] });
        state.pendingChatUpdates.get(userId).diffs.push(diff);
        if (!state.batchProcessingTimers.has(userId)) {
          state.batchProcessingTimers.set(
            userId,
            setTimeout(
              () => processPendingChatUpdates(userId, socket),
              getBatchInterval(socket.roomId),
            ),
          );
        }
      }),
    );

    socket.on(
      "typing",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating || socket.frozen) return;
        const userId = socket.handshake.session.userId;
        if (state.rooms.get(socket.roomId)?.mutedBotIds?.has(userId)) return;
        const username = socket.handshake.session.username || "Anonymous";
        if (data?.isTyping === false) {
          handleTyping(socket, userId, username, false);
          return;
        }
        await typingLimiter.consume(userId).catch(() => { });
        if (!data || typeof data.isTyping !== "boolean") return;
        handleTyping(socket, userId, username, data.isTyping);
      }),
    );

    socket.on(
      "get rooms",
      safe(async () => {
        const data = Array.from(state.rooms.values())
          .filter((r) => r.type !== "private")
          .map((r) => formatRoomForSocket(r, socket));

        socket.emit("initial rooms", data);
        socket.emit("lobby ticker", { message: state.lobbyTicker || "" });
        socket.emit("maintenance status", { enabled: state.maintenance });

        if (socket.isDev) {
          const codes = {};
          for (const [roomId, room] of state.rooms) {
            if (room.type === "semi-private" && room.accessCode) {
              codes[roomId] = room.accessCode;
            }
          }
          socket.emit("dev lobby context", codes);
        }
      }),
    );

    socket.on(
      "get room state",
      safe(async (roomId) => {
        if (!roomId || typeof roomId !== "string")
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Room ID required."),
          );
        const room = state.rooms.get(roomId);
        if (!room)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
          );
        socket.emit("room state", formatRoomStateForSocket(room, socket));
      }),
    );

    // ── AFK Response ────────────────────────────────────────────────────
    socket.on(
      "afk response",
      safe(async () => {
        const userId = socket.handshake.session?.userId;
        if (userId && socket.roomId) setupAFKTimers(socket, userId);
      }),
    );

    // ── Disconnect ──────────────────────────────────────────────────────
    socket.on(
      "disconnect",
      safe(async (reason) => {
        const userId = socket.handshake.session?.userId;
        const username = socket.handshake.session?.username || "Unknown";
        const location = socket.handshake.session?.location || "Unknown";
        if (userId) {
          clearAFKTimers(userId);
          await leaveRoom(socket, userId);
          state.userMessageBuffers.delete(userId);
          state.devUsers.delete(userId);
          if (state.typingTimeouts.has(userId)) {
            clearTimeout(state.typingTimeouts.get(userId));
            state.typingTimeouts.delete(userId);
          }
          if (state.batchProcessingTimers.has(userId)) {
            clearTimeout(state.batchProcessingTimers.get(userId));
            state.batchProcessingTimers.delete(userId);
            state.pendingChatUpdates.delete(userId);
          }
          state.users.delete(userId);
        }
        releaseSlot(); // no-op when the dedicated listener already ran
        console.log(
          `Disconnected: "${username}" from "${location}" (${reason}) IP:${socket.clientIp}${socket.isBot ? " [BOT]" : ""}${socket.isDev ? " [DEV]" : ""}`,
        );
      }),
    );
  });
}

// ── Cleanup Intervals ───────────────────────────────────────────────────────

function startCleanupIntervals() {
  // Pressure cleanup (30s)
  setInterval(async () => {
    try {
      await pressureCleanup();
    } catch (err) {
      console.error("Pressure cleanup error:", err);
    }
  }, CONFIG.LIMITS.PRESSURE_CLEANUP_INTERVAL);

  // Bot detection cleanup (2 min)
  setInterval(() => {
    const now = Date.now();
    for (const [id, attempts] of state.userJoinAttempts.entries()) {
      const valid = attempts.filter(
        (t) => now - t < CONFIG.LIMITS.BOT_DETECTION_WINDOW,
      );
      if (valid.length === 0) state.userJoinAttempts.delete(id);
      else state.userJoinAttempts.set(id, valid);
    }
    for (const [ip, attempts] of state.ipJoinAttempts.entries()) {
      const valid = attempts.filter(
        (t) => now - t < CONFIG.LIMITS.BOT_DETECTION_WINDOW,
      );
      if (valid.length === 0) state.ipJoinAttempts.delete(ip);
      else state.ipJoinAttempts.set(ip, valid);
    }
    for (const [id, data] of state.suspiciousUsers.entries()) {
      if (now - data.firstDetection > CONFIG.TIMING.BOT_BLOCK_DURATION)
        state.suspiciousUsers.delete(id);
    }
  }, 120000);

  // Bot token cleanup (daily)
  setInterval(() => {
    const now = Date.now();
    let expired = 0;
    for (const [token, data] of state.botTokens.entries()) {
      if (now - data.createdAt > CONFIG.TIMING.BOT_TOKEN_EXPIRY) {
        state.botTokens.delete(token);
        expired++;
        const c = state.ipBotTokenCounts.get(data.ip) || 0;
        if (c > 1) state.ipBotTokenCounts.set(data.ip, c - 1);
        else state.ipBotTokenCounts.delete(data.ip);
      }
    }
    if (expired > 0) console.log(`Cleaned ${expired} expired bot tokens`);
  }, CONFIG.TIMING.BOT_TOKEN_CLEANUP_INTERVAL);

  // IP user cleanup (hourly)
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [ip, data] of state.ipBasedUsers.entries()) {
      if (now - data.lastSeen > CONFIG.LIMITS.IP_USER_CLEANUP_INTERVAL) {
        state.ipBasedUsers.delete(ip);
        cleaned++;
      }
    }
    if (cleaned > 0) console.log(`Cleaned ${cleaned} inactive IP users`);
  }, CONFIG.LIMITS.IP_USER_CLEANUP_INTERVAL);

  // Resource cleanup (5 min): drop buffers/timers for users no longer in rooms
  setInterval(() => {
    const active = new Set();
    for (const [, room] of state.rooms) {
      if (room.users) room.users.forEach((u) => active.add(u.id));
    }
    for (const id of state.userMessageBuffers.keys()) {
      if (!active.has(id)) state.userMessageBuffers.delete(id);
    }
    for (const id of state.typingTimeouts.keys()) {
      if (!active.has(id)) {
        clearTimeout(state.typingTimeouts.get(id));
        state.typingTimeouts.delete(id);
      }
    }
    for (const id of state.afkTimers.keys()) {
      if (!active.has(id)) clearAFKTimers(id);
    }
  }, 300000);

  // Cache cleanup (3 min)
  setInterval(() => {
    const active = new Set();
    for (const [, room] of state.rooms) {
      if (room.users) room.users.forEach((u) => active.add(u.id));
    }
    for (const id of state.batchProcessingTimers.keys()) {
      if (!active.has(id)) {
        clearTimeout(state.batchProcessingTimers.get(id));
        state.batchProcessingTimers.delete(id);
        state.pendingChatUpdates.delete(id);
      }
    }
    if (state.normalizeCache.size > 1000) {
      Array.from(state.normalizeCache.keys())
        .slice(0, 200)
        .forEach((k) => state.normalizeCache.delete(k));
    }
    const now = Date.now();
    for (const [k, v] of state.apiCache.entries()) {
      if (now - v.timestamp > state.API_CACHE_TTL) state.apiCache.delete(k);
    }
    for (const [ip, ts] of state.ipLastRoomCreation.entries()) {
      if (now - ts > 300000) state.ipLastRoomCreation.delete(ip);
    }
    for (const roomId of state.roomSoloSince.keys()) {
      if (!state.rooms.has(roomId)) state.roomSoloSince.delete(roomId);
    }
    for (const roomId of state.roomLastChatActivity.keys()) {
      if (!state.rooms.has(roomId)) state.roomLastChatActivity.delete(roomId);
    }
    for (const roomId of boardState.keys()) {
      if (!state.rooms.has(roomId)) boardState.delete(roomId);
    }
    for (const roomId of pianoState.keys()) {
      if (!state.rooms.has(roomId)) pianoState.delete(roomId);
    }
  }, 180000);

  // Empty room cleanup (10 min)
  setInterval(async () => {
    const now = Date.now();
    const toDelete = [];
    for (const [id, room] of state.rooms) {
      if (
        id !== MAIN_ROOM_ID &&
        (!room.users || room.users.length === 0) &&
        now - room.lastActiveTime > CONFIG.TIMING.ROOM_DELETION_TIMEOUT
      )
        toDelete.push(id);
    }
    for (const id of toDelete) {
      state.rooms.delete(id);
      state.roomSoloSince.delete(id);
      state.roomLastChatActivity.delete(id);
      cleanupBoardState(id);
      cleanupPianoState(id);
      if (state.roomDeletionTimers.has(id)) {
        clearTimeout(state.roomDeletionTimers.get(id));
        state.roomDeletionTimers.delete(id);
      }
    }
    if (toDelete.length > 0) {
      updateLobby();
      await debouncedSaveRooms();
      console.log(`Cleaned ${toDelete.length} empty rooms`);
    }
  }, 600000);

  // Per-IP connection count reconcile (30s).
  //
  // The count is taken in the connect middleware and given back on disconnect.
  // That pairing can still be broken by a client that vanishes in between: a
  // websocket upgrade that fails after the handshake, a request killed by an
  // extension or a proxy, a tab closed mid-connect. In those cases the socket
  // never reaches the connection handler, so nothing ever releases its count.
  // One stale count is invisible; MAX_CONNECTIONS_PER_IP of them lock that
  // address out of the site completely with "Too many connections", and only a
  // restart clears it.
  //
  // Rather than trying to enumerate every way that pairing can break, recount
  // from the sockets that actually exist. Any leak, from any cause, heals
  // within half a minute.
  setInterval(() => {
    if (!io()) return;
    const live = new Map();
    for (const [, s] of io().sockets.sockets) {
      const ip = s.clientIp;
      if (!ip) continue;
      live.set(ip, (live.get(ip) || 0) + 1);
    }
    // Report what was corrected. If the logs stay quiet the pairing is sound;
    // if they show counts drifting above the live socket count, that names the
    // leak and how fast it grows.
    let leaked = 0;
    let worst = null;
    for (const ip of [...state.ipConnections.keys()]) {
      const had = state.ipConnections.get(ip) || 0;
      const now = live.get(ip) || 0;
      if (had > now) {
        leaked += had - now;
        if (!worst || had - now > worst.by) worst = { ip, had, now, by: had - now };
      }
      if (!live.has(ip)) state.ipConnections.delete(ip);
    }
    for (const [ip, n] of live) state.ipConnections.set(ip, n);
    if (leaked)
      console.warn(
        `[conn] reclaimed ${leaked} stale connection slot(s); worst: ${worst.ip} counted ${worst.had} with ${worst.now} live`,
      );
  }, 30000);

  // Ghost user cleanup (1 min): removes room users with no live socket
  setInterval(() => {
    const activeIds = new Set();
    for (const [, s] of io().sockets.sockets) {
      const uid = s.handshake?.session?.userId;
      if (uid) activeIds.add(uid);
    }
    let ghostCount = 0;
    const affectedRooms = [];
    for (const [roomId, room] of state.rooms) {
      if (!room.users || room.users.length === 0) continue;
      const before = room.users.length;
      room.users = room.users.filter((u) => {
        if (!activeIds.has(u.id)) {
          console.log(`Ghost removed: "${u.username}" from "${room.name}"`);
          state.userMessageBuffers.delete(u.id);
          clearAFKTimers(u.id);
          state.devUsers.delete(u.id);
          finalizeBoardUserStroke(roomId, u.id);
          pianoDropPresence(roomId, u.id, true);
          if (state.typingTimeouts.has(u.id)) {
            clearTimeout(state.typingTimeouts.get(u.id));
            state.typingTimeouts.delete(u.id);
          }
          if (state.batchProcessingTimers.has(u.id)) {
            clearTimeout(state.batchProcessingTimers.get(u.id));
            state.batchProcessingTimers.delete(u.id);
            state.pendingChatUpdates.delete(u.id);
          }
          return false;
        }
        return true;
      });
      const removed = before - room.users.length;
      if (removed > 0) {
        ghostCount += removed;
        affectedRooms.push(roomId);
      }
    }
    for (const id of affectedRooms) {
      const r = state.rooms.get(id);
      if (r) {
        updateRoom(id);
        updateRoomSoloTracking(id);
        if (r.users.length === 0) startRoomDeletionTimer(id);
      }
    }
    if (ghostCount > 0) {
      console.log(`Ghost cleanup: removed ${ghostCount} ghost(s)`);
      updateLobby();
      debouncedSaveRooms().catch(() => { });
    }
  }, 60000);

  // Server monitor (2 min): status log and memory pressure relief
  setInterval(() => {
    const mem = process.memoryUsage();
    const stats = getRoomStatistics();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    console.log(
      `[STATUS] Clients:${io().sockets.sockets.size} ` +
      `Rooms:${stats.totalRooms}/${stats.hardCap} ` +
      `Healthy:${stats.healthyRooms}/${stats.currentLimit} ` +
      `Solo:${stats.soloRooms} TTL:${stats.currentSoloTTL}s ` +
      `Users:${stats.totalUsers} Heap:${heapMB}MB ` +
      `Tokens:${state.botTokens.size} ` +
      `Devs:${state.devUsers.size} ` +
      `Boards:${boardState.size}`,
    );
    if (heapMB > 400) {
      console.warn(`MEMORY WARNING: ${heapMB}MB heap`);
      if (heapMB > 500) {
        for (const [id, msg] of state.userMessageBuffers.entries()) {
          if (msg.length > 1000)
            state.userMessageBuffers.set(id, msg.substring(0, 1000));
        }
        state.normalizeCache.clear();
        state.apiCache.clear();
        if (global.gc) global.gc();
      }
    }
  }, 120000);
}

// ── Ghost Purge (Startup) ───────────────────────────────────────────────────

function purgeAllGhostUsers() {
  // A "ghost" is a room user with no live socket: a leftover from a room loaded
  // from disk, or a crash. Only those get purged. We must NOT blindly wipe room
  // users, because by the time this runs (a couple of seconds after boot)
  // clients have already reconnected and rejoined - wiping would kick the very
  // users we just let back in. Mirrors the 60s ghost cleanup in
  // startCleanupIntervals().
  const activeIds = new Set();
  for (const [, s] of io().sockets.sockets) {
    const uid = s.handshake?.session?.userId;
    if (uid) activeIds.add(uid);
  }
  let total = 0;
  const affected = [];
  for (const [roomId, room] of state.rooms) {
    if (!room.users || room.users.length === 0) continue;
    const before = room.users.length;
    room.users = room.users.filter((u) => {
      if (activeIds.has(u.id)) return true; // live socket -> a real user, keep
      state.userMessageBuffers.delete(u.id);
      clearAFKTimers(u.id);
      state.devUsers.delete(u.id);
      if (room.votes) {
        delete room.votes[u.id];
        for (const vid in room.votes)
          if (room.votes[vid] === u.id) delete room.votes[vid];
      }
      if (room.muteVotes) {
        delete room.muteVotes[u.id];
        for (const vid in room.muteVotes)
          if (room.muteVotes[vid] === u.id) delete room.muteVotes[vid];
      }
      room.mutedBotIds?.delete(u.id);
      console.log(`Startup purge: ghost "${u.username}" from "${room.name}"`);
      return false;
    });
    const removed = before - room.users.length;
    if (removed > 0) {
      total += removed;
      affected.push(roomId);
    }
  }
  for (const id of affected) {
    const r = state.rooms.get(id);
    if (!r) continue;
    r.lastActiveTime = Date.now();
    updateRoom(id);
    updateRoomSoloTracking(id);
    // Only tear down board state / arm the delete timer if the room is now
    // truly empty; a room with surviving live users keeps its board.
    if (r.users.length === 0) {
      cleanupBoardState(id);
      startRoomDeletionTimer(id);
    }
  }
  if (total > 0) {
    console.log(`Startup purge: removed ${total} ghost(s)`);
    updateLobby();
    debouncedSaveRooms().catch(() => { });
  } else console.log("Startup purge: no ghosts found");
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  loadRooms,
  saveRooms,
  loadBoard,
  saveBoardSync,
  debouncedSaveRooms,
  registerSocketHandlers,
  startCleanupIntervals,
  purgeAllGhostUsers,
  updateLobby,
  getRoomStatistics,
  calculateCurrentRoomLimit,
  roomNameExists,
  startRoomDeletionTimer,
  leaveRoom,
  joinRoom,
  roomCapacity,
  ensureMainRoom,
  MAIN_ROOM_ID,
};
