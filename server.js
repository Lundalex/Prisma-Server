import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import 'dotenv/config';
import Twilio from 'twilio';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
const twilio = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// 1) Short-lived TURN/STUN for WebRTC (host & clients call this)
app.get('/ice', async (req, res) => {
  try {
    // TTL in seconds. Keep short (30–120 mins). 24h is the absolute max. 
    const token = await twilio.tokens.create({ ttl: 3600 }); 
    res.json({ iceServers: token.iceServers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// In-memory presence (use Redis for production)
const rooms = new Map(); // roomId -> { hostSocketId }

io.on('connection', (socket) => {
  // Host announces itself
  socket.on('host:join', ({ roomId }) => {
    rooms.set(roomId, { hostSocketId: socket.id });
    socket.join(roomId);
    socket.data = { role: 'host', roomId };
    io.to(roomId).emit('host:online', { hostId: socket.id });
  });

  // Client wants to join a room
  socket.on('client:join', ({ roomId }) => {
    socket.join(roomId);
    socket.data = { role: 'client', roomId };
    // Notify host to start negotiation with this client
    const host = rooms.get(roomId)?.hostSocketId;
    if (host) io.to(host).emit('client:ready', { clientId: socket.id });
    else socket.emit('host:offline');
  });

  // SDP/ICE relay
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    const role = socket.data?.role;
    const roomId = socket.data?.roomId;
    if (role === 'host') {
      rooms.delete(roomId);
      io.to(roomId).emit('host:offline');
    }
  });
});

httpServer.listen(process.env.PORT || 3000, () =>
  console.log(`Signaling + /ice on :${process.env.PORT || 3000}`)
);