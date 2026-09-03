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

  // Fallback & Flow control
  Timer? _fallbackTimer;
  bool _isTransferring = false;
  bool _isRelayMode = false;
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
    _isTransferring = false;
    _isRelayMode = false;
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
            _logger.info('Receiver detected! Attempting WebRTC P2P with Relay fallback...');
            _updateStatus(ShareStatus.negotiating, 'Receiver connected! Negotiating connection...');
            await _initiatePeerConnection();

            // Set a fallback timer: if direct P2P DataChannel is not open within 2.5s, fallback to WebSocket relay
            _fallbackTimer = Timer(const Duration(milliseconds: 2500), () {
              if (!_isTransferring && _status != ShareStatus.completed) {
                _startWebSocketRelayTransfer();
              }
            });
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
        {'urls': 'stun:stun.relay.metered.ca:80'},
        {
          'urls': 'turn:openrelay.metered.ca:80',
          'username': 'openrelay',
          'credential': 'openrelay',
        },
        {
          'urls': 'turn:openrelay.metered.ca:443',
          'username': 'openrelay',
          'credential': 'openrelay',
        },
        {
          'urls': 'turn:openrelay.metered.ca:443?transport=tcp',
          'username': 'openrelay',
          'credential': 'openrelay',
        },
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
        _fallbackTimer?.cancel();
        _updateStatus(ShareStatus.connected, 'Direct P2P Connection Ready');
      } else if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        _logger.warning('Direct P2P failed, activating WebSocket relay immediately');
        _fallbackTimer?.cancel();
        if (!_isTransferring && _status != ShareStatus.completed) {
          _startWebSocketRelayTransfer();
        }
      }
    };

    _peerConnection!.onIceConnectionState = (state) {
      _logger.info('IceConnectionState: $state');
    };

    final init = RTCDataChannelInit()
      ..ordered = true
      ..maxRetransmits = 30;

    _dataChannel = await _peerConnection!.createDataChannel('fileTransfer', init);

    _dataChannel!.onDataChannelState = (state) {
      _logger.info('DataChannel state: $state');
      if (state == RTCDataChannelState.RTCDataChannelOpen) {
        _fallbackTimer?.cancel();
        if (!_isTransferring) {
          _updateStatus(ShareStatus.transferring, 'Sending files via direct P2P...');
          _startP2PFileTransfer();
        }
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

  // Direct WebRTC P2P Transfer
  Future<void> _startP2PFileTransfer() async {
    if (_dataChannel == null || _dataChannel!.state != RTCDataChannelState.RTCDataChannelOpen) return;
    _isTransferring = true;
    _isRelayMode = false;
    _startSpeedTimer();

    try {
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

      for (int i = 0; i < _files.length; i++) {
        final file = _files[i];
        _currentFileName = file.fileName;
        _updateStatus(
          ShareStatus.transferring,
          'Sending ${file.fileName} (${i + 1}/${_files.length})...',
        );

        _dataChannel!.send(RTCDataChannelMessage(jsonEncode({
          'type': 'file-start',
          'index': i,
          'name': file.fileName,
          'size': file.size,
        })));

        await Future.delayed(const Duration(milliseconds: 50));

        if (file.bytes != null) {
          await _sendP2PBytesChunks(file.bytes!);
        } else if (file.path.isNotEmpty) {
          final ioFile = File(file.path);
          if (await ioFile.exists()) {
            final stream = ioFile.openRead();
            await for (final chunk in stream) {
              await _sendP2PUint8List(Uint8List.fromList(chunk));
            }
          }
        }

        _dataChannel!.send(RTCDataChannelMessage(jsonEncode({
          'type': 'file-end',
          'index': i,
        })));

        await Future.delayed(const Duration(milliseconds: 50));
      }

      _dataChannel!.send(RTCDataChannelMessage(jsonEncode({
        'type': 'all-complete',
      })));

      _progress = 1.0;
      _updateStatus(ShareStatus.completed, 'All files sent successfully!');
    } catch (e) {
      _logger.severe('Error during P2P file transfer: $e');
      _updateStatus(ShareStatus.error, 'Transfer failed: $e');
    } finally {
      _stopSpeedTimer();
    }
  }

  Future<void> _sendP2PBytesChunks(Uint8List bytes) async {
    int offset = 0;
    while (offset < bytes.length) {
      final end = (offset + chunkSize < bytes.length) ? offset + chunkSize : bytes.length;
      final sub = bytes.sublist(offset, end);
      await _sendP2PUint8List(sub);
      offset = end;
    }
  }

  Future<void> _sendP2PUint8List(Uint8List chunk) async {
    if (_dataChannel == null || _dataChannel!.state != RTCDataChannelState.RTCDataChannelOpen) {
      throw Exception('DataChannel closed during transfer');
    }

    _dataChannel!.send(RTCDataChannelMessage.fromBinary(chunk));
    _bytesSent += chunk.length;

    if (_totalBytes > 0) {
      _progress = (_bytesSent / _totalBytes).clamp(0.0, 1.0);
    }
    notifyListeners();

    if (_bytesSent % (chunkSize * 8) == 0) {
      await Future.delayed(const Duration(milliseconds: 1));
    }
  }

  // WebSocket Relay Transfer Fallback (Guaranteed for Cellular 4G/5G)
  Future<void> _startWebSocketRelayTransfer() async {
    if (_wsChannel == null || _isTransferring) return;
    _isTransferring = true;
    _isRelayMode = true;
    _startSpeedTimer();

    _updateStatus(
      ShareStatus.transferring,
      'Sending files via Secure Relay (Cellular)...',
    );

    try {
      final fileMetadataList = _files.map((f) => {
        'name': f.fileName,
        'size': f.size,
        'mimeType': f.mimeType,
      }).toList();

      // Notify receiver that relay mode is activated
      _sendSignaling({
        'type': 'relay',
        'roomId': _roomId,
        'data': {'type': 'relay-activated'},
      });

      await Future.delayed(const Duration(milliseconds: 80));

      // Send Metadata
      _sendSignaling({
        'type': 'relay',
        'roomId': _roomId,
        'data': {
          'type': 'meta',
          'files': fileMetadataList,
        },
      });

      await Future.delayed(const Duration(milliseconds: 100));

      // Stream each file
      for (int i = 0; i < _files.length; i++) {
        final file = _files[i];
        _currentFileName = file.fileName;
        _updateStatus(
          ShareStatus.transferring,
          'Sending ${file.fileName} (${i + 1}/${_files.length})...',
        );

        _sendSignaling({
          'type': 'relay',
          'roomId': _roomId,
          'data': {
            'type': 'file-start',
            'index': i,
            'name': file.fileName,
            'size': file.size,
          },
        });

        await Future.delayed(const Duration(milliseconds: 50));

        if (file.bytes != null) {
          await _sendRelayBytesChunks(file.bytes!);
        } else if (file.path.isNotEmpty) {
          final ioFile = File(file.path);
          if (await ioFile.exists()) {
            final stream = ioFile.openRead();
            await for (final chunk in stream) {
              await _sendRelayUint8List(Uint8List.fromList(chunk));
            }
          }
        }

        _sendSignaling({
          'type': 'relay',
          'roomId': _roomId,
          'data': {
            'type': 'file-end',
            'index': i,
          },
        });

        await Future.delayed(const Duration(milliseconds: 50));
      }

      _sendSignaling({
        'type': 'relay',
        'roomId': _roomId,
        'data': {'type': 'all-complete'},
      });

      _progress = 1.0;
      _updateStatus(ShareStatus.completed, 'All files sent successfully!');
    } catch (e) {
      _logger.severe('Error during relay transfer: $e');
      _updateStatus(ShareStatus.error, 'Relay transfer failed: $e');
    } finally {
      _stopSpeedTimer();
    }
  }

  Future<void> _sendRelayBytesChunks(Uint8List bytes) async {
    int offset = 0;
    while (offset < bytes.length) {
      final end = (offset + chunkSize < bytes.length) ? offset + chunkSize : bytes.length;
      final sub = bytes.sublist(offset, end);
      await _sendRelayUint8List(sub);
      offset = end;
    }
  }

  Future<void> _sendRelayUint8List(Uint8List chunk) async {
    if (_wsChannel == null) throw Exception('WebSocket closed during relay transfer');

    _wsChannel!.sink.add(chunk);
    _bytesSent += chunk.length;

    if (_totalBytes > 0) {
      _progress = (_bytesSent / _totalBytes).clamp(0.0, 1.0);
    }
    notifyListeners();

    // Flow control: slight pause to prevent buffer bloat over websocket
    if (_bytesSent % (chunkSize * 4) == 0) {
      await Future.delayed(const Duration(milliseconds: 2));
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
    _fallbackTimer?.cancel();
    _fallbackTimer = null;
    _stopSpeedTimer();
    _isTransferring = false;
    _isRelayMode = false;

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
