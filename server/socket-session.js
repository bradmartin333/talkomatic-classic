// server/socket-session.js
// Shares the express-session with socket.io: loads the session once at
// connect onto socket.handshake.session / socket.handshake.sessionID, then
// after each incoming event saves it if the handler changed it.
//
// A direct port of express-socket.io-session 1.3.5 (unmaintained; it pulled in
// cookie-parser 1.3 / cookie 0.1.3). Dropped its cookie-parser step:
// express-session reads the Cookie header itself.
//
// Why not socket.io's own io.engine.use(sessionMiddleware): that runs on the
// real upgrade response, so express-session (saveUninitialized) would write a
// fresh session file for every connection, including loopback and signed-out
// ones that never use it. Here the response is a stub that is never ended,
// so nothing is written unless a handler changes the session.

const crypto = require("crypto");

// Hash of the session minus .cookie (its expiry moves on every touch), to
// tell whether a handler actually changed anything.
function hash(sess) {
  const json = JSON.stringify(sess, (key, val) =>
    key === "cookie" ? undefined : val,
  );
  return crypto
    .createHash("sha1")
    .update(json || "")
    .digest("hex");
}

function socketSession(sessionMiddleware) {
  return (socket, next) => {
    const req = socket.handshake;
    // express-session wraps res.end to save; nobody calls it, so loading the
    // session at connect never writes one.
    const res = { end() {} };

    // Save after each event if the session changed. Patches socket.onevent
    // (as the original did) rather than socket.use, because a socket.use
    // middleware runs before the handler and can't see what it changed.
    // socket.io runs the handler on a nextTick queued during onevent, ahead
    // of the check queued here, only when every socket.use middleware calls
    // next synchronously. server.js's per-socket rate limiter is a promise,
    // so for every event it doesn't exempt the handler runs after this check
    // and the auto-save sees nothing. Same as the original. In practice,
    // handlers save explicitly (promisifySessionSave / session.save in
    // rooms.js), and that is what keeps sessions on disk.
    const onevent = socket.onevent;
    socket.onevent = function (...args) {
      const before = req.session ? hash(req.session) : null;
      const idBefore = req.sessionID;
      onevent.apply(socket, args);
      process.nextTick(() => {
        const sess = req.session;
        if (!sess || typeof req.sessionID !== "string") return;
        if (req.sessionID !== idBefore || hash(sess) !== before) {
          sess.touch();
          sess.save();
        }
      });
    };

    // A session-store error doesn't refuse the connection (the original
    // didn't either); failing here would lock someone out until their
    // cookie expired over one bad session file.
    sessionMiddleware(req, res, (err) => {
      if (err) console.error("socket session load failed:", err.message);
      next();
    });
  };
}

module.exports = { socketSession };
