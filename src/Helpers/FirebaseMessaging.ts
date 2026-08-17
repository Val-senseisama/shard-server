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

// Time-of-day helpers live in Helpers/Timezone.ts now — there were three
// divergent copies of this logic (here, the Notifications resolver, and
// ResendEmail) and only this one was timezone-aware. Re-exported so existing
// importers keep working.
export { localHour, dateKeyInZone, currentTimeInZone } from './Timezone.js';
import { currentTimeInZone, isWithinWindow } from './Timezone.js';

/**
 * Check if notification should be sent based on user preferences.
 *
 * Prefer `notify()` in Helpers/Notify.ts — it applies this plus the daily
 * budget, dedupe and telemetry. This stays exported for the low-level paths.
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

    // Quiet hours are evaluated in the USER's timezone, not the server's.
    if (prefs.quietHoursEnabled && prefs.quietHoursStart && prefs.quietHoursEnd) {
      const user = await User.findById(userId).select('timezone').lean();
      const currentTime = currentTimeInZone((user as any)?.timezone);
      if (isWithinWindow(prefs.quietHoursStart, prefs.quietHoursEnd, currentTime)) {
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
  badge?: number,
  /**
   * Groups pushes that supersede one another — pass the same key (e.g.
   * `chat:<id>`) and the newest one REPLACES the previous in the tray instead of
   * stacking under it. Without this, a chat that gets ten messages leaves ten
   * separate rows the user has to clear one by one.
   */
  collapseKey?: string
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
      android: {
        ...(collapseKey ? { collapseKey } : {}),
        notification: {
          channelId,
          ...(badge != null ? { notificationCount: badge } : {}),
          // `tag` is the tray-level replace key on Android; `collapseKey` only
          // governs what FCM does to undelivered messages in transit.
          ...(collapseKey ? { tag: collapseKey } : {}),
        },
      },
      ...(badge != null || collapseKey
        ? {
            apns: {
              // APNs caps this at 64 bytes and rejects the whole request if it
              // is longer.
              ...(collapseKey
                ? { headers: { 'apns-collapse-id': collapseKey.slice(0, 64) } }
                : {}),
              payload: { aps: { ...(badge != null ? { badge } : {}) } },
            },
          }
        : {}),
      tokens: tokens,
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    if (response.failureCount > 0) {
      // Only prune tokens FCM says are permanently dead. The previous version
      // pulled every token that failed for any reason, so one transient
      // `messaging/internal-error` or a quota blip permanently unregistered a
      // live device — the user silently stopped receiving push forever, and
      // nothing surfaced it because re-registration only happens on app launch.
      const deadTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (resp.success) return;
        if (isPermanentTokenFailure(resp.error?.code)) deadTokens.push(tokens[idx]);
      });
      console.warn(
        `⚠️ Some notifications failed: ${response.failureCount} (${deadTokens.length} dead token(s) pruned)`
      );

      if (deadTokens.length > 0) await cleanupInvalidTokens(deadTokens);
    }

    return response.successCount > 0;
  } catch (error) {
    logError('sendNotificationToTokens', error);
    return false;
  }
};

/**
 * Does this FCM error mean the token will never work again?
 *
 * Everything else — unavailable, internal, quota, timeouts — is transient and
 * the token must be kept.
 */
const isPermanentTokenFailure = (code?: string): boolean =>
  code === 'messaging/registration-token-not-registered' ||
  code === 'messaging/invalid-registration-token' ||
  code === 'messaging/invalid-argument';

/**
 * Remove permanently dead tokens from database
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
