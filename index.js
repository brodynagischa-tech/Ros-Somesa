// GIS Test — Chat Server
// Run with: node index.js
// Requires: npm install express socket.io cors

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const server = http.createServer(app);

// Socket.IO server — CORS wide open here for local dev.
// Lock this down to your real client origin before shipping to production.
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Simple health check — useful for confirming the server is alive
// from a browser at http://<your-ip>:3001/health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', connections: io.engine.clientsCount });
});

// In-memory message history (resets on server restart — swap for a DB later)
const MAX_HISTORY = 200;
let history = [];

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id} (${io.engine.clientsCount} online)`);

  // Send existing history to the newly-connected client only
  socket.emit('history', history);

  socket.on('chat message', (msg) => {
    // Basic shape validation so a bad client can't crash the server
    if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) return;

    const fullMsg = {
      id: `${socket.id}-${Date.now()}`,
      text: msg.text.trim().slice(0, 2000), // cap message length
      sender: typeof msg.sender === 'string' ? msg.sender.slice(0, 40) : 'Anonymous',
      timestamp: Date.now(),
    };

    history.push(fullMsg);
    if (history.length > MAX_HISTORY) history.shift();

    // Broadcast to everyone, including sender, so all clients render
    // the exact same server-confirmed message (avoids duplicate/echo bugs)
    io.emit('chat message', fullMsg);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} (${reason})`);
  });
});

const PORT = process.env.PORT || 3001;
// Bind to 0.0.0.0 so phones on the same Wi-Fi can reach this machine's IP
server.listen(PORT, '0.0.0.0', () => {
  console.log(`GIS Test server listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
