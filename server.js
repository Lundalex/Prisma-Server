const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const Twilio = require('twilio');
require('dotenv').config();

const app = express();
const httpServer = createServer(app);
app.use(cors({ origin: '*' }));
app.use(express.json());

// ---------- Twilio ICE ----------
const twilio = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
app.get('/ice', async (req, res) => {
  try {
    const token = await twilio.tokens.create({ ttl: 3600 });
    res.json({ iceServers: token.iceServers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Registry ----------
const hosts = new Map();   // hostKey -> { hostKey, room, busy, registeredAt, lastSeen }
const sessions = new Map();// room    -> hostKey

function newRoomCode() { return 'r_' + Math.random().toString(36).slice(2, 8); }
function counts() {
  const total = hosts.size; let busy = 0; for (const h of hosts.values()) if (h.busy) busy++;
  return { total, busy, avail: total - busy };
}
function logAvailability(prefix) {
  const { total, avail } = counts();
  console.log(`${prefix} - ${avail}/${total} hosts currently available`);
}

// ---------- Host endpoints ----------
// Body: { hostKey?: string } – hostKey is a stable id persisted by the host app
app.post('/hosts/register', (req, res) => {
  const now = Date.now();
  const hostKey = (req.body && req.body.hostKey) || null;

  // If we have a stable key and it already exists: replace (prevents duplicates on restart)
  if (hostKey && hosts.has(hostKey)) {
    const prev = hosts.get(hostKey);
    // drop any old session using previous room
    for (const [room, hid] of sessions.entries()) if (hid === hostKey) sessions.delete(room);
    const room = newRoomCode();
    hosts.set(hostKey, { hostKey, room, busy: false, registeredAt: prev.registeredAt, lastSeen: now });
    logAvailability('Host connected');
    return res.json({ hostId: hostKey, room });
  }

  // No key provided: create one and return it
  const newKey = hostKey || ('hk_' + Math.random().toString(36).slice(2, 12));
  const room = newRoomCode();
  hosts.set(newKey, { hostKey: newKey, room, busy: false, registeredAt: now, lastSeen: now });
  logAvailability('Host connected');
  res.json({ hostId: newKey, room });
});

// Body: { hostKey }
app.post('/hosts/heartbeat', (req, res) => {
  const { hostKey } = req.body || {};
  console.log('Heartbeat recieved');
  const h = hostKey && hosts.get(hostKey);
  if (!h) return res.status(404).json({ error: 'host_not_found' });
  h.lastSeen = Date.now();
  res.json({ ok: true });
});

// Body: { hostKey }
app.post('/hosts/release', (req, res) => {
  const { hostKey } = req.body || {};
  const h = hostKey && hosts.get(hostKey);
  if (!h) return res.status(404).json({ error: 'host_not_found' });
  // clear sessions for this host
  for (const [room, hid] of sessions.entries()) if (hid === hostKey) sessions.delete(room);
  h.busy = false; h.lastSeen = Date.now();
  logAvailability('Host released');
  res.json({ ok: true });
});

// Body: { hostKey }
app.post('/hosts/unregister', (req, res) => {
  const { hostKey } = req.body || {};
  if (hostKey && hosts.has(hostKey)) {
    for (const [room, hid] of sessions.entries()) if (hid === hostKey) sessions.delete(room);
    hosts.delete(hostKey);
  }
  logAvailability('Host disconnected');
  res.json({ ok: true });
});

// ---------- User endpoints ----------
// Claim first available host
app.post('/users/claim', (req, res) => {
  let chosen = null;
  for (const h of hosts.values()) { if (!h.busy) { chosen = h; break; } }
  const { total } = counts();
  if (!chosen) {
    console.warn(`WARNING: User rejected - all hosts ((${total})) occupied!`);
    return res.status(503).json({ error: 'no_hosts' });
  }
  chosen.busy = true; chosen.lastSeen = Date.now();
  sessions.set(chosen.room, chosen.hostKey);
  const after = counts();
  console.log(`User connected - ${after.avail}/${after.total} hosts currently available`);
  res.json({ room: chosen.room, hostId: chosen.hostKey });
});

// Optional: user explicitly ends session (frees host immediately)
// Body: { room?: string, hostId?: string }
app.post('/users/leave', (req, res) => {
  const { room, hostId } = req.body || {};
  let key = hostId || (room && sessions.get(room));
  const h = key && hosts.get(key);
  if (!h) return res.status(404).json({ error: 'host_not_found' });
  if (room) sessions.delete(room);
  h.busy = false; h.lastSeen = Date.now();
  logAvailability('User ended');
  res.json({ ok: true });
});

// ---------- Cleanup ----------
const HEARTBEAT_SECS = 5;           // matches client default
const HOST_TTL_MS = HEARTBEAT_SECS * 1000 * 4; // ~20s: 4 heartbeats
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [key, h] of hosts.entries()) {
    if (now - h.lastSeen > HOST_TTL_MS) {
      for (const [room, hid] of sessions.entries()) if (hid === key) sessions.delete(room);
      hosts.delete(key); removed++;
    }
  }
  if (removed > 0) logAvailability(`Purged ${removed} stale host(s)`);
}, 60 * 1000);

// ---------- Health & Start ----------
app.get('/health', (_req, res) => res.json({ ok: true, hosts: counts() }));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Matcher + /ice listening on :${PORT}`);
  logAvailability('Server started');
});