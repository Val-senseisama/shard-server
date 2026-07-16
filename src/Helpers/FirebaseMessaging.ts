import admin from 'firebase-admin';
import { logError } from './Helpers.js';
import dotenv from 'dotenv';
import {User } from '../models/User.js';
import NotificationPreferences from '../models/NotificationPreferences.js';
import Notification from '../models/Notifications.js';

dotenv.config();

let isInitialized = false;

/**
 * Initialize Firebase Admin SDK
 */
export const initializeFirebase = () => {
  if (isInitialized) return;

  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!serviceAccountJson) {
      console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not set. Push notifications will not work.');
      return;
    }

    const serviceAccount = JSON.parse(serviceAccountJson);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    isInitialized = true;
    console.log('✅ Firebase Admin SDK initialized');
  } catch (error) {
    console.error('❌ Failed to initialize Firebase Admin:', error);
  }
};

/**
 * "HH:mm" for right now in `timezone`. Falls back to server-local time (UTC on
 * Railway) if the stored timezone string isn't IANA-valid, e.g. never set.
 */
const currentTimeInZone = (timezone: string | undefined): string => {
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${hh}:${mm}`;
  } catch {
    return `${now.getUTCHours().toString().padStart(2, '0')}:${now.getUTCMinutes().toString().padStart(2, '0')}`;
  }
};

/**
 * The hour (0-23) it currently is in `timezone`. Falls back to server-local
 * (UTC) if the stored timezone string isn't IANA-valid.
 */
export const localHour = (timezone?: string): number => {
  try {
    return parseInt(
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'UTC', hour: '2-digit', hourCycle: 'h23' }).format(new Date()),
      10
    );
  } catch {
    return new Date().getUTCHours();
  }
};

/** "YYYY-MM-DD" for `date` as seen from `timezone` — for same-local-day comparisons. */
export const dateKeyInZone = (date: Date, timezone?: string): string => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
};

/**
 * Check if notification should be sent based on user preferences
 */
export const shouldSendNotification = async (
  userId: string,
  notificationType: 'messages' | 'shardInvites' | 'shardUpdates' | 'questDeadlines' | 'friendRequests' | 'achievements'
): Promise<boolean> => {
  try {
    const prefs = await NotificationPreferences.findOne({ userId }).lean();

    if (!prefs) return true;
    if (!prefs.pushEnabled) return false;
    if (prefs[notificationType] === false) return false;

    // Check quiet hours — evaluated in the USER's timezone, not the server's.
    // Server runs in UTC (Railway); comparing against server-local time meant
    // "22:00-08:00" was silently wrong for every non-UTC user (same bug class
    // as the schedule bucketing fix — see helpers/dateKeys.ts on the client).
    if (prefs.quietHoursEnabled && prefs.quietHoursStart && prefs.quietHoursEnd) {
      const user = await User.findById(userId).select('timezone').lean();
      const currentTime = currentTimeInZone((user as any)?.timezone);

      const isInQuietHours = (start: string, end: string, current: string) => {
        return start <= end ? (current >= start && current <= end) : (current >= start || current <= end);
      };

      if (isInQuietHours(prefs.quietHoursStart, prefs.quietHoursEnd, currentTime)) {
        return false;
      }
    }

    return true;
  } catch (error) {
    logError('shouldSendNotification', error);
    return true;
  }
};

/** Unread in-app notification count — what the app icon badge should read. */
export const getUnreadBadgeCount = async (userId: string): Promise<number> => {
  try {
    return await Notification.countDocuments({ userId, read: false });
  } catch (error) {
    logError('getUnreadBadgeCount', error);
    return 0;
  }
};

/**
 * Android notification channel to route a push into. The client (see
 * services/notificationService.ts) creates exactly three channels — 'default',
 * 'shard-updates', 'messages' — but FCM messages never set `android.notification.
 * channelId`, so every push has actually been landing in 'default' regardless
 * of type. That defeats the point of having separate channels (users can't mute
 * "messages" without muting deadline/achievement alerts too, importance/sound
 * per channel is ignored, etc).
 */
export const channelForType = (type?: string): string => {
  if (!type) return 'default';
  const t = type.toLowerCase();
  return t.startsWith('message') ? 'messages' : 'shard-updates';
};

/**
 * Send notification to a specific user
 */
export const sendNotificationToUser = async (
  userId: string,
  notification: {
    title: string;
    body: string;
    data?: Record<string, string>;
  },
  notificationType?: 'messages' | 'shardInvites' | 'shardUpdates' | 'questDeadlines' | 'friendRequests' | 'achievements'
): Promise<boolean> => {
  if (!isInitialized) initializeFirebase();
  if (!isInitialized) return false;

  // Check preferences if notification type provided
  if (notificationType) {
    const shouldSend = await shouldSendNotification(userId, notificationType);
    if (!shouldSend) return false;
  }

  try {
    const user = await User.findById(userId).select('pushTokens').lean();

    if (!user || !user.pushTokens || user.pushTokens.length === 0) {
      return false;
    }

    const tokens = user.pushTokens.map(t => t.token);
    const badge = await getUnreadBadgeCount(userId);
    return await sendNotificationToTokens(tokens, notification, channelForType(notificationType), badge);
  } catch (error) {
    console.log('❌ Failed to send notification to user:', error);
    logError('sendNotificationToUser', error);
    return false;
  }
};

/**
 * Send notification to multiple users
 */
export const sendNotificationToUsers = async (
  userIds: string[],
  notification: {
    title: string;
    body: string;
    data?: Record<string, string>;
  },
  notificationType?: 'messages' | 'shardInvites' | 'shardUpdates' | 'questDeadlines' | 'friendRequests' | 'achievements'
): Promise<number> => {
  if (!isInitialized) initializeFirebase();
  if (!isInitialized) return 0;

  try {
    // Filter users based on preferences if notification type provided
    let filteredUserIds = userIds;
    if (notificationType) {
      const checks = await Promise.all(
        userIds.map(async (id) => ({
          id,
          shouldSend: await shouldSendNotification(id, notificationType)
        }))
      );
      filteredUserIds = checks.filter(c => c.shouldSend).map(c => c.id);
      if (filteredUserIds.length === 0) {
        console.log(`📵 All users have disabled ${notificationType} notifications`);
        return 0;
      }
    }

    const users = await User.find({ _id: { $in: filteredUserIds } }).select('pushTokens').lean();
    const usersWithTokens = users.filter(u => u.pushTokens && u.pushTokens.length > 0);

    if (usersWithTokens.length === 0) return 0;

    // One multicast per user rather than one big flat multicast, because the
    // badge count is per-user (unread count) and a single FCM message can only
    // carry one badge value for every token it's sent to.
    const channelId = channelForType(notificationType);
    let tokenCount = 0;
    await Promise.all(
      usersWithTokens.map(async (user) => {
        const tokens = [...new Set(user.pushTokens!.map(t => t.token))];
        const badge = await getUnreadBadgeCount(user._id.toString());
        await sendNotificationToTokens(tokens, notification, channelId, badge);
        tokenCount += tokens.length;
      })
    );
    return tokenCount;
  } catch (error) {
    logError('sendNotificationToUsers', error);
    return 0;
  }
};

/**
 * Send notification to specific tokens
 */
export const sendNotificationToTokens = async (
  tokens: string[],
  notification: {
    title: string;
    body: string;
    data?: Record<string, string>;
  },
  channelId: string = 'default',
  badge?: number
): Promise<boolean> => {
  if (!isInitialized) initializeFirebase();
  if (!isInitialized) return false;

  if (tokens.length === 0) return false;

  try {
    // Expo requires specific format if using their FCM wrapper, but standard FCM works too
    // For Expo push tokens, we might need to use Expo's API if not using FCM directly
    // Assuming we are using FCM tokens or Expo tokens via FCM

    const message = {
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: notification.data || {},
      android: { notification: { channelId, ...(badge != null ? { notificationCount: badge } : {}) } },
      ...(badge != null ? { apns: { payload: { aps: { badge } } } } : {}),
      tokens: tokens,
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    
    if (response.failureCount > 0) {
      const failedTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          failedTokens.push(tokens[idx]);
        }
      });
      console.warn('⚠️ Some notifications failed:', response.failureCount);
      
      // Cleanup invalid tokens
      await cleanupInvalidTokens(failedTokens);
    }

    return true;
  } catch (error) {
    logError('sendNotificationToTokens', error);
    return false;
  }
};

/**
 * Remove invalid tokens from database
 */
const cleanupInvalidTokens = async (tokens: string[]) => {
  try {
    await User.updateMany(
      { 'pushTokens.token': { $in: tokens } },
      { $pull: { pushTokens: { token: { $in: tokens } } } }
    );
  } catch (error) {
    logError('cleanupInvalidTokens', error);
  }
};
