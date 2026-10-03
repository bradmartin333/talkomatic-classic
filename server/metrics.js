// server/metrics.js
// Prometheus text-format metrics for /metrics (see server.js). Hand-rolled
// rather than pulling in prom-client: a dozen numbers don't need a library.
//
// Counters live only in memory and restart from zero with the process, which
// Prometheus's rate()/increase() already expect.

const counters = {
  logins: { success: 0, failure: 0 },
  // Every "chat update" a client sends - one per keystroke-sized edit, since
  // Talkomatic streams typing as it happens - so this tracks how much talking
  // is going on rather than a count of finished messages.
  chatUpdates: 0,
  roomJoins: 0,
};

function countLogin(ok) {
  counters.logins[ok ? "success" : "failure"]++;
}

// Installed on each socket so incoming events are counted before any handler
// (or rate limiter) sees them.
function countSocketEvent(event) {
  if (event === "chat update") counters.chatUpdates++;
  else if (event === "join room") counters.roomJoins++;
}

function line(name, help, type, samples) {
  const out = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const [labels, value] of samples)
    out.push(`${name}${labels} ${Number.isFinite(value) ? value : 0}`);
  return out.join("\n");
}

// `live` is read at scrape time: { sockets, usersInRooms, rooms, accounts,
// signedInBrowsers }.
function render(live) {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return (
    [
      line("talkomatic_sockets_connected", "Open Socket.IO connections.", "gauge", [["", live.sockets]]),
      line("talkomatic_users_in_rooms", "Seats taken across all rooms.", "gauge", [["", live.usersInRooms]]),
      line("talkomatic_rooms", "Rooms that exist right now.", "gauge", [["", live.rooms]]),
      line("talkomatic_accounts", "Login accounts.", "gauge", [["", live.accounts]]),
      line("talkomatic_signed_in_browsers", "Unexpired login sessions.", "gauge", [["", live.signedInBrowsers]]),
      line("talkomatic_logins_total", "Login attempts by outcome.", "counter", [
        ['{result="success"}', counters.logins.success],
        ['{result="failure"}', counters.logins.failure],
      ]),
      line("talkomatic_chat_updates_total", "Typing updates sent by clients.", "counter", [["", counters.chatUpdates]]),
      line("talkomatic_room_joins_total", "Room join requests.", "counter", [["", counters.roomJoins]]),
      line("process_resident_memory_bytes", "Resident memory size in bytes.", "gauge", [["", mem.rss]]),
      line("process_cpu_seconds_total", "User and system CPU time in seconds.", "counter", [
        ["", (cpu.user + cpu.system) / 1e6],
      ]),
      line("process_start_time_seconds", "Process start time, Unix seconds.", "gauge", [
        ["", Math.round(Date.now() / 1000 - process.uptime())],
      ]),
    ].join("\n") + "\n"
  );
}

module.exports = { countLogin, countSocketEvent, render };
