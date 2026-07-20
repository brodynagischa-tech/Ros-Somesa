// GIS Chat — Chat Server (rooms with membership + larger file support)
const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 90 * 1024 * 1024, // ~90MB — enough for a base64'd ~50MB file
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', connections: io.engine.clientsCount });
});

const MAX_HISTORY = 60;

// ── Persistence ────────────────────────────────────────────────────
// Render's free tier "spins down" the server after inactivity and
// restarts it on the next request — that wipes anything kept only in
// memory. We save rooms/messages to a JSON file on disk so a spin-down
// / spin-up cycle doesn't lose your groups and chat history.
// (Note: a full redeploy — pushing new code — still resets the disk,
// since Render's free web services don't have a persistent volume.
// For data that must survive redeploys too, you'd need a real database
// like Render's free Postgres or MongoDB Atlas.)
const DATA_FILE = path.join(__dirname, 'data.json');

function loadRooms() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (e) {
    // no saved file yet, or it's corrupted — start fresh
  }
  return {}; // no default/public room — users only see groups they were explicitly added to
}

let saveTimer = null;
function saveRoomsSoon() {
  // Debounced so a burst of messages doesn't hammer the disk with writes.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(rooms), (err) => {
      if (err) console.error('[persist] failed to save data.json:', err.message);
    });
  }, 1000);
}

// rooms: { [roomId]: { id, name, createdBy, members: [phone,...], history: [], lastActivityAt } }
const rooms = loadRooms();
// members === null means "public / open to everyone"

function normalizePhone(p) {
  return String(p || '').replace(/[\s-]/g, '').replace(/^\+/, '').replace(/^855/, '').replace(/^0/, '');
}

function roomsVisibleTo(phone) {
  const norm = normalizePhone(phone);
  return Object.values(rooms)
    .filter((r) => r.members === null || r.members.includes(norm))
    .map((r) => ({ id: r.id, name: r.name, lastActivityAt: r.lastActivityAt || 0 }));
}

function broadcastRoomListToAll() {
  for (const [, socket] of io.sockets.sockets) {
    if (socket.data.phone) {
      socket.emit('room list', roomsVisibleTo(socket.data.phone));
    }
  }
}

