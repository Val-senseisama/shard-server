import {
  catchError,
  logError,
  SaveAuditTrail,
  ThrowError,
} from "../../Helpers/Helpers.js";
import Friendship from "../../models/Friendship.js";
import { User } from "../../models/User.js";
import { cache, cacheKeys, cacheInvalidate } from "../../Helpers/Cache.js";
import { createNotification } from "./Notifications.js";
import { sendNotificationToUser } from "../../Helpers/FirebaseMessaging.js";
import { isUserOnline } from "../../server/WebSocketServer.js";

export default {
  Mutation: {
    // Send friend request
    async sendFriendRequest(_, { friendId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      if (context.id === friendId) {
        return {
          success: false,
          message: "You cannot send a friend request to yourself.",
        };
      }

      // Check if friendship already exists
      const [existingError, existingFriendship] = await catchError(
        Friendship.findOne({
          $or: [
            { user: context.id, friend: friendId },
            { user: friendId, friend: context.id },
          ],
        }).lean()
      );

      if (existingError) {
        logError("sendFriendRequest:findExisting", existingError);
        return {
          success: false,
          message: "An error occurred.",
        };
      }

      if (existingFriendship) {
        return {
          success: false,
          message:
            existingFriendship.status === "accepted"
              ? "You are already friends."
              : "Friend request already exists.",
        };
      }

      // Check if friend exists
      const [friendError, friend] = await catchError(
        User.findById(friendId).select("username").lean()
      );

      if (friendError || !friend) {
        return {
          success: false,
          message: "User not found.",
        };
      }

      // Create friend request (bidirectional)
      const [createError] = await catchError(
        Promise.all([
          Friendship.create({
            user: context.id,
            friend: friendId,
            status: "pending",
            requestedBy: context.id,
          }),
          // Create reverse friendship
          Friendship.create({
            user: friendId,
            friend: context.id,
            status: "pending",
            requestedBy: context.id,
          }),
        ])
      );

      if (createError) {
        logError("sendFriendRequest:create", createError);
        return {
          success: false,
          message: "Failed to send friend request.",
        };
      }

      // Fire-and-forget: cache, notifications, audit trail
      cacheInvalidate.friendship(context.id, friendId).catch((e) => logError("sendFriendRequest:cacheInvalidate", e));

      createNotification(
        friendId,
        `${friend.username} wants to be friends with you`,
        "friend_request"
      ).catch((e) => logError("sendFriendRequest:createNotification", e));

      sendNotificationToUser(
        friendId,
        {
          title: "New Friend Request",
          body: `${friend.username} wants to be friends with you!`,
          data: { screen: "/(screens)/friends" }
        },
        'friendRequests'
      ).catch((e) => logError("sendFriendRequest:pushNotification", e));

      SaveAuditTrail({
        userId: context.id,
        task: "Sent Friend Request",
        details: `Sent friend request to ${friend.username}`,
      });

      return {
        success: true,
        message: "Friend request sent successfully.",
      };
    },

    // Accept friend request
    async acceptFriendRequest(_, { friendId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, friendship] = await catchError(
        Friendship.findOne({
          user: context.id,
          friend: friendId,
          status: "pending",
        }).lean()
      );

      if (error || !friendship) {
        return {
          success: false,
          message: "Friend request not found.",
        };
      }

      // Update both sides to accepted
      const acceptedAt = new Date();
      await Promise.all([
        Friendship.findOneAndUpdate(
          { user: context.id, friend: friendId },
          { status: "accepted", acceptedAt }
        ),
        Friendship.findOneAndUpdate(
          { user: friendId, friend: context.id },
          { status: "accepted", acceptedAt }
        ),
      ]);

      // Invalidate cache
      await cacheInvalidate.friendship(context.id, friendId);

      // Get requester's username for notification
      const [requesterError, requester] = await catchError(
        User.findById(friendId).select("username").lean()
      );

      if (!requesterError && requester) {
        await createNotification(
          friendId,
          `${context.id} accepted your friend request!`,
          "friend_request"
        );

        // Send Push Notification
        await sendNotificationToUser(
          friendId,
          {
            title: "Friend Request Accepted",
            body: `${requester.username} is now your friend!`,
            data: { screen: "/(screens)/friends" }
          },
          'friendRequests' // Check friend request notification preferences
        );
      }

      SaveAuditTrail({
        userId: context.id,
        task: "Accepted Friend Request",
        details: `Accepted friend request from ${friendId}`,
      });

      return {
        success: true,
        message: "Friend request accepted.",
      };
    },

    // Reject friend request
    async rejectFriendRequest(_, { friendId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Delete both friendship records
      await Promise.all([
        Friendship.findOneAndDelete({ user: context.id, friend: friendId }),
        Friendship.findOneAndDelete({ user: friendId, friend: context.id }),
      ]);

      // Invalidate cache
      await cacheInvalidate.friendship(context.id, friendId);

      SaveAuditTrail({
        userId: context.id,
        task: "Rejected Friend Request",
        details: `Rejected friend request from ${friendId}`,
      });

      return {
        success: true,
        message: "Friend request rejected.",
      };
    },

    // Cancel friend request
    async cancelFriendRequest(_, { friendId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Delete both friendship records
      await Promise.all([
        Friendship.findOneAndDelete({ user: context.id, friend: friendId }),
        Friendship.findOneAndDelete({ user: friendId, friend: context.id }),
      ]);

      // Invalidate cache
      await cacheInvalidate.friendship(context.id, friendId);

      SaveAuditTrail({
        userId: context.id,
        task: "Cancelled Friend Request",
        details: `Cancelled friend request to ${friendId}`,
      });

      return {
        success: true,
        message: "Friend request cancelled.",
      };
    },

    // Unfriend
    async unfriend(_, { friendId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Delete both friendship records
      await Promise.all([
        Friendship.findOneAndDelete({ user: context.id, friend: friendId }),
        Friendship.findOneAndDelete({ user: friendId, friend: context.id }),
      ]);

      // Invalidate cache
      await cacheInvalidate.friendship(context.id, friendId);

      SaveAuditTrail({
        userId: context.id,
        task: "Unfriended",
        details: `Unfriended ${friendId}`,
      });

      return {
        success: true,
        message: "Unfriended successfully.",
      };
    },

    // Block user
    async blockUser(_, { userId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      if (context.id === userId) {
        return {
          success: false,
          message: "You cannot block yourself.",
        };
      }

      // Check if already blocked
      const existing = await Friendship.findOne({
        user: context.id,
        friend: userId,
        status: "blocked",
      }).lean();

      if (existing) {
        return {
          success: false,
          message: "User is already blocked.",
        };
      }

      // Update or create blocked relationship
      await Friendship.findOneAndUpdate(
        { user: context.id, friend: userId },
        { status: "blocked" },
        { upsert: true, new: true }
      );

      // Invalidate cache
      await cacheInvalidate.friendship(context.id, userId);

      SaveAuditTrail({
        userId: context.id,
        task: "Blocked User",
        details: `Blocked user ${userId}`,
      });

      return {
        success: true,
        message: "User blocked successfully.",
      };
    },
  },

  Query: {
    // Get all friends (accepted only, with caching)
    async getFriends(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const friends = await cache.getOrSet(
        cacheKeys.userFriendships(context.id, "accepted"),
        async () => {
          const [error, friendships] = await catchError(
            Friendship.find({
              user: context.id,
              status: "accepted",
            })
              .select("friend status acceptedAt")
              .populate("friend", "username profilePic email lastActive")
              .lean()
          );

          if (error) {
            logError("getFriends", error);
            return [];
          }

          return friendships;
        },
        1800 // 30 minutes
      );

      return {
        success: true,
        friends: friends.map((f: any) => ({
          id: f.friend._id.toString(),
          username: f.friend.username,
          profilePic: f.friend.profilePic,
          email: f.friend.email,
          acceptedAt: f.acceptedAt,
          isOnline: isUserOnline(f.friend._id.toString()),
          lastActive: f.friend.lastActive,
        })),
      };
    },

    // Get pending friend requests
    async getPendingRequests(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Get incoming requests
      const [error, incoming] = await catchError(
        Friendship.find({
          user: context.id,
          status: "pending",
          requestedBy: { $ne: context.id },
        })
          .select("friend requestedBy")
          .populate("friend", "username profilePic")
          .lean()
      );

      // Get outgoing requests
      const [, outgoing] = await catchError(
        Friendship.find({
          user: context.id,
          status: "pending",
          requestedBy: context.id,
        })
          .select("friend")
          .populate("friend", "username profilePic")
          .lean()
      );

      if (error) {
        logError("getPendingRequests", error);
        return {
          success: false,
          incoming: [],
          outgoing: [],
        };
      }

      return {
        success: true,
        incoming: incoming.map((r: any) => ({
          id: r.friend._id.toString(),
          username: r.friend.username,
          profilePic: r.friend.profilePic,
        })),
        outgoing: outgoing.map((r: any) => ({
          id: r.friend._id.toString(),
          username: r.friend.username,
          profilePic: r.friend.profilePic,
        })),
      };
    },

    // Get friend suggestions
    async getFriendSuggestions(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Strategy: Get users who are friends of your friends (mutual friends)
      // This is simplified - in production, add more sophisticated algorithm
      
      const suggestions = await cache.getOrSet(
        `friends:suggestions:${context.id}`,
        async () => {
          // Get user's friends
          const [friendsError, friends] = await catchError(
            Friendship.find({
              user: context.id,
              status: "accepted",
            })
              .select("friend")
              .lean()
          );

          if (friendsError || !friends || friends.length === 0) {
            // If no friends, return random users (excluding self and blocked)
            const [blockedError, blocked] = await catchError(
              Friendship.find({
                user: context.id,
                status: "blocked",
              })
                .select("friend")
                .lean()
            );

            const blockedIds = blocked?.map((b: any) => b.friend.toString()) || [];
            blockedIds.push(context.id);

            const [suggestionsError, suggestionsData] = await catchError(
              User.find({ _id: { $nin: blockedIds } })
                .select("username profilePic")
                .limit(10)
                .lean()
            );

            return suggestionsData || [];
          }

          // Get friend IDs
          const friendIds = friends.map((f: any) => f.friend.toString());

          // Get mutual friends
          const [mutualError, mutuals] = await catchError(
            Friendship.find({
              user: { $in: friendIds },
              status: "accepted",
            })
              .select("friend")
              .lean()
          );

          // Get unique IDs of potential friends
          const mutualFriendsIds = [
            ...new Set(mutuals?.map((m: any) => m.friend.toString()) || []),
          ].filter(id => id !== context.id && !friendIds.includes(id));

          // Get users
          const [usersError, usersData] = await catchError(
            User.find({ _id: { $in: mutualFriendsIds } })
              .select("username profilePic")
              .limit(10)
              .lean()
          );

          return usersData || [];
        },
        3600 // 1 hour cache
      );

      return {
        success: true,
        suggestions: suggestions.map((s: any) => ({
          id: s._id.toString(),
          username: s.username,
          profilePic: s.profilePic,
        })),
      };
    },

    // Get friendship status
    async getFriendshipStatus(_, { friendId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, friendship] = await catchError(
        Friendship.findOne({
          user: context.id,
          friend: friendId,
        }).lean()
      );

      if (error || !friendship) {
        return {
          success: true,
          status: "none",
        };
      }

      return {
        success: true,
        status: friendship.status,
        requestedBy: friendship.requestedBy.toString(),
      };
    },
  },
};

