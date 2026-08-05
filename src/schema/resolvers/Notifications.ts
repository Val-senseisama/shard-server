import {
  catchError,
  logError,
  ThrowError,
} from "../../Helpers/Helpers.js";
import Notification from "../../models/Notifications.js";
import NotificationPreference from "../../models/NotificationPreferences.js";
import { cache, cacheKeys, cacheInvalidate } from "../../Helpers/Cache.js";

/**
 * The client's filter tabs: quests | social | system.
 * Derived server-side from the kind so the categories can't drift from the copy.
 */
function categoryOf(n: { kind?: string; type?: string; shardId?: unknown }): string {
  const k = n.kind || n.type || "";
  if (
    [
      "friend_request",
      "friend_accepted",
      "message",
      "friend_overtook",
      "partner_progress",
      "shard_invite",
    ].includes(k)
  ) {
    return "social";
  }
  if (["trial_ending"].includes(k)) return "system";
  if (
    [
      "quest_deadline",
      "quest_overdue",
      "task_reminder",
      "tasks_missed",
      "daily_digest",
      "shard_update",
      "shard_completed",
      "inactivity_nudge",
      "empty_schedule",
      "task_assigned",
    ].includes(k)
  ) {
    return "quests";
  }
  if (["achievement", "level_up", "streak_milestone", "streak_freeze_used"].includes(k)) {
    return "rewards";
  }
  if (["streak_at_risk", "streak_broken", "activation_nudge", "dormant_winback"].includes(k)) {
    return "quests";
  }
  // Unknown/legacy rows: fall back to whether they point at a shard.
  return n.shardId ? "quests" : "system";
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

      // Clears the paginated list keys AND the unread badge. A plain
      // `del('notifications:{id}')` never matched anything: the real keys carry
      // skip/limit suffixes.
      await cacheInvalidate.notifications(context.id);

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

      // Clears the paginated list keys AND the unread badge. A plain
      // `del('notifications:{id}')` never matched anything: the real keys carry
      // skip/limit suffixes.
      await cacheInvalidate.notifications(context.id);

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
      await cache.del(cacheKeys.notificationPreferences(context.id));

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

      // Clears the paginated list keys AND the unread badge. A plain
      // `del('notifications:{id}')` never matched anything: the real keys carry
      // skip/limit suffixes.
      await cacheInvalidate.notifications(context.id);

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
              // `type`/`kind`/`data` are returned so the client can categorise
              // and deep-link properly. Without them the app was inferring
              // category by substring-matching the message text, which broke
              // silently on any copy change.
              .select("message type kind priority data shardId miniGoalId read triggerAt createdAt")
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
          type: n.type || null,
          kind: n.kind || null,
          category: categoryOf(n),
          screen: n.data?.screen ?? null,
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

