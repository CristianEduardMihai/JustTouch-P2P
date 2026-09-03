const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

// HTTP Static File Server
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(parsedUrl.pathname);

  // Default to index.html for root or SPA routes like /r/:roomId
  let filePath = path.join(PUBLIC_DIR, pathname);

  // Security check: prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('Internal Server Error');
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(content);
    });
  });
});

// WebSocket Signaling & Relay Server
const wss = new WebSocketServer({ server });

// Map of roomId -> { sender: ws, receiver: ws, createdAt: timestamp }
const rooms = new Map();

function sendJson(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

wss.on('connection', (ws, req) => {
  let currentRoomId = null;
  let currentRole = null;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (messageRaw, isBinary) => {
    // Binary chunk forwarding for relay transfers
    if (isBinary) {
      if (!currentRoomId || !rooms.has(currentRoomId)) return;
      const room = rooms.get(currentRoomId);
      const targetRole = currentRole === 'sender' ? 'receiver' : 'sender';
      const targetWs = room[targetRole];
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(messageRaw, { binary: true });
      }
      return;
    }

    let message;
    try {
      message = JSON.parse(messageRaw.toString());
    } catch (e) {
      return sendJson(ws, { type: 'error', message: 'Invalid JSON' });
    }

    const { type, roomId, role, data } = message;

    switch (type) {
      case 'join': {
        if (!roomId || !role) {
          return sendJson(ws, { type: 'error', message: 'Missing roomId or role' });
        }

        currentRoomId = roomId;
        currentRole = role;

        let room = rooms.get(roomId);
        if (!room) {
          room = { sender: null, receiver: null, createdAt: Date.now() };
          rooms.set(roomId, room);
        }

        room[role] = ws;
        console.log(`[Room ${roomId}] Peer joined as ${role}. (Total rooms: ${rooms.size})`);

        sendJson(ws, { type: 'joined', roomId, role });

        // If both peers are connected, notify them to start negotiation
        if (room.sender && room.receiver) {
          sendJson(room.sender, { type: 'peer-joined', role: 'receiver' });
          sendJson(room.receiver, { type: 'peer-joined', role: 'sender' });
          console.log(`[Room ${roomId}] Both peers connected! WebRTC / Relay ready.`);
        }
        break;
      }

      case 'signal': {
        if (!currentRoomId || !rooms.has(currentRoomId)) {
          return sendJson(ws, { type: 'error', message: 'Room not found' });
        }

        const room = rooms.get(currentRoomId);
        const targetRole = currentRole === 'sender' ? 'receiver' : 'sender';
        const targetWs = room[targetRole];

        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          sendJson(targetWs, {
            type: 'signal',
            from: currentRole,
            data,
          });
        }
        break;
      }

      // JSON Relay Fallback for cellular networks / symmetric NATs
      case 'relay': {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;
        const room = rooms.get(currentRoomId);
        const targetRole = currentRole === 'sender' ? 'receiver' : 'sender';
        const targetWs = room[targetRole];

        console.log(`[Room ${currentRoomId}] Relay message forwarded to ${targetRole}: ${message.data?.type || 'data'}`);

        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          sendJson(targetWs, {
            type: 'relay',
            from: currentRole,
            data: message.data,
          });
        }
        break;
      }

      case 'leave': {
        cleanupPeer();
        break;
      }

      default:
        sendJson(ws, { type: 'error', message: `Unknown message type: ${type}` });
    }
  });

  function cleanupPeer() {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;

    const room = rooms.get(currentRoomId);
    if (currentRole && room[currentRole] === ws) {
      room[currentRole] = null;
      console.log(`[Room ${currentRoomId}] ${currentRole} disconnected`);

      const otherRole = currentRole === 'sender' ? 'receiver' : 'sender';
      const otherWs = room[otherRole];
      if (otherWs && otherWs.readyState === WebSocket.OPEN) {
        sendJson(otherWs, { type: 'peer-left', role: currentRole });
      }

      if (!room.sender && !room.receiver) {
        rooms.delete(currentRoomId);
        console.log(`[Room ${currentRoomId}] Room destroyed`);
      }
    }
  }

  ws.on('close', cleanupPeer);
  ws.on('error', (err) => {
    console.error(`[WebSocket Error]`, err.message);
    cleanupPeer();
  });
});

// Periodic ping to keep WebSockets alive through tunnels and reverse proxies
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`🚀 JustTouch WebRTC & Relay Server Running`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌐 Local Web Interface: http://localhost:${PORT}`);
  console.log(`=========================================`);
});
