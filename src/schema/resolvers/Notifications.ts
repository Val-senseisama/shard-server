import {
  catchError,
  logError,
  ThrowError,
} from "../../Helpers/Helpers.js";
import Notification from "../../models/Notifications.js";
import NotificationPreference from "../../models/NotificationPreferences.js";
import Shard from "../../models/Shard.js";
import { User } from "../../models/User.js";
import { cache, cacheInvalidate } from "../../Helpers/Cache.js";
import { sendEmailToUser } from "../../Helpers/ResendEmail.js";

/**
 * Calculate next time quiet hours end (so we can schedule the push for then).
 */
function nextQuietHoursEnd(preferences: any): Date {
  const [endHour, endMin] = (preferences.quietHoursEnd || "08:00")
    .split(":")
    .map(Number);
  const result = new Date();
  result.setHours(endHour, endMin, 0, 0);
  if (result <= new Date()) {
    // The end time already passed today — push to tomorrow
    result.setDate(result.getDate() + 1);
  }
  return result;
}

/**
 * Create a notification.
 * Always stores the in-app notification immediately.
 * If currently in quiet hours the push/email is deferred to when quiet hours end
 * (tracked via triggerAt + dispatched=false, picked up by the dispatcher cron).
 * If not in quiet hours the record is marked dispatched=true — the resolver
 * is responsible for firing the FCM push via sendNotificationToUser().
 */
export async function createNotification(
  userId: string,
  message: string,
  type: string,
  options?: { shardId?: string; miniGoalId?: string; triggerAt?: Date }
) {
  // Check user preferences
  const preferences = await NotificationPreference.findOne({ userId }).lean();

  // If the user has explicitly disabled this notification type, skip entirely
  if (preferences && !shouldNotify(preferences, type)) {
    return;
  }

  const inQuietHours =
    preferences?.quietHoursEnabled && isQuietHours(preferences);

  // When in quiet hours: defer push/email until quiet hours end.
  // When not in quiet hours: mark dispatched immediately — resolver sends push.
  const triggerAt = options?.triggerAt
    ? options.triggerAt
    : inQuietHours
      ? nextQuietHoursEnd(preferences)
      : new Date();

  const dispatched = !inQuietHours;

  try {
    const notification = await Notification.create({
      userId,
      message,
      type,
      shardId: options?.shardId,
      miniGoalId: options?.miniGoalId,
      triggerAt,
      dispatched,
      read: false,
    });

    // Invalidate notifications cache
    await cacheInvalidate.user(userId);

    // Fire email immediately only when not in quiet hours
    // (quiet-hours email is sent by the dispatcher cron)
    if (!inQuietHours) {
      sendEmailToUser(userId, type, { message }).catch(() => {});
    }

    return notification;
  } catch (error) {
    logError("createNotification", error);
    return null;
  }
}

/**
 * Check if notification type is enabled
 */
function shouldNotify(preferences: any, type: string): boolean {
  switch (type) {
    case "friend_request":
      return preferences.friendRequests !== false;
    case "message":
      return preferences.messages !== false;
    case "shard_invite":
      return preferences.shardInvites !== false;
    case "shard_update":
      return preferences.shardUpdates !== false;
    case "quest_deadline":
      return preferences.questDeadlines !== false;
    case "achievement":
      return preferences.achievements !== false;
    default:
      return true;
  }
}

/**
 * Check if currently in quiet hours
 */
function isQuietHours(preferences: any): boolean {
  if (!preferences.quietHoursEnabled) return false;

  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentTime = `${String(currentHour).padStart(2, "0")}:${String(currentMinute).padStart(2, "0")}`;

  const start = preferences.quietHoursStart;
  const end = preferences.quietHoursEnd;

  // Simple time comparison
  if (start <= end) {
    // Same day quiet hours (e.g., 22:00 to 01:00 next day)
    return currentTime >= start || currentTime < end;
  } else {
    // Overnight quiet hours (e.g., 22:00 to 08:00 next day)
    return currentTime >= start || currentTime < end;
  }
}

