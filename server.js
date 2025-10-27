// server.js
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const Twilio = require('twilio');
require('dotenv').config();

const app = express();
const httpServer = createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json());

// --- Twilio ICE (/ice) -------------------------------------------------------
const twilio = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
app.get('/ice', async (req, res) => {
  try {
    const token = await twilio.tokens.create({ ttl: 3600 }); // 1 hour
    res.json({ iceServers: token.iceServers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Simple in-memory host registry -----------------------------------------
const { randomUUID } = require('crypto');

function newRoomCode() {
  return 'r_' + Math.random().toString(36).slice(2, 8);
}

/**
 * hosts: Map<hostId, {
 *   hostId: string,
 *   room: string,
 *   busy: boolean,
 *   registeredAt: number (ms),
 *   lastSeen: number (ms)
 * }>
 */
const hosts = new Map();

function counts() {
  const total = hosts.size;
  let busy = 0;
  for (const h of hosts.values()) if (h.busy) busy++;
  return { total, busy, avail: total - busy };
}

function logAvailability(prefix) {
  const { total, busy, avail } = counts();
  console.log(`${prefix} - ${avail}/${total} hosts currently available`);
}

// --- Host endpoints ----------------------------------------------------------

/**
 * Host registers itself and receives a dedicated room.
 * Body: { tag?: string } (optional metadata)
 * Returns: { hostId, room }
 */
app.post('/hosts/register', (req, res) => {
  const hostId = randomUUID();
  const room = newRoomCode();
  const now = Date.now();

  hosts.set(hostId, {
    hostId,
    room,
    busy: false,
    registeredAt: now,
    lastSeen: now
  });

  logAvailability('Host connected');

  res.json({ hostId, room });
});

/**
 * Host heartbeat to keep itself from expiring.
 * Body: { hostId }
 */
app.post('/hosts/heartbeat', (req, res) => {
  const { hostId } = req.body || {};
  const h = hostId && hosts.get(hostId);
  if (!h) return res.status(404).json({ error: 'host_not_found' });
  h.lastSeen = Date.now();
  return res.json({ ok: true });
});

/**
 * Host marks itself available again after finishing a client session.
 * Body: { hostId }
 */
app.post('/hosts/release', (req, res) => {
  const { hostId } = req.body || {};
  const h = hostId && hosts.get(hostId);
  if (!h) return res.status(404).json({ error: 'host_not_found' });
  h.busy = false;
  h.lastSeen = Date.now();
  logAvailability('Host released');
  return res.json({ ok: true });
});

/**
 * Host unregisters on shutdown.
 * Body: { hostId }
 */
app.post('/hosts/unregister', (req, res) => {
  const { hostId } = req.body || {};
  if (hostId && hosts.has(hostId)) hosts.delete(hostId);
  logAvailability('Host disconnected');
  return res.json({ ok: true });
});

// --- User endpoint -----------------------------------------------------------

/**
 * User requests a host. Server assigns the first available (not busy) host.
 * Returns 200 { room, hostId } or 503 { error:"no_hosts" }
 * Logs:
 *  - "User connected - A/B hosts currently available"
 *  - or "WARNING: User rejected - all hosts ((B)) occupied!"
 */
app.post('/users/claim', (req, res) => {
  // Pick first available host
  let chosen = null;
  for (const h of hosts.values()) {
    if (!h.busy) { chosen = h; break; }
  }

  const { total, busy, avail } = counts();

  if (!chosen) {
    console.warn(`WARNING: User rejected - all hosts ((${total})) occupied!`);
    return res.status(503).json({ error: 'no_hosts' });
  }

  chosen.busy = true;
  chosen.lastSeen = Date.now();

  // After assigning, log with the updated availability
  const after = counts();
  console.log(`User connected - ${after.avail}/${after.total} hosts currently available`);

  return res.json({ room: chosen.room, hostId: chosen.hostId });
});

// --- Housekeeping: purge dead hosts (stopped heartbeating) -------------------
const HOST_TTL_MS = 5 * 60 * 1000; // 5 minutes without heartbeat → remove
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [id, h] of hosts.entries()) {
    if (now - h.lastSeen > HOST_TTL_MS) { hosts.delete(id); removed++; }
  }
  if (removed > 0) logAvailability(`Purged ${removed} stale host(s)`);
}, 60 * 1000);

// --- Health ------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true, hosts: counts() }));

// --- Start -------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Matcher + /ice listening on :${PORT}`);
});