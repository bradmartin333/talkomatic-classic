// Bot persona control: hot-swap talkomatic-bot personas on a running
// container without a restart. Ported directly from the old
// homelab/scripts/bot-ctl.sh (deleted - its docker/file logic was small
// enough to just do here instead of shelling out to a script that lived in a
// separate repo).
//
// Profiles live as drop-in files in <HOMELAB_DIR>/talkomatic-bot/bots/*.env
// (see that folder's README.md). Loading one copies it into the target
// container's active-config slot and sends it SIGHUP, which the bot process
// picks up live - no restart, no rebuild.
//
// Talks to the Docker Engine API directly over /var/run/docker.sock (see
// dockerApi below) rather than shelling out to a `docker` binary, which the
// image doesn't carry. That means this only works from a container that has
// both that socket and the bots directory bind-mounted in - how such a
// container is wired up (and whether it shares talkomatic's network
// namespace, needed for list/kick/capacity to keep working there too) is
// deployment-specific.
// HOMELAB_DIR overrides the homelab checkout location (default /opt/homelab,
// matching the deleted script's own default) - keep it in sync with whatever
// path the bots directory is mounted at.

const http = require("http");
const fs = require("fs");
const path = require("path");

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";

function botsDir() {
  return path.join(process.env.HOMELAB_DIR || "/opt/homelab", "talkomatic-bot", "bots");
}

function requireRepo() {
  const dir = botsDir();
  if (!fs.existsSync(dir)) {
    return {
      ok: false,
      error: `${dir} not found - mount it into this container, or set HOMELAB_DIR to override`,
    };
  }
  return null;
}

// Docker Engine API request. Unversioned path: the daemon serves whatever its
// highest supported API version is when none is given, which is all three
// calls below need. Some endpoints (kill) reply with an empty body on
// success, so a JSON parse failure there isn't an error.
function dockerApi(method, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, path: reqPath, method }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let body = null;
        try {
          body = data ? JSON.parse(data) : null;
        } catch (_) {
          // empty/non-JSON body on success (e.g. kill) - leave body null.
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body });
      });
    });
    req.on("error", (e) =>
      reject(
        new Error(
          `Could not reach the Docker daemon at ${DOCKER_SOCKET} (${e.code || e.message}). ` +
            "Is docker.sock bind-mounted into this container?",
        ),
      ),
    );
    req.end();
  });
}

// First running container whose name contains "talkomatic-bot", used
// whenever none was given explicitly. Substring match (not anchored) to match
// the old `docker ps --filter name=talkomatic-bot` behavior.
async function defaultContainer() {
  const res = await dockerApi("GET", "/containers/json");
  if (!res.ok) return { error: `docker ps failed (HTTP ${res.status})` };
  const names = (res.body || [])
    .flatMap((c) => c.Names || [])
    .map((n) => n.replace(/^\//, ""))
    .filter((n) => n.includes("talkomatic-bot"))
    .sort();
  if (!names.length) return { error: "no running talkomatic-bot container found (pass one explicitly)" };
  return { name: names[0] };
}

// Resolves a name/ID/default to the container's canonical name, so
// bots/active/ is always keyed the same way BOT_CONFIG_PATH expects
// regardless of what identified the container on the command line - passing
// a container ID would otherwise write an active file the running bot never
// reads, silently reporting success while doing nothing.
async function canonicalName(container) {
  const res = await dockerApi("GET", `/containers/${encodeURIComponent(container)}/json`);
  if (!res.ok || !res.body) return null;
  return res.body.Name.replace(/^\//, "");
}

function list() {
  const err = requireRepo();
  if (err) return err;
  const dir = botsDir();
  const names = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".env"))
    .map((f) => f.slice(0, -".env".length))
    .sort();
  if (!names.length) return { ok: true, stderr: `no profiles found in ${dir}\n` };
  return { ok: true, stdout: names.join("\n") + "\n" };
}

async function status(container) {
  const err = requireRepo();
  if (err) return err;

  let target = container;
  if (!target) {
    const d = await defaultContainer();
    if (d.error) return { ok: false, error: d.error };
    target = d.name;
  }
  const canonical = await canonicalName(target);
  if (!canonical) return { ok: false, error: `no such container: ${target}` };

  const active = path.join(botsDir(), "active", `${canonical}.env`);
  if (!fs.existsSync(active)) {
    return { ok: true, stdout: `no profile loaded for '${canonical}' (running on .env defaults)\n` };
  }
  const firstLine = fs.readFileSync(active, "utf8").split("\n")[0] || "";
  return { ok: true, stdout: firstLine.replace(/^# /, "") + "\n" };
}

async function load(profile, container) {
  const err = requireRepo();
  if (err) return err;
  if (!profile) return { ok: false, error: "load needs a profile name." };

  const src = path.join(botsDir(), `${profile}.env`);
  if (!fs.existsSync(src)) return { ok: false, error: `no such profile: ${profile} (${src})` };

  let target = container;
  if (!target) {
    const d = await defaultContainer();
    if (d.error) return { ok: false, error: d.error };
    target = d.name;
  }

  // One inspect for both the running-state check and the canonical name -
  // querying them separately would mean two round trips to resolve the same
  // container.
  const inspect = await dockerApi("GET", `/containers/${encodeURIComponent(target)}/json`);
  if (!inspect.ok || !inspect.body) return { ok: false, error: `no such container: ${target}` };
  if (!inspect.body.State?.Running) return { ok: false, error: `container '${target}' is not running` };
  const canonical = inspect.body.Name.replace(/^\//, "");

  const activeDir = path.join(botsDir(), "active");
  fs.mkdirSync(activeDir, { recursive: true });
  const active = path.join(activeDir, `${canonical}.env`);
  const tmp = `${active}.tmp`;
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const header = `# profile: ${profile} (loaded ${timestamp} by tools/ops.js)\n`;
  fs.writeFileSync(tmp, header + fs.readFileSync(src, "utf8"));
  fs.renameSync(tmp, active);

  const kill = await dockerApi("POST", `/containers/${encodeURIComponent(target)}/kill?signal=HUP`);
  if (!kill.ok) return { ok: false, error: `docker kill failed for ${target} (HTTP ${kill.status})` };

  return { ok: true, stdout: `loaded '${profile}' onto '${canonical}'\n` };
}

module.exports = { list, status, load };
