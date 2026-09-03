// JustTouch Web Receiver Client
(() => {
  // DOM Elements
  const statusBar = document.getElementById('statusBar');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const welcomeState = document.getElementById('welcomeState');
  const waitingState = document.getElementById('waitingState');
  const transferState = document.getElementById('transferState');
  const waitingTitle = document.getElementById('waitingTitle');
  const waitingDesc = document.getElementById('waitingDesc');
  const currentRoomDisplay = document.getElementById('currentRoomDisplay');
  const manualRoomInput = document.getElementById('manualRoomInput');
  const manualJoinBtn = document.getElementById('manualJoinBtn');
  const fileCountBadge = document.getElementById('fileCountBadge');
  const totalSizeBadge = document.getElementById('totalSizeBadge');
  const speedBadge = document.getElementById('speedBadge');
  const globalProgressFill = document.getElementById('globalProgressFill');
  const transferProgressText = document.getElementById('transferProgressText');
  const transferRemainingText = document.getElementById('transferRemainingText');
  const fileList = document.getElementById('fileList');
  const downloadAllBtn = document.getElementById('downloadAllBtn');

  // RTC & Connection State
  let ws = null;
  let pc = null;
  let dataChannel = null;
  let roomId = null;

  // File Transfer State
  let expectedFiles = [];
  let currentFileIndex = -1;
  let currentFileChunks = [];
  let currentFileReceivedBytes = 0;
  let totalBytesAllFiles = 0;
  let totalReceivedBytesAllFiles = 0;
  let completedBlobs = [];

  // Speed calculation
  let lastTimestamp = Date.now();
  let lastReceivedBytes = 0;
  let currentSpeed = 0;

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.relay.metered.ca:80' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelay',
        credential: 'openrelay',
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelay',
        credential: 'openrelay',
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelay',
        credential: 'openrelay',
      },
    ],
  };

  // Helper: Format Bytes
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // Use compact file labels instead of emoji icons.
  function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return ext && ext !== filename.toLowerCase() ? ext.slice(0, 4).toUpperCase() : 'FILE';
  }

  // Parse Room ID from URL
  function getRoomFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('room')) return params.get('room');

    const hash = window.location.hash.substring(1);
    if (hash.startsWith('room=')) return hash.substring(5);
    if (hash.length > 2) return hash;

    const pathParts = window.location.pathname.split('/');
    if (pathParts.length >= 3 && (pathParts[1] === 'r' || pathParts[1] === 't')) {
      return pathParts[2];
    }

    return null;
  }

  function setStatus(text, type = 'normal') {
    statusText.innerText = text;
    statusDot.className = 'status-dot';
    if (type === 'connected') {
      statusDot.classList.add('connected');
    } else if (type === 'error') {
      statusDot.classList.add('error');
    } else {
      statusDot.classList.add('pulse');
    }
  }

  function showView(view) {
    welcomeState.style.display = view === 'welcome' ? 'block' : 'none';
    waitingState.style.display = view === 'waiting' ? 'block' : 'none';
    transferState.style.display = view === 'transfer' ? 'block' : 'none';
  }

  // Initialize
  function init() {
    roomId = getRoomFromUrl();

    if (roomId) {
      currentRoomDisplay.innerText = roomId;
      showView('waiting');
      connectSignaling();
    } else {
      showView('welcome');
      setStatus('Waiting for file transfer invitation...', 'normal');
    }

    manualJoinBtn.addEventListener('click', () => {
      const inputVal = manualRoomInput.value.trim();
      if (inputVal) {
        window.location.hash = `#room=${inputVal}`;
        roomId = inputVal;
        currentRoomDisplay.innerText = roomId;
        showView('waiting');
        connectSignaling();
      }
    });

    downloadAllBtn.addEventListener('click', () => {
      completedBlobs.forEach((item) => {
        if (item && item.url) {
          triggerBrowserDownload(item.url, item.name);
        }
      });
    });
  }

  // WebSocket Signaling
  function connectSignaling() {
    setStatus('Connecting to signaling server...', 'normal');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    if (ws) {
      try { ws.close(); } catch (e) {}
    }

    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.log('[Signaling] WebSocket connected');
      setStatus('Waiting for sender phone to connect...', 'normal');
      ws.send(JSON.stringify({
        type: 'join',
        roomId: roomId,
        role: 'receiver',
      }));
    };

    ws.onmessage = async (event) => {
      // Check if binary chunk received over WebSocket relay
      if (event.data instanceof ArrayBuffer) {
        handleBinaryChunk(event.data);
        return;
      } else if (event.data instanceof Blob) {
        const arrayBuffer = await event.data.arrayBuffer();
        handleBinaryChunk(arrayBuffer);
        return;
      }

      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'relay') {
          handleControlMessage(msg.data);
          return;
        }
        handleSignalingMessage(msg);
      } catch (e) {
        console.error('[Signaling] parse error:', e);
      }
    };

    ws.onclose = () => {
      console.log('[Signaling] WebSocket closed');
      if (transferState.style.display !== 'block') {
        setStatus('Signaling disconnected. Retrying in 3s...', 'error');
        setTimeout(connectSignaling, 3000);
      }
    };

    ws.onerror = (err) => {
      console.error('[Signaling] WebSocket error:', err);
    };
  }

  // Handle Signaling Messages
  async function handleSignalingMessage(msg) {
    console.log('[Signaling] Message:', msg.type);

    switch (msg.type) {
      case 'joined':
        console.log(`[Signaling] Successfully joined room: ${msg.roomId}`);
        break;

      case 'peer-joined':
        if (msg.role === 'sender') {
          setStatus('Sender found! Negotiating connection...', 'normal');
          waitingTitle.innerText = 'Sender connected!';
          waitingDesc.innerText = 'Establishing direct P2P or secure relay connection...';
          initPeerConnection();
        }
        break;

      case 'signal':
        if (!pc) initPeerConnection();

        if (msg.data.type === 'offer') {
          console.log('[WebRTC] Received Offer');
          setStatus('Connecting to phone...', 'normal');
          await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(JSON.stringify({
            type: 'signal',
            roomId: roomId,
            data: answer,
          }));
        } else if (msg.data.candidate) {
          console.log('[WebRTC] Received ICE Candidate');
          try {
            // Flutter sends candidate as a flat string inside msg.data, so reconstruct RTCIceCandidateInit
            const candidateInit = {
              candidate: msg.data.candidate,
              sdpMid: msg.data.sdpMid ?? '0',
              sdpMLineIndex: msg.data.sdpMLineIndex ?? 0,
            };
            await pc.addIceCandidate(new RTCIceCandidate(candidateInit));
          } catch (e) {
            console.warn('[WebRTC] Error adding ICE candidate:', e);
          }
        }
        break;

      case 'peer-left':
        setStatus('Sender disconnected', 'error');
        break;
    }
  }

  // WebRTC Peer Connection
  function initPeerConnection() {
    if (pc) return;

    console.log('[WebRTC] Creating RTCPeerConnection with STUN & TURN fallback');
    pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onicecandidate = (event) => {
      if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'signal',
          roomId: roomId,
          data: { candidate: event.candidate },
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        setStatus('Direct P2P Encrypted Connection Established!', 'connected');
      } else if (pc.connectionState === 'failed') {
        console.log('[WebRTC] Direct P2P failed. Falling back to WebSocket Relay.');
        setStatus('Connecting via Secure Relay (Cellular)...', 'connected');
      }
    };

    // The sender initiates the DataChannel; receiver listens for it
    pc.ondatachannel = (event) => {
      console.log('[WebRTC] DataChannel received:', event.channel.label);
      setupDataChannel(event.channel);
    };
  }

  // DataChannel Message Handler
  function setupDataChannel(channel) {
    dataChannel = channel;
    dataChannel.binaryType = 'arraybuffer';

    dataChannel.onopen = () => {
      console.log('[DataChannel] Open and ready');
      setStatus('Ready to receive files', 'connected');
    };

    dataChannel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        handleControlMessage(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        handleBinaryChunk(event.data);
      }
    };

    dataChannel.onclose = () => {
      console.log('[DataChannel] Closed');
    };

    dataChannel.onerror = (err) => {
      console.error('[DataChannel] Error:', err);
    };
  }

  // Control Messages (Metadata, file boundaries)
  function handleControlMessage(text) {
    let msg;
    try {
      msg = typeof text === 'object' ? text : JSON.parse(text);
    } catch (e) {
      console.error('Invalid control message:', text);
      return;
    }

    console.log('[Control Message]', msg.type, msg);

    switch (msg.type) {
      case 'relay-activated':
        setStatus('Transferring via Secure Relay (Cellular)...', 'connected');
        break;

      case 'meta':
        expectedFiles = msg.files || [];
        totalBytesAllFiles = expectedFiles.reduce((acc, f) => acc + (f.size || 0), 0);
        totalReceivedBytesAllFiles = 0;
        completedBlobs = new Array(expectedFiles.length).fill(null);

        renderFileList();
        showView('transfer');
        setStatus('Receiving files...', 'connected');
        break;

      case 'file-start':
        currentFileIndex = msg.index;
        currentFileChunks = [];
        currentFileReceivedBytes = 0;
        updateFileStatus(currentFileIndex, 'Receiving...', 0);
        break;

      case 'file-end':
        const fileMeta = expectedFiles[currentFileIndex];
        const mimeType = (fileMeta && fileMeta.mimeType) ? fileMeta.mimeType : 'application/octet-stream';
        const fileBlob = new Blob(currentFileChunks, { type: mimeType });
        const blobUrl = URL.createObjectURL(fileBlob);

        completedBlobs[currentFileIndex] = {
          blob: fileBlob,
          url: blobUrl,
          name: fileMeta.name,
        };

        updateFileStatus(currentFileIndex, 'Completed', 100, blobUrl);
        triggerBrowserDownload(blobUrl, fileMeta.name);

        currentFileChunks = [];
        break;

      case 'all-complete':
        setStatus('All files successfully received!', 'connected');
        globalProgressFill.style.width = '100%';
        transferProgressText.innerText = '100% completed';
        transferRemainingText.innerText = 'Transfer complete';
        speedBadge.innerText = 'Finished';
        if (expectedFiles.length > 1) {
          downloadAllBtn.style.display = 'inline-flex';
        }
        break;
    }
  }

  // Handle Binary Chunks
  function handleBinaryChunk(arrayBuffer) {
    if (currentFileIndex < 0 || currentFileIndex >= expectedFiles.length) return;

    currentFileChunks.push(arrayBuffer);
    const chunkSize = arrayBuffer.byteLength;
    currentFileReceivedBytes += chunkSize;
    totalReceivedBytesAllFiles += chunkSize;

    // Calculate Speed & Progress
    const now = Date.now();
    const dt = (now - lastTimestamp) / 1000;
    if (dt >= 0.5) {
      const bytesDiff = totalReceivedBytesAllFiles - lastReceivedBytes;
      currentSpeed = bytesDiff / dt;
      lastTimestamp = now;
      lastReceivedBytes = totalReceivedBytesAllFiles;

      speedBadge.innerText = `${formatBytes(currentSpeed)}/s`;

      const remainingBytes = Math.max(0, totalBytesAllFiles - totalReceivedBytesAllFiles);
      if (currentSpeed > 0) {
        const remainingSec = Math.round(remainingBytes / currentSpeed);
        transferRemainingText.innerText = `${remainingSec}s remaining`;
      }
    }

    // Update Global Progress
    const globalPercent = totalBytesAllFiles > 0
      ? Math.min(100, Math.round((totalReceivedBytesAllFiles / totalBytesAllFiles) * 100))
      : 0;
    globalProgressFill.style.width = `${globalPercent}%`;
    transferProgressText.innerText = `${globalPercent}% (${formatBytes(totalReceivedBytesAllFiles)} / ${formatBytes(totalBytesAllFiles)})`;

    // Update Current File Progress
    const currentMeta = expectedFiles[currentFileIndex];
    if (currentMeta && currentMeta.size > 0) {
      const filePercent = Math.min(100, Math.round((currentFileReceivedBytes / currentMeta.size) * 100));
      updateFileStatus(currentFileIndex, `${filePercent}%`, filePercent);
    }
  }

  // Render File List in UI
  function renderFileList() {
    fileList.innerHTML = '';
    fileCountBadge.innerText = `${expectedFiles.length} file${expectedFiles.length > 1 ? 's' : ''}`;
    totalSizeBadge.innerText = formatBytes(totalBytesAllFiles);

    expectedFiles.forEach((file, index) => {
      const li = document.createElement('li');
      li.className = 'file-item';
      li.id = `file-item-${index}`;

      const icon = getFileIcon(file.name);

      li.innerHTML = `
        <div class="file-icon-box">${icon}</div>
        <div class="file-details">
          <div class="file-title" title="${file.name}">${file.name}</div>
          <div class="file-sub">
            <span class="file-size">${formatBytes(file.size)}</span> • 
            <span class="file-status" id="file-status-${index}">Queued</span>
          </div>
        </div>
        <button class="btn-file-dl" id="file-btn-${index}" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          Save
        </button>
      `;

      fileList.appendChild(li);
    });
  }

  function updateFileStatus(index, statusStr, percent, blobUrl = null) {
    const statusElem = document.getElementById(`file-status-${index}`);
    const btnElem = document.getElementById(`file-btn-${index}`);

    if (statusElem) {
      statusElem.innerText = statusStr;
      if (percent === 100) {
        statusElem.style.color = 'var(--success)';
        statusElem.style.fontWeight = '600';
      }
    }

    if (btnElem && blobUrl) {
      btnElem.disabled = false;
      btnElem.onclick = () => {
        const file = expectedFiles[index];
        triggerBrowserDownload(blobUrl, file ? file.name : 'download');
      };
    }
  }

  // Trigger Native Browser Download
  function triggerBrowserDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
    }, 100);
  }

  // Start on page load
  window.addEventListener('DOMContentLoaded', init);
})();