function makeRoomId() {
  return `room-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id} (${io.engine.clientsCount} online)`);
  // No auto-join here on purpose — a user only sees/joins rooms they're
  // an explicit member of. That list is sent once `identify` fires below.

  socket.on('identify', ({ phone }) => {
    socket.data.phone = normalizePhone(phone);
    // re-join any custom rooms this phone already belongs to
    Object.values(rooms).forEach((r) => {
      if (r.members && r.members.includes(socket.data.phone)) socket.join(r.id);
    });
    socket.emit('room list', roomsVisibleTo(socket.data.phone));
  });

  socket.on('create room', ({ name, memberPhones }) => {
    if (typeof name !== 'string' || !name.trim()) return;
    const id = makeRoomId();
    const creatorPhone = socket.data.phone;
    const invitees = Array.isArray(memberPhones) ? memberPhones.map(normalizePhone).filter(Boolean) : [];
    const members = creatorPhone ? Array.from(new Set([creatorPhone, ...invitees])) : null;

    rooms[id] = { id, name: name.trim().slice(0, 40), createdBy: socket.id, members, history: [], lastActivityAt: Date.now() };
    socket.join(id);
    broadcastRoomListToAll();
    socket.emit('room history', { roomId: id, history: [] });
    socket.emit('room created', { id, name: rooms[id].name });
    saveRoomsSoon();
  });

  socket.on('join room', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.members !== null && !room.members.includes(socket.data.phone)) {
      socket.emit('join denied', { roomId });
      return;
    }
    socket.join(roomId);
    socket.emit('room history', { roomId, history: room.history });
  });

  socket.on('chat message', (msg, ack) => {
    // `ack` is the optional callback the client passes to socket.emit —
    // we ALWAYS call it (success or failure) so the client can tell
    // whether the message actually made it, instead of guessing.
    const fail = (error) => {
      console.log(`[chat message] rejected from ${socket.id}: ${error}`);
      if (typeof ack === 'function') ack({ ok: false, error });
    };

    if (!msg || typeof msg !== 'object') return fail('invalid payload');
    const roomId = typeof msg.roomId === 'string' && rooms[msg.roomId] ? msg.roomId : 'general';
    const room = rooms[roomId];
    if (room.members !== null && !room.members.includes(socket.data.phone)) {
      return fail('not a member of this room');
    }

    const hasText = typeof msg.text === 'string' && msg.text.trim().length > 0;
    const hasImage = typeof msg.image === 'string' && msg.image.length > 0;
    const hasFile = typeof msg.fileData === 'string' && msg.fileData.length > 0;
    const hasAudio = typeof msg.audioData === 'string' && msg.audioData.length > 0;
    if (!hasText && !hasImage && !hasFile && !hasAudio) return fail('empty message');

    if (hasImage && msg.image.length > 25 * 1024 * 1024) return fail('image too large');
    if (hasFile && msg.fileData.length > 70 * 1024 * 1024) return fail('file too large');
    if (hasAudio && msg.audioData.length > 20 * 1024 * 1024) return fail('audio too large');

    const fullMsg = {
      id: `${socket.id}-${Date.now()}`,
      roomId,
      text: hasText ? msg.text.trim().slice(0, 2000) : '',
      image: hasImage ? msg.image : undefined,
      fileData: hasFile ? msg.fileData : undefined,
      fileName: hasFile ? String(msg.fileName || 'file').slice(0, 100) : undefined,
      fileMime: hasFile ? String(msg.fileMime || 'application/octet-stream').slice(0, 100) : undefined,
      audioData: hasAudio ? msg.audioData : undefined,
      audioMime: hasAudio ? String(msg.audioMime || 'audio/m4a').slice(0, 100) : undefined,
      audioDuration: hasAudio ? Number(msg.audioDuration) || 0 : undefined,
      sender: typeof msg.sender === 'string' ? msg.sender.slice(0, 40) : 'Anonymous',
      senderName: typeof msg.senderName === 'string' ? msg.senderName.slice(0, 40) : '',
      timestamp: Date.now(),
    };

    room.history.push(fullMsg);
    if (room.history.length > MAX_HISTORY) room.history.shift();
    room.lastActivityAt = fullMsg.timestamp;

    io.to(roomId).emit('chat message', fullMsg);
    if (typeof ack === 'function') ack({ ok: true, id: fullMsg.id });
    broadcastRoomListToAll();
    saveRoomsSoon();
  });

  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} (${reason})`);
  });

  // ── Voice / video call signaling ────────────────────────────────
  // This server only relays SDP offers/answers and ICE candidates between
  // the two peers in a room — actual audio/video travels directly between
  // the two phones (or via STUN/TURN) once the call connects.
  socket.on('call:invite', ({ roomId, from, callType }) => {
    socket.to(roomId).emit('call:invite', { roomId, from, callType });
  });

  socket.on('call:offer', ({ roomId, sdp }) => {
    socket.to(roomId).emit('call:offer', { roomId, sdp });
  });

  socket.on('call:answer', ({ roomId, sdp }) => {
    socket.to(roomId).emit('call:answer', { roomId, sdp });
  });

  socket.on('call:ice-candidate', ({ roomId, candidate }) => {
    socket.to(roomId).emit('call:ice-candidate', { roomId, candidate });
  });

  socket.on('call:reject', ({ roomId }) => {
    socket.to(roomId).emit('call:reject', { roomId });
  });

  socket.on('call:end', ({ roomId }) => {
    socket.to(roomId).emit('call:end', { roomId });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`GIS Chat server listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
