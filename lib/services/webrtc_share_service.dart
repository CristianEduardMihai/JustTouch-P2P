import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:logging/logging.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../models/shared_file.dart';

enum ShareStatus {
  idle,
  connectingSignaling,
  waitingForReceiver,
  negotiating,
  connected,
  transferring,
  completed,
  error,
}

class WebRtcShareService with ChangeNotifier {
  static final Logger _logger = Logger('WebRtcShareService');

  static const String defaultServerUrl = 'https://justtouch.cristianmihai.cc';
  static const int chunkSize = 64 * 1024; // 64 KB

  String _serverUrl = defaultServerUrl;
  String? _roomId;
  ShareStatus _status = ShareStatus.idle;
  String _statusMessage = 'Idle';

  List<SharedFile> _files = [];
  double _progress = 0.0;
  int _totalBytes = 0;
  int _bytesSent = 0;
  String _currentFileName = '';
  String _speedText = '';

  WebSocketChannel? _wsChannel;
  RTCPeerConnection? _peerConnection;
  RTCDataChannel? _dataChannel;
  StreamSubscription? _wsSubscription;

  // Flow control & timers
  Timer? _speedTimer;
  int _lastBytesSent = 0;
  DateTime _lastSpeedCalcTime = DateTime.now();

  // Getters
  String get serverUrl => _serverUrl;
  String? get roomId => _roomId;
  ShareStatus get status => _status;
  String get statusMessage => _statusMessage;
  double get progress => _progress;
  int get totalBytes => _totalBytes;
  int get bytesSent => _bytesSent;
  String get currentFileName => _currentFileName;
  String get speedText => _speedText;

  String? get shareUrl {
    if (_roomId == null) return null;
    return '$_serverUrl/#room=$_roomId';
  }

  void setServerUrl(String url) {
    _serverUrl = url.trim().replaceAll(RegExp(r'/+$'), '');
    notifyListeners();
  }

