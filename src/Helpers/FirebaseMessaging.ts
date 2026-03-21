import admin from 'firebase-admin';
import { logError } from './Helpers.js';
import dotenv from 'dotenv';
import {User } from '../models/User.js';
import NotificationPreferences from '../models/NotificationPreferences.js';

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
    
    // Check quiet hours
    if (prefs.quietHoursEnabled && prefs.quietHoursStart && prefs.quietHoursEnd) {
      const now = new Date();
      const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
      
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
    return await sendNotificationToTokens(tokens, notification);
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
    
    let allTokens: string[] = [];
    users.forEach(user => {
      if (user.pushTokens && user.pushTokens.length > 0) {
        allTokens = [...allTokens, ...user.pushTokens.map(t => t.token)];
      }
    });

    if (allTokens.length === 0) return 0;

    // Remove duplicates
    allTokens = [...new Set(allTokens)];
    
    await sendNotificationToTokens(allTokens, notification);
    return allTokens.length;
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
  }
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
