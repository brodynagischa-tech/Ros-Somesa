// GIS Test — Chat Server (rooms with membership + larger file support)
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 22 * 1024 * 1024, // ~22MB — enough for base64'd ~15MB files
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', connections: io.engine.clientsCount });
});

const MAX_HISTORY = 60;

// rooms: { [roomId]: { id, name, createdBy, members: [phone,...], history: [] } }
const rooms = {
  general: { id: 'general', name: 'ទូទៅ (General)', createdBy: null, members: null, history: [] },
};
// members === null means "public / open to everyone"

function normalizePhone(p) {
  return String(p || '').replace(/[\s-]/g, '').replace(/^\+/, '').replace(/^855/, '').replace(/^0/, '');
}

function roomsVisibleTo(phone) {
  const norm = normalizePhone(phone);
  return Object.values(rooms)
    .filter((r) => r.members === null || r.members.includes(norm))
    .map((r) => ({ id: r.id, name: r.name }));
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

  socket.join('general');
  socket.emit('room history', { roomId: 'general', history: rooms.general.history });

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

    rooms[id] = { id, name: name.trim().slice(0, 40), createdBy: socket.id, members, history: [] };
    socket.join(id);
    broadcastRoomListToAll();
    socket.emit('room history', { roomId: id, history: [] });
    socket.emit('room created', { id, name: rooms[id].name });
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

    if (hasImage && msg.image.length > 20 * 1024 * 1024) return fail('image too large');
    if (hasFile && msg.fileData.length > 20 * 1024 * 1024) return fail('file too large');
    if (hasAudio && msg.audioData.length > 15 * 1024 * 1024) return fail('audio too large');

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

    io.to(roomId).emit('chat message', fullMsg);
    if (typeof ack === 'function') ack({ ok: true, id: fullMsg.id });
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
