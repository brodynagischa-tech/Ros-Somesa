// GIS Test — Chat Server
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 6 * 1024 * 1024,
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', connections: io.engine.clientsCount });
});

const MAX_HISTORY = 100;
let history = [];

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id} (${io.engine.clientsCount} online)`);

  socket.emit('history', history);

  socket.on('chat message', (msg) => {
    if (!msg || typeof msg !== 'object') return;

    const hasText = typeof msg.text === 'string' && msg.text.trim().length > 0;
    const hasImage = typeof msg.image === 'string' && msg.image.length > 0;
    if (!hasText && !hasImage) return;

    const image = hasImage && msg.image.length <= 6 * 1024 * 1024 ? msg.image : undefined;

    const fullMsg = {
      id: `${socket.id}-${Date.now()}`,
      text: hasText ? msg.text.trim().slice(0, 2000) : '',
      image,
      sender: typeof msg.sender === 'string' ? msg.sender.slice(0, 40) : 'Anonymous',
      senderName: typeof msg.senderName === 'string' ? msg.senderName.slice(0, 40) : '',
      timestamp: Date.now(),
    };

    history.push(fullMsg);
    if (history.length > MAX_HISTORY) history.shift();

    io.emit('chat message', fullMsg);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} (${reason})`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`GIS Test server listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
// ── Paste this block into your existing index.js, right after
//    `const io = new Server(server, { ... });`
//    (the block you already have with cors + maxHttpBufferSize).
//
// It adds:
//   1. Room-based chat messaging (text + image, image as base64 data URI
//      — this is exactly why you already set maxHttpBufferSize to 6MB)
//   2. WebRTC signaling relay for voice/video calls (offer/answer/ICE)
//
// No new npm packages needed — this only uses socket.io, which you
// already have installed.

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // ── Chat ────────────────────────────────────────────────────────
  // Client joins a 1:1 (or group) room, e.g. roomId = sorted([userA, userB]).join('_')
  socket.on("chat:join", ({ roomId }) => {
    socket.join(roomId);
  });

  // payload: { roomId, type: "text" | "image", content, senderId, timestamp }
  // For images, `content` is a base64 data URI (e.g. "data:image/jpeg;base64,...")
  socket.on("chat:message", (payload) => {
    io.to(payload.roomId).emit("chat:message", payload);
  });

  // ── Voice / video call signaling ──────────────────────────────────
  // This server only relays SDP offers/answers and ICE candidates
  // between the two peers in a room — actual audio/video travels
  // peer-to-peer (or through a TURN server) once the call connects.

  socket.on("call:invite", ({ roomId, from, callType }) => {
    // callType: "voice" | "video"
    socket.to(roomId).emit("call:invite", { from, callType });
  });

  socket.on("call:offer", ({ roomId, sdp, from, callType }) => {
    socket.to(roomId).emit("call:offer", { sdp, from, callType });
  });

  socket.on("call:answer", ({ roomId, sdp, from }) => {
    socket.to(roomId).emit("call:answer", { sdp, from });
  });

  socket.on("call:ice-candidate", ({ roomId, candidate, from }) => {
    socket.to(roomId).emit("call:ice-candidate", { candidate, from });
  });

  socket.on("call:reject", ({ roomId }) => {
    socket.to(roomId).emit("call:reject");
  });

  socket.on("call:end", ({ roomId }) => {
    socket.to(roomId).emit("call:end");
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

