// GIS Test — Chat Server (with rooms/groups + file support)
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 8 * 1024 * 1024, // 8MB — headroom for files/images
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', connections: io.engine.clientsCount });
});

const MAX_HISTORY = 80; // lower since messages can carry big attachments

// rooms: { [roomId]: { id, name, createdBy, history: [] } }
const rooms = {
  general: { id: 'general', name: 'ទូទៅ (General)', createdBy: null, history: [] },
};

function roomListPayload() {
  return Object.values(rooms).map((r) => ({ id: r.id, name: r.name }));
}

function makeRoomId() {
  return `room-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id} (${io.engine.clientsCount} online)`);

  // Everyone auto-joins "general" on connect
  socket.join('general');
  socket.emit('room list', roomListPayload());
  socket.emit('room history', { roomId: 'general', history: rooms.general.history });

  socket.on('create room', (name) => {
    if (typeof name !== 'string' || !name.trim()) return;
    const id = makeRoomId();
    rooms[id] = { id, name: name.trim().slice(0, 40), createdBy: socket.id, history: [] };
    socket.join(id);
    io.emit('room list', roomListPayload()); // let everyone see the new group
    socket.emit('room history', { roomId: id, history: [] });
    socket.emit('room created', { id, name: rooms[id].name });
  });

  socket.on('join room', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    socket.join(roomId);
    socket.emit('room history', { roomId, history: room.history });
  });

  socket.on('chat message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const roomId = typeof msg.roomId === 'string' && rooms[msg.roomId] ? msg.roomId : 'general';

    const hasText = typeof msg.text === 'string' && msg.text.trim().length > 0;
    const hasImage = typeof msg.image === 'string' && msg.image.length > 0;
    const hasFile = typeof msg.fileData === 'string' && msg.fileData.length > 0;
    if (!hasText && !hasImage && !hasFile) return;

    const image = hasImage && msg.image.length <= 8 * 1024 * 1024 ? msg.image : undefined;
    const fileData = hasFile && msg.fileData.length <= 8 * 1024 * 1024 ? msg.fileData : undefined;

    const fullMsg = {
      id: `${socket.id}-${Date.now()}`,
      roomId,
      text: hasText ? msg.text.trim().slice(0, 2000) : '',
      image,
      fileData,
      fileName: fileData ? String(msg.fileName || 'file').slice(0, 100) : undefined,
      fileMime: fileData ? String(msg.fileMime || 'application/octet-stream').slice(0, 100) : undefined,
      sender: typeof msg.sender === 'string' ? msg.sender.slice(0, 40) : 'Anonymous',
      senderName: typeof msg.senderName === 'string' ? msg.senderName.slice(0, 40) : '',
      timestamp: Date.now(),
    };

    rooms[roomId].history.push(fullMsg);
    if (rooms[roomId].history.length > MAX_HISTORY) rooms[roomId].history.shift();

    io.to(roomId).emit('chat message', fullMsg);
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
