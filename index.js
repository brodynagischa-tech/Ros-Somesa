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