export default {
  Mutation: {
    // Mark notification as read
    async markNotificationRead(_, { notificationId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, notification] = await catchError(
        Notification.findById(notificationId).lean()
      );

      if (error || !notification) {
        return {
          success: false,
          message: "Notification not found.",
        };
      }

      if (notification.userId.toString() !== context.id) {
        return {
          success: false,
          message: "This notification doesn't belong to you.",
        };
      }

      await Notification.findByIdAndUpdate(notificationId, {
        read: true,
      });

      // Invalidate cache
      await cache.del(`notifications:${context.id}`);

      return {
        success: true,
        message: "Notification marked as read.",
      };
    },

    // Mark all notifications as read
    async markAllNotificationsRead(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      await Notification.updateMany(
        { userId: context.id, read: false },
        { read: true }
      );

      // Invalidate cache
      await cache.del(`notifications:${context.id}`);

      return {
        success: true,
        message: "All notifications marked as read.",
      };
    },

    // Update notification preferences
    async updateNotificationPreferences(_, { input }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, preferences] = await catchError(
        NotificationPreference.findOneAndUpdate(
          { userId: context.id },
          { ...input, userId: context.id },
          { upsert: true, new: true }
        )
      );

      if (error) {
        logError("updateNotificationPreferences", error);
        return {
          success: false,
          message: "Failed to update preferences.",
        };
      }

      // Invalidate cache
      await cache.del(`notificationPreferences:${context.id}`);

      return {
        success: true,
        message: "Preferences updated successfully.",
        preferences: {
          friendRequests: preferences.friendRequests,
          messages: preferences.messages,
          shardInvites: preferences.shardInvites,
          shardUpdates: preferences.shardUpdates,
          questDeadlines: preferences.questDeadlines,
          achievements: preferences.achievements,
          quietHoursEnabled: preferences.quietHoursEnabled,
          quietHoursStart: preferences.quietHoursStart,
          quietHoursEnd: preferences.quietHoursEnd,
          pushEnabled: preferences.pushEnabled,
          emailEnabled: preferences.emailEnabled,
        },
      };
    },

    // Delete notification
    async deleteNotification(_, { notificationId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, notification] = await catchError(
        Notification.findById(notificationId).lean()
      );

      if (error || !notification) {
        return {
          success: false,
          message: "Notification not found.",
        };
      }

      if (notification.userId.toString() !== context.id) {
        return {
          success: false,
          message: "This notification doesn't belong to you.",
        };
      }

      await Notification.findByIdAndDelete(notificationId);

      // Invalidate cache
      await cache.del(`notifications:${context.id}`);

      return {
        success: true,
        message: "Notification deleted.",
      };
    },
  },

  Query: {
    // Get user's notifications
    async getNotifications(_, { limit, skip, shardId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const cacheKey = shardId
        ? `notifications:${context.id}:${shardId}:${skip || 0}:${limit || 20}`
        : `notifications:${context.id}:${skip || 0}:${limit || 20}`;

      const notifications = await cache.getOrSet(
        cacheKey,
        async () => {
          const query: any = { userId: context.id };
          if (shardId) {
            query.shardId = shardId;
          }

          const [error, notificationList] = await catchError(
            Notification.find(query)
              .sort({ createdAt: -1 })
              .limit(limit || 20)
              .skip(skip || 0)
              .select("message shardId miniGoalId read triggerAt createdAt")
              .lean()
          );

          if (error) {
            logError("getNotifications", error);
            return [];
          }

          return notificationList;
        },
        900 // 15 minutes
      );

      return {
        success: true,
        notifications: notifications.map((n: any) => ({
          id: n._id.toString(),
          message: n.message,
          shardId: n.shardId?.toString(),
          miniGoalId: n.miniGoalId?.toString(),
          read: n.read,
          triggerAt: n.triggerAt,
          createdAt: n.createdAt,
        })),
      };
    },

    // Get unread count
    async getUnreadNotificationCount(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const count = await cache.getOrSet(
        `unreadCount:${context.id}`,
        async () => {
          const [error, unreadCount] = await catchError(
            Notification.countDocuments({
              userId: context.id,
              read: false,
            })
          );

          if (error) {
            logError("getUnreadNotificationCount", error);
            return 0;
          }

          return unreadCount || 0;
        },
        300 // 5 minutes
      );

      return {
        success: true,
        count,
      };
    },

    // Get notification preferences
    async getNotificationPreferences(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const preferences = await cache.getOrSet(
        `notificationPreferences:${context.id}`,
        async () => {
          const [error, prefs] = await catchError(
            NotificationPreference.findOne({ userId: context.id }).lean()
          );

          if (error || !prefs) {
            // Return default preferences
            return {
              friendRequests: true,
              messages: true,
              shardInvites: true,
              shardUpdates: true,
              questDeadlines: true,
              achievements: true,
              quietHoursEnabled: false,
              quietHoursStart: "22:00",
              quietHoursEnd: "08:00",
              pushEnabled: true,
              emailEnabled: false,
            };
          }

          return prefs;
        },
        3600 // 1 hour
      );

      return {
        success: true,
        preferences: {
          friendRequests: preferences.friendRequests,
          messages: preferences.messages,
          shardInvites: preferences.shardInvites,
          shardUpdates: preferences.shardUpdates,
          questDeadlines: preferences.questDeadlines,
          achievements: preferences.achievements,
          quietHoursEnabled: preferences.quietHoursEnabled,
          quietHoursStart: preferences.quietHoursStart,
          quietHoursEnd: preferences.quietHoursEnd,
          pushEnabled: preferences.pushEnabled,
          emailEnabled: preferences.emailEnabled,
        },
      };
    },
  },
};

