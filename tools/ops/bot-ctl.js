// Thin wrapper around homelab/scripts/bot-ctl.sh (a separate repo) for
// hot-swapping a running talkomatic-bot container's persona. Never
// reimplements its docker/container-name logic here - always shells out and
// passes its stdout/stderr straight through, so bot-ctl.sh stays the single
// source of truth for that logic.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function resolvePath() {
  return (
    process.env.BOT_CTL_PATH ||
    path.join(process.env.HOMELAB_DIR || "/opt/homelab", "scripts", "bot-ctl.sh")
  );
}

function run(args) {
  const scriptPath = resolvePath();
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      error:
        `bot-ctl.sh not found at ${scriptPath}. Set HOMELAB_DIR (or BOT_CTL_PATH) ` +
        "to point at the homelab checkout.",
    };
  }
  const result = spawnSync(scriptPath, args, { encoding: "utf8" });
  if (result.error) {
    return { ok: false, error: `Could not run ${scriptPath}: ${result.error.message}` };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.status === 0 ? null : (result.stderr || "").trim() || `exited ${result.status}`,
  };
}

const list = () => run(["list"]);
const status = (container) => run(container ? ["status", container] : ["status"]);
const load = (profile, container) =>
  run(container ? ["load", profile, container] : ["load", profile]);

module.exports = { resolvePath, list, status, load };
