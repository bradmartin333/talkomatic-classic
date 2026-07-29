// server/datadir.js
// Where runtime JSON stores are written. Defaults to the repo root (historic
// behavior for plain `npm start`). Set DATA_DIR (Docker uses /app/data) to
// keep state on a mounted volume that survives redeploys.
const path = require("path");
const fs = require("fs");

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..");

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error("Could not create DATA_DIR:", DATA_DIR, e.message);
}

module.exports = { DATA_DIR };
