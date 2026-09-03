import 'dart:async';
import 'dart:io';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';

class StatusNotificationService {
  static const int _notificationId = 1001;
  static const String _channelId = 'sharing_status';
  static const String _channelName = 'Sharing status';

  static final FlutterLocalNotificationsPlugin _notifications =
      FlutterLocalNotificationsPlugin();
  static Future<void>? _initialization;

  static Future<void> initialize() {
    if (!Platform.isAndroid) return Future<void>.value();
    return _initialization ??= _initializeAndroid();
  }

  static Future<void> _initializeAndroid() async {
    const settings = AndroidInitializationSettings('@mipmap/ic_launcher');
    await _notifications.initialize(
      const InitializationSettings(android: settings),
    );

    final android = _notifications.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();
    await android?.requestNotificationsPermission();
  }

  static void showStatus(String message) {
    if (!Platform.isAndroid) return;
    unawaited(_showStatus(message));
  }

  static Future<void> _showStatus(String message) async {
    await initialize();
    const androidDetails = AndroidNotificationDetails(
      _channelId,
      _channelName,
      channelDescription: 'Shows the current file-sharing connection status',
      importance: Importance.low,
      priority: Priority.low,
      ongoing: true,
      autoCancel: false,
      onlyAlertOnce: true,
      playSound: false,
      enableVibration: false,
      category: AndroidNotificationCategory.service,
    );
    await _notifications.show(
      _notificationId,
      'JustTouch sharing',
      message,
      const NotificationDetails(android: androidDetails),
    );
  }

  static void cancel() {
    if (!Platform.isAndroid) return;
    unawaited(_notifications.cancel(_notificationId));
  }
}
