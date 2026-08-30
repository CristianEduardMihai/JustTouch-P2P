# JustTouch Server

Signaling server & Web Receiver client for **JustTouch** P2P file sharing.

## Features
- **Zero Cloud Storage**: Direct WebRTC DataChannel P2P file transfer between Android App & Web Browser.
- **WebSocket Signaling**: Coordinates SDP offer/answer exchanges and ICE candidates.
- **Responsive Web UI**: Built for mobile browsers (Safari iOS, Chrome Android) and desktop browsers.
- **Docker Ready**: Minimal `node:alpine` footprint.

## Quick Start (Docker)

To run the server with Docker Compose:

```bash
docker compose up -d
```

The server will be live on `http://localhost:8080`.

## Quick Start (Local Node.js)

```bash
cd server
npm install
node server.js
```

## Tunneling / Public Access

When running locally with a tunnel (e.g. Cloudflare Tunnels):
```bash
# Point your tunnel to localhost:8080
cloudflared tunnel --url http://localhost:8080
```
Then configure your Android app to use your public domain (e.g., `https://justtouch.cristianmihai.cc`).

