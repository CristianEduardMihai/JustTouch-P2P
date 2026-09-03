const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 200);
const MAX_CONNECTIONS_PER_IP = Number(process.env.MAX_CONNECTIONS_PER_IP || 12);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 1000);
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 60 * 60 * 1000);
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_BINARY_BYTES = 64 * 1024;
const MAX_MESSAGES_PER_WINDOW = 120;
const RATE_WINDOW_MS = 60 * 1000;
const ROOM_ID_PATTERN = /^jt-[a-hj-km-np-z2-9]{16}$/;
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const connectionsByIp = new Map();

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
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request');
  }

  // Default to index.html for root or SPA routes like /r/:roomId
  let filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);

  // Security check: prevent path traversal
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Internal Server Error');
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
      });
      res.end(content);
    });
  });
});

// WebSocket Signaling & Relay Server
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

// Map of roomId -> { sender: ws, receiver: ws, createdAt: timestamp }
const rooms = new Map();

function getClientIp(req) {
  if (TRUST_PROXY && typeof req.headers['cf-connecting-ip'] === 'string') {
    return req.headers['cf-connecting-ip'];
  }
  return req.socket.remoteAddress || 'unknown';
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.size === 0) return true;
  return allowedOrigins.has(origin);
}

function sendJson(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

wss.on('connection', (ws, req) => {
  const clientIp = getClientIp(req);
  if (!isAllowedOrigin(req.headers.origin)) {
    ws.close(1008, 'Origin not allowed');
    return;
  }
  if (wss.clients.size >= MAX_CONNECTIONS) {
    ws.close(1013, 'Server is busy');
    return;
  }
  const ipConnections = connectionsByIp.get(clientIp) || 0;
  if (ipConnections >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1008, 'Too many connections');
    return;
  }
  connectionsByIp.set(clientIp, ipConnections + 1);

  let currentRoomId = null;
  let currentRole = null;
  let connectionReleased = false;
  let messageWindowStarted = Date.now();
  let messageCount = 0;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (messageRaw, isBinary) => {
    const now = Date.now();
    if (now - messageWindowStarted >= RATE_WINDOW_MS) {
      messageWindowStarted = now;
      messageCount = 0;
    }
    if (++messageCount > MAX_MESSAGES_PER_WINDOW) {
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    // Binary chunk forwarding for relay transfers
    if (isBinary) {
      if (messageRaw.length > MAX_BINARY_BYTES) {
        ws.close(1009, 'Binary message too large');
        return;
      }
      if (!currentRoomId || !rooms.has(currentRoomId)) return;
      const room = rooms.get(currentRoomId);
      const targetRole = currentRole === 'sender' ? 'receiver' : 'sender';
      const targetWs = room[targetRole];
      if (targetWs && targetWs.readyState === WebSocket.OPEN && targetWs.bufferedAmount < MAX_MESSAGE_BYTES) {
        targetWs.send(messageRaw, { binary: true });
      }
      return;
    }

    let message;
    try {
      if (messageRaw.length > MAX_MESSAGE_BYTES) {
        ws.close(1009, 'Message too large');
        return;
      }
      message = JSON.parse(messageRaw.toString());
    } catch (e) {
      return sendJson(ws, { type: 'error', message: 'Invalid JSON' });
    }

    const { type, roomId, role, data } = message;
    if (typeof type !== 'string' || type.length > 32) {
      return sendJson(ws, { type: 'error', message: 'Invalid message type' });
    }

    switch (type) {
      case 'join': {
        if (!ROOM_ID_PATTERN.test(roomId) || !['sender', 'receiver'].includes(role)) {
          return sendJson(ws, { type: 'error', message: 'Invalid roomId or role' });
        }
        if (currentRoomId) {
          return sendJson(ws, { type: 'error', message: 'Connection already joined' });
        }
        if (rooms.size >= MAX_ROOMS) {
          return sendJson(ws, { type: 'error', message: 'Too many active rooms' });
        }

        let room = rooms.get(roomId);
        if (!room) {
          room = { sender: null, receiver: null, createdAt: Date.now() };
          rooms.set(roomId, room);
        }
        if (room[role]) {
          return sendJson(ws, { type: 'error', message: 'That role is already connected' });
        }

        currentRoomId = roomId;
        currentRole = role;

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
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return sendJson(ws, { type: 'error', message: 'Invalid signal data' });
        }
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
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return sendJson(ws, { type: 'error', message: 'Invalid relay data' });
        }
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

  function releaseConnection() {
    if (connectionReleased) return;
    connectionReleased = true;
    const remaining = (connectionsByIp.get(clientIp) || 1) - 1;
    if (remaining > 0) {
      connectionsByIp.set(clientIp, remaining);
    } else {
      connectionsByIp.delete(clientIp);
    }
  }

  ws.on('close', () => {
    cleanupPeer();
    releaseConnection();
  });
  ws.on('error', (err) => {
    console.error(`[WebSocket Error]`, err.message);
    cleanupPeer();
    releaseConnection();
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

const roomExpiryInterval = setInterval(() => {
  const expiryTime = Date.now() - ROOM_TTL_MS;
  for (const [roomId, room] of rooms) {
    if (room.createdAt < expiryTime) {
      for (const peer of [room.sender, room.receiver]) {
        if (peer && peer.readyState === WebSocket.OPEN) {
          peer.close(1000, 'Room expired');
        }
      }
      rooms.delete(roomId);
      console.log(`[Room ${roomId}] Expired`);
    }
  }
}, 60 * 1000);

roomExpiryInterval.unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`🚀 JustTouch WebRTC & Relay Server Running`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌐 Local Web Interface: http://localhost:${PORT}`);
  console.log(`=========================================`);
});