  String _generateRoomId() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    final rand = Random();
    final buffer = StringBuffer('jt-');
    for (int i = 0; i < 6; i++) {
      buffer.write(chars[rand.nextInt(chars.length)]);
    }
    return buffer.toString();
  }

  Future<String?> startSharing(List<SharedFile> files) async {
    if (files.isEmpty) return null;

    await stopSharing();

    _files = List.from(files);
    _totalBytes = _files.fold(0, (sum, f) => sum + f.size);
    _bytesSent = 0;
    _progress = 0.0;
    _roomId = _generateRoomId();
    _updateStatus(ShareStatus.connectingSignaling, 'Connecting to signaling server...');

    try {
      final wsUri = _getWebSocketUri(_serverUrl);
      _logger.info('Connecting to signaling WebSocket: $wsUri for room: $_roomId');

      _wsChannel = WebSocketChannel.connect(wsUri);
      await _wsChannel!.ready;

      _wsSubscription = _wsChannel!.stream.listen(
        _handleSignalingMessage,
        onError: (err) {
          _logger.severe('Signaling error: $err');
          _updateStatus(ShareStatus.error, 'Signaling connection error: $err');
        },
        onDone: () {
          _logger.info('Signaling closed');
          if (_status != ShareStatus.completed && _status != ShareStatus.transferring) {
            _updateStatus(ShareStatus.idle, 'Signaling disconnected');
          }
        },
      );

      // Register room as sender
      _sendSignaling({
        'type': 'join',
        'roomId': _roomId,
        'role': 'sender',
      });

      _updateStatus(
        ShareStatus.waitingForReceiver,
        'Waiting for receiver to tap NFC or scan QR...',
      );

      return shareUrl;
    } catch (e) {
      _logger.severe('Failed to start sharing: $e');
      _updateStatus(ShareStatus.error, 'Failed to connect: $e');
      return null;
    }
  }

  Uri _getWebSocketUri(String httpUrl) {
    final parsed = Uri.parse(httpUrl);
    final isSecure = parsed.scheme == 'https';
    final wsScheme = isSecure ? 'wss' : 'ws';
    final port = parsed.hasPort ? parsed.port : (isSecure ? 443 : 80);
    return Uri(
      scheme: wsScheme,
      host: parsed.host,
      port: (port == 80 || port == 443) ? null : port,
      path: '/ws',
    );
  }

  void _sendSignaling(Map<String, dynamic> data) {
    if (_wsChannel != null) {
      _wsChannel!.sink.add(jsonEncode(data));
    }
  }

  void _handleSignalingMessage(dynamic messageRaw) async {
    try {
      final message = jsonDecode(messageRaw.toString()) as Map<String, dynamic>;
      final type = message['type'];

      _logger.info('Signaling message received: $type');

      switch (type) {
        case 'joined':
          _logger.info('Successfully registered room: ${message['roomId']}');
          break;

        case 'peer-joined':
          if (message['role'] == 'receiver') {
            _logger.info('Receiver detected! Creating WebRTC PeerConnection & Offer...');
            _updateStatus(ShareStatus.negotiating, 'Receiver connected! Negotiating WebRTC...');
            await _initiatePeerConnection();
          }
          break;

        case 'signal':
          final data = message['data'] as Map<String, dynamic>;
          if (data['type'] == 'answer') {
            _logger.info('Received WebRTC Answer');
            final sdp = data['sdp'] as String;
            await _peerConnection?.setRemoteDescription(
              RTCSessionDescription(sdp, 'answer'),
            );
          } else if (data['candidate'] != null) {
            _logger.info('Received ICE Candidate');
            final candidate = RTCIceCandidate(
              data['candidate']['candidate'] ?? data['candidate'],
              data['candidate']['sdpMid'] ?? data['sdpMid'],
              data['candidate']['sdpMLineIndex'] ?? data['sdpMLineIndex'],
            );
            await _peerConnection?.addCandidate(candidate);
          }
          break;

        case 'peer-left':
          _logger.info('Receiver disconnected');
          if (_status == ShareStatus.transferring) {
            _updateStatus(ShareStatus.error, 'Receiver disconnected during transfer');
          }
          break;
      }
    } catch (e) {
      _logger.warning('Error handling signaling message: $e');
    }
  }

  Future<void> _initiatePeerConnection() async {
    final configuration = <String, dynamic>{
      'iceServers': [
        {'urls': 'stun:stun.l.google.com:19302'},
        {'urls': 'stun:stun1.l.google.com:19302'},
        {'urls': 'stun:stun2.l.google.com:19302'},
      ],
      'sdpSemantics': 'unified-plan',
    };

    _peerConnection = await createPeerConnection(configuration);

    _peerConnection!.onIceCandidate = (candidate) {
      if (candidate.candidate != null) {
        _sendSignaling({
          'type': 'signal',
          'roomId': _roomId,
          'data': {
            'candidate': candidate.candidate,
            'sdpMid': candidate.sdpMid,
            'sdpMLineIndex': candidate.sdpMLineIndex,
          },
        });
      }
    };

    _peerConnection!.onConnectionState = (state) {
      _logger.info('PeerConnection state: $state');
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _updateStatus(ShareStatus.connected, 'Direct P2P Encrypted Connection Ready');
      } else if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        _updateStatus(ShareStatus.error, 'WebRTC Connection failed');
      }
    };

    // Create RTCDataChannel for file transfer
    final init = RTCDataChannelInit()
      ..ordered = true
      ..maxRetransmits = 30;

    _dataChannel = await _peerConnection!.createDataChannel('fileTransfer', init);

    _dataChannel!.onDataChannelState = (state) {
      _logger.info('DataChannel state: $state');
      if (state == RTCDataChannelState.RTCDataChannelOpen) {
        _updateStatus(ShareStatus.transferring, 'Sending files...');
        _startFileTransfer();
      }
    };

    // Create and send Offer
    final offer = await _peerConnection!.createOffer({
      'mandatory': {
        'OfferToReceiveAudio': false,
        'OfferToReceiveVideo': false,
      },
    });

    await _peerConnection!.setLocalDescription(offer);

    _sendSignaling({
      'type': 'signal',
      'roomId': _roomId,
      'data': {
        'type': offer.type,
        'sdp': offer.sdp,
      },
    });
  }

  Future<void> _startFileTransfer() async {
    if (_dataChannel == null || _dataChannel!.state != RTCDataChannelState.RTCDataChannelOpen) {
      _logger.warning('Cannot start transfer: DataChannel not open');
      return;
    }

    _startSpeedTimer();

    try {
      // 1. Send Metadata of all files
      final fileMetadataList = _files.map((f) => {
        'name': f.fileName,
        'size': f.size,
        'mimeType': f.mimeType,
      }).toList();

      _dataChannel!.send(RTCDataChannelMessage(jsonEncode({
        'type': 'meta',
        'files': fileMetadataList,
      })));

      await Future.delayed(const Duration(milliseconds: 100));

      // 2. Send each file
      for (int i = 0; i < _files.length; i++) {
        final file = _files[i];
        _currentFileName = file.fileName;
        _updateStatus(
          ShareStatus.transferring,
          'Sending ${file.fileName} (${i + 1}/${_files.length})...',
        );

        // Notify file start
        _dataChannel!.send(RTCDataChannelMessage(jsonEncode({
          'type': 'file-start',
          'index': i,
          'name': file.fileName,
          'size': file.size,
        })));

        await Future.delayed(const Duration(milliseconds: 50));

        // Read and send chunks
        if (file.bytes != null) {
          await _sendBytesChunks(file.bytes!);
        } else if (file.path.isNotEmpty) {
          final ioFile = File(file.path);
          if (await ioFile.exists()) {
            final stream = ioFile.openRead();
            await for (final chunk in stream) {
              await _sendUint8List(Uint8List.fromList(chunk));
            }
          }
        }

        // Notify file end
        _dataChannel!.send(RTCDataChannelMessage(jsonEncode({
          'type': 'file-end',
          'index': i,
        })));

        await Future.delayed(const Duration(milliseconds: 50));
      }

      // 3. Notify all files complete
      _dataChannel!.send(RTCDataChannelMessage(jsonEncode({
        'type': 'all-complete',
      })));

      _progress = 1.0;
      _updateStatus(ShareStatus.completed, 'All files sent successfully!');
    } catch (e) {
      _logger.severe('Error during file transfer: $e');
      _updateStatus(ShareStatus.error, 'Transfer failed: $e');
    } finally {
      _stopSpeedTimer();
    }
  }

  Future<void> _sendBytesChunks(Uint8List bytes) async {
    int offset = 0;
    while (offset < bytes.length) {
      final end = (offset + chunkSize < bytes.length) ? offset + chunkSize : bytes.length;
      final sub = bytes.sublist(offset, end);
      await _sendUint8List(sub);
      offset = end;
    }
  }

  Future<void> _sendUint8List(Uint8List chunk) async {
    if (_dataChannel == null || _dataChannel!.state != RTCDataChannelState.RTCDataChannelOpen) {
      throw Exception('DataChannel closed during transfer');
    }

    _dataChannel!.send(RTCDataChannelMessage.fromBinary(chunk));
    _bytesSent += chunk.length;

    if (_totalBytes > 0) {
      _progress = (_bytesSent / _totalBytes).clamp(0.0, 1.0);
    }

    notifyListeners();

    // Flow control: brief yield to prevent buffer bloat
    if (_bytesSent % (chunkSize * 8) == 0) {
      await Future.delayed(const Duration(milliseconds: 1));
    }
  }

  void _startSpeedTimer() {
    _lastBytesSent = _bytesSent;
    _lastSpeedCalcTime = DateTime.now();
    _speedTimer = Timer.periodic(const Duration(milliseconds: 500), (_) {
      final now = DateTime.now();
      final dt = now.difference(_lastSpeedCalcTime).inMilliseconds / 1000.0;
      if (dt > 0) {
        final diff = _bytesSent - _lastBytesSent;
        final bytesPerSec = diff / dt;
        _speedText = '${_formatBytes(bytesPerSec.round())}/s';
        _lastBytesSent = _bytesSent;
        _lastSpeedCalcTime = now;
        notifyListeners();
      }
    });
  }

  void _stopSpeedTimer() {
    _speedTimer?.cancel();
    _speedTimer = null;
    _speedText = '';
  }

  String _formatBytes(int bytes) {
    if (bytes <= 0) return '0 B';
    const suffixes = ['B', 'KB', 'MB', 'GB'];
    final i = (log(bytes) / log(1024)).floor();
    return '${(bytes / pow(1024, i)).toStringAsFixed(1)} ${suffixes[i]}';
  }

  void _updateStatus(ShareStatus newStatus, String msg) {
    _status = newStatus;
    _statusMessage = msg;
    notifyListeners();
  }

  Future<void> stopSharing() async {
    _stopSpeedTimer();

    try {
      if (_wsChannel != null && _roomId != null) {
        _sendSignaling({'type': 'leave', 'roomId': _roomId});
      }
    } catch (_) {}

    await _wsSubscription?.cancel();
    _wsSubscription = null;

    try {
      await _wsChannel?.sink.close();
    } catch (_) {}
    _wsChannel = null;

    try {
      await _dataChannel?.close();
    } catch (_) {}
    _dataChannel = null;

    try {
      await _peerConnection?.close();
      await _peerConnection?.dispose();
    } catch (_) {}
    _peerConnection = null;

    _roomId = null;
    _files = [];
    _bytesSent = 0;
    _progress = 0.0;
    _updateStatus(ShareStatus.idle, 'Idle');
  }

  @override
  void dispose() {
    stopSharing();
    super.dispose();
  }
}

