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
// This only works run on the same host as the container: it reads/writes
// files bind-mounted into the container (see BOT_CONFIG_PATH in
// talkomatic-bot/docker-compose.yml) and talks to the local docker daemon.
// HOMELAB_DIR overrides the homelab checkout location (default /opt/homelab,
// matching the deleted script's own default).

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function botsDir() {
  return path.join(process.env.HOMELAB_DIR || "/opt/homelab", "talkomatic-bot", "bots");
}

function requireRepo() {
  const dir = botsDir();
  if (!fs.existsSync(dir)) {
    return { ok: false, error: `${dir} not found (set HOMELAB_DIR to override)` };
  }
  return null;
}

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) return { ok: false, error: `Could not run docker: ${result.error.message}` };
  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

// First running container matching "talkomatic-bot*", used whenever none was
// given explicitly.
function defaultContainer() {
  const ps = docker(["ps", "--filter", "name=talkomatic-bot", "--format", "{{.Names}}"]);
  if (!ps.ok) return { error: ps.stderr || ps.error || "docker ps failed" };
  const names = ps.stdout.split("\n").filter(Boolean).sort();
  if (!names.length) return { error: "no running talkomatic-bot container found (pass one explicitly)" };
  return { name: names[0] };
}

// Resolves a name/ID/default to the container's canonical name, so
// bots/active/ is always keyed the same way BOT_CONFIG_PATH expects
// regardless of what identified the container on the command line - passing
// a container ID would otherwise write an active file the running bot never
// reads, silently reporting success while doing nothing.
function canonicalName(container) {
  const result = docker(["inspect", "-f", "{{.Name}}", container]);
  if (!result.ok) return null;
  return result.stdout.replace(/^\//, "");
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

function status(container) {
  const err = requireRepo();
  if (err) return err;

  let target = container;
  if (!target) {
    const d = defaultContainer();
    if (d.error) return { ok: false, error: d.error };
    target = d.name;
  }
  const canonical = canonicalName(target);
  if (!canonical) return { ok: false, error: `no such container: ${target}` };

  const active = path.join(botsDir(), "active", `${canonical}.env`);
  if (!fs.existsSync(active)) {
    return { ok: true, stdout: `no profile loaded for '${canonical}' (running on .env defaults)\n` };
  }
  const firstLine = fs.readFileSync(active, "utf8").split("\n")[0] || "";
  return { ok: true, stdout: firstLine.replace(/^# /, "") + "\n" };
}

function load(profile, container) {
  const err = requireRepo();
  if (err) return err;
  if (!profile) return { ok: false, error: "load needs a profile name." };

  const src = path.join(botsDir(), `${profile}.env`);
  if (!fs.existsSync(src)) return { ok: false, error: `no such profile: ${profile} (${src})` };

  let target = container;
  if (!target) {
    const d = defaultContainer();
    if (d.error) return { ok: false, error: d.error };
    target = d.name;
  }

  // One inspect for both the running-state check and the canonical name -
  // querying them separately would mean two subprocess round trips to
  // resolve the same container.
  const inspect = docker(["inspect", "-f", "{{.State.Running}}\t{{.Name}}", target]);
  if (!inspect.ok) return { ok: false, error: `no such container: ${target}` };
  const [running, name] = inspect.stdout.split("\t");
  if (running !== "true") return { ok: false, error: `container '${target}' is not running` };
  const canonical = name.replace(/^\//, "");

  const activeDir = path.join(botsDir(), "active");
  fs.mkdirSync(activeDir, { recursive: true });
  const active = path.join(activeDir, `${canonical}.env`);
  const tmp = `${active}.tmp`;
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const header = `# profile: ${profile} (loaded ${timestamp} by tools/ops.js)\n`;
  fs.writeFileSync(tmp, header + fs.readFileSync(src, "utf8"));
  fs.renameSync(tmp, active);

  const kill = docker(["kill", "-s", "HUP", target]);
  if (!kill.ok) return { ok: false, error: kill.stderr || `docker kill failed for ${target}` };

  return { ok: true, stdout: `loaded '${profile}' onto '${canonical}'\n` };
}

module.exports = { list, status, load };
