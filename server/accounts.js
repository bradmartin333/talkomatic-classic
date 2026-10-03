// server/accounts.js
// The login gate's user list. Accounts are handed out by the operator (see
// `npm run ops -- adduser`); there is no sign-up. A successful login trades
// the password for a random token kept in a long-lived cookie, so the gate is
// a single map lookup per request and a password change can sign someone out
// everywhere just by dropping their tokens.
//
// The server is the only writer of accounts.json - the ops tool goes through
// the loopback /operator/accounts routes - so the in-memory copy is always the
// truth and there is no cross-process locking to get wrong.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "accounts.json");
const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const NAME_RE = /^[a-z0-9_-]{1,30}$/;
const MIN_PASSWORD = 4;

// { users: { name: { hash, created } }, tokens: { token: { name, expires } } }
let store = { users: {}, tokens: {} };

function load() {
  try {
    const obj = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    store = {
      users: (obj && obj.users) || {},
      tokens: (obj && obj.tokens) || {},
    };
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading accounts.json:", err);
  }
}

// Writes are rare (a login, an operator command), so a synchronous atomic
// write keeps this simple: nothing is ever acknowledged before it is on disk.
function save() {
  const now = Date.now();
  for (const [t, rec] of Object.entries(store.tokens))
    if (rec.expires < now || !store.users[rec.name]) delete store.tokens[t];
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

function normName(name) {
  return String(name || "").trim().toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

// A made-up hash checked against when the name is unknown, so a wrong name
// costs the same time as a wrong password and the response time does not
// reveal which accounts exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

function checkHash(stored, password) {
  const [scheme, saltHex, hashHex] = String(stored).split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, "hex");
  const got = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), want.length);
  return crypto.timingSafeEqual(want, got);
}

// Returns a fresh session token on success, null otherwise.
function login(name, password) {
  const n = normName(name);
  const user = Object.prototype.hasOwnProperty.call(store.users, n)
    ? store.users[n]
    : null;
  const ok = checkHash(user ? user.hash : DUMMY_HASH, password);
  if (!user || !ok) return null;
  const token = crypto.randomBytes(32).toString("hex");
  store.tokens[token] = { name: n, expires: Date.now() + TOKEN_TTL_MS };
  save();
  return token;
}

function logout(token) {
  if (typeof token === "string" && store.tokens[token]) {
    delete store.tokens[token];
    save();
  }
}

// The account name a cookie token belongs to, or null.
function userForToken(token) {
  if (typeof token !== "string" || !token) return null;
  const rec = Object.prototype.hasOwnProperty.call(store.tokens, token)
    ? store.tokens[token]
    : null;
  if (!rec || rec.expires < Date.now() || !store.users[rec.name]) return null;
  return rec.name;
}

function dropTokens(name) {
  for (const [t, rec] of Object.entries(store.tokens))
    if (rec.name === name) delete store.tokens[t];
}

// ── Operator commands ── each returns { ok, error? } for the ops tool.

function validate(name, password) {
  if (!NAME_RE.test(name))
    return "Names are 1-30 characters: letters, digits, - and _.";
  if (password !== undefined && String(password).length < MIN_PASSWORD)
    return `Passwords need at least ${MIN_PASSWORD} characters.`;
  return null;
}

function addUser(name, password) {
  const n = normName(name);
  const error = validate(n, password);
  if (error) return { ok: false, error };
  if (store.users[n]) return { ok: false, error: `${n} already exists.` };
  store.users[n] = { hash: hashPassword(password), created: Date.now() };
  save();
  return { ok: true, name: n };
}

function setPassword(name, password) {
  const n = normName(name);
  const error = validate(n, password);
  if (error) return { ok: false, error };
  if (!store.users[n]) return { ok: false, error: `No user named ${n}.` };
  store.users[n].hash = hashPassword(password);
  dropTokens(n);
  save();
  return { ok: true, name: n };
}

function deleteUser(name) {
  const n = normName(name);
  if (!store.users[n]) return { ok: false, error: `No user named ${n}.` };
  delete store.users[n];
  dropTokens(n);
  save();
  return { ok: true, name: n };
}

function listUsers() {
  const now = Date.now();
  const sessions = {};
  for (const rec of Object.values(store.tokens))
    if (rec.expires >= now) sessions[rec.name] = (sessions[rec.name] || 0) + 1;
  return Object.keys(store.users)
    .sort()
    .map((name) => ({
      name,
      created: store.users[name].created || 0,
      sessions: sessions[name] || 0,
    }));
}

load();

module.exports = {
  TOKEN_TTL_MS,
  login,
  logout,
  userForToken,
  addUser,
  setPassword,
  deleteUser,
  listUsers,
};
