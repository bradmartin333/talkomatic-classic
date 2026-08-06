// server/keywatch.js
// One staff key, one person. This watches for a key being held by two
// different people at the same moment and says so plainly.
//
// The hard part is not spotting two connections - staff open several all the
// time - it is spotting two PEOPLE without accusing one person of being two.
// Three things get confused for sharing and none of them are:
//
//  - Several sockets from one browser. Joining a room alone opens two, and the
//    dashboard, the Desk and a room tab are three more.
//  - An address that changes. IPv6 privacy addresses rotate within the same
//    /64 constantly, and phones hop between mobile data and wifi. So addresses
//    are compared as NETWORKS (/64 or /24), never as exact addresses, and a
//    changed network on its own is never treated as a second person.
//  - A moment of overlap. A reconnect, a page navigation, or the room handoff
//    leaves the old socket alive for a second or two while the new one starts.
//
// So the rule is deliberately narrow: two different CLIENT IDENTIFIERS, on two
// different NETWORKS, both live, both settled. That is a second browser on a
// second connection - which is a second person - and it is the one shape none
// of the innocent cases above can produce.

const SETTLE_MS = 20000; // how long an overlap must last before it counts

// hash -> Map(socketId -> { deviceId, network, userId, since })
const live = new Map();
// Keys already actioned, so a dozen sockets do not fire a dozen revokes.
const handled = new Set();

function join(hash, socketId, info) {
  if (!hash || !socketId) return;
  let group = live.get(hash);
  if (!group) live.set(hash, (group = new Map()));
  group.set(socketId, {
    deviceId: info.deviceId || null,
    network: info.network || null,
    userId: info.userId || null,
    since: Date.now(),
  });
}

function leave(hash, socketId) {
  const group = live.get(hash);
  if (!group) return;
  group.delete(socketId);
  if (!group.size) {
    live.delete(hash);
    handled.delete(hash);
  }
}

// Everyone currently on this key, one entry per identity rather than per
// socket - the count that matters is people, not tabs.
function holders(hash) {
  const group = live.get(hash);
  if (!group) return [];
  const by = new Map(); // deviceId (or userId) -> holder
  for (const [socketId, s] of group) {
    // No client identifier means no evidence either way, so it never counts
    // as a second holder. A missing id must never be a reason to revoke.
    const key = s.deviceId || s.userId;
    if (!key) continue;
    let h = by.get(key);
    if (!h) by.set(key, (h = { key, networks: new Set(), since: s.since, sockets: 0 }));
    h.sockets++;
    h.since = Math.min(h.since, s.since);
    if (s.network) h.networks.add(s.network);
  }
  return [...by.values()];
}

// The verdict for a key right now.
//   null      - one person, or not enough evidence
//   "watch"   - two identities, but on the same network. Their own second
//               browser, most likely. Worth saying, not worth revoking.
//   "shared"  - two identities on two networks, both settled. Two people.
function verdict(hash, now) {
  const at = now || Date.now();
  const list = holders(hash).filter((h) => at - h.since >= SETTLE_MS);
  if (list.length < 2) return null;
  const networks = new Set();
  for (const h of list) for (const n of h.networks) networks.add(n);
  // A holder whose network is unknown cannot be placed, so it cannot be the
  // one that proves a second location.
  if (networks.size < 2) return "watch";
  return "shared";
}

// Everything the alert needs to say who is where, without inventing detail.
function summary(hash) {
  return holders(hash).map((h) => ({
    id: h.key,
    sockets: h.sockets,
    networks: [...h.networks],
    since: h.since,
  }));
}

const markHandled = (hash) => handled.add(hash);
const wasHandled = (hash) => handled.has(hash);

module.exports = {
  join,
  leave,
  holders,
  verdict,
  summary,
  markHandled,
  wasHandled,
  SETTLE_MS,
};
