import {
  catchError,
  logError,
  SaveAuditTrail,
  ThrowError,
  extractUrls,
  scanLink,
} from "../../Helpers/Helpers.js";
import Chat, { Message } from "../../models/Chat.js";
import Friendship from "../../models/Friendship.js";
import Shard from "../../models/Shard.js";
import { cache, cacheKeys, cacheInvalidate } from "../../Helpers/Cache.js";
import { createNotification } from "./Notifications.js";
import { User } from "../../models/User.js";
import { sendNotificationToUsers } from "../../Helpers/FirebaseMessaging.js";
import { moderate } from "../../Helpers/ContentModerator.js";

const cacheInvalidateChat = cacheInvalidate.chat;
const cacheInvalidateUserChats = cacheInvalidate.userChats;

// Import io for WebSocket emissions
let io: any = null;
export function setSocketIO(ioInstance: any) {
  io = ioInstance;
}

export default {
  Mutation: {
    // Create or get direct chat
    async createOrGetDirectChat(_, { friendId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Check if users are friends
      const [friendshipError, friendship] = await catchError(
        Friendship.findOne({
          user: context.id,
          friend: friendId,
          status: "accepted",
        }).lean()
      );

      if (friendshipError || !friendship) {
        return {
          success: false,
          message: "You can only chat with friends.",
        };
      }

      // Check if chat already exists
      const [existingError, existingChat] = await catchError(
        Chat.findOne({
          type: "direct",
          participants: { $all: [context.id, friendId] },
        }).lean()
      );

      if (existingError) {
        logError("createOrGetDirectChat:findExisting", existingError);
        return {
          success: false,
          message: "An error occurred.",
        };
      }

      if (existingChat) {
        return {
          success: true,
          chatId: existingChat._id.toString(),
        };
      }

      // Create new chat
      const [createError, newChat] = await catchError(
        Chat.create({
          type: "direct",
          participants: [context.id, friendId],
        })
      );

      if (createError) {
        logError("createOrGetDirectChat:create", createError);
        return {
          success: false,
          message: "Failed to create chat.",
        };
      }

      return {
        success: true,
        chatId: newChat._id.toString(),
      };
    },

    // Create or get shard group chat
    async createOrGetShardChat(_, { shardId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Verify user is a shard participant
      const [shardError, shard] = await catchError(
        Shard.findById(shardId).lean()
      );

      if (shardError || !shard) {
        return {
          success: false,
          message: "Shard not found.",
        };
      }

      // Check if user is owner or participant
      const isOwner = shard.owner.toString() === context.id;
      const isParticipant = shard.participants?.some(
        (p: any) => p.user.toString() === context.id
      );

      if (!isOwner && !isParticipant) {
        return {
          success: false,
          message: "You are not a participant in this shard.",
        };
      }

      // Check if shard has multiple participants
      const allParticipants = [
        shard.owner.toString(),
        ...(shard.participants?.map((p: any) => p.user.toString()) || []),
      ];
      const uniqueParticipants = [...new Set(allParticipants)];

      if (uniqueParticipants.length < 2) {
        return {
          success: false,
          message: "Chat requires at least 2 participants. Add collaborators to this shard first.",
        };
      }

      // Check if chat already exists for this shard
      const [existingError, existingChat] = await catchError(
        Chat.findOne({
          type: "group",
          shardId: shardId,
        }).lean()
      );

      if (existingError) {
        logError("createOrGetShardChat:findExisting", existingError);
        return {
          success: false,
          message: "An error occurred.",
        };
      }

      if (existingChat) {
        return {
          success: true,
          chatId: existingChat._id.toString(),
        };
      }

      // Create new group chat for shard
      const [createError, newChat] = await catchError(
        Chat.create({
          type: "group",
          shardId: shardId,
          name: `${shard.title} Chat`,
          participants: uniqueParticipants,
        })
      );

      if (createError) {
        logError("createOrGetShardChat:create", createError);
        return {
          success: false,
          message: "Failed to create chat.",
        };
      }

      // Update shard with chat ID
      await Shard.findByIdAndUpdate(shardId, { chatId: newChat._id });

      return {
        success: true,
        chatId: newChat._id.toString(),
      };
    },

    // Send message
    async sendMessage(_, { chatId, content, type, replyTo, attachments }, context) {
      let notfound = false;
      if (!context.id) ThrowError("Please login to continue.");

      // Verify user is participant
      let [chatError, chat] = await catchError(
        Chat.findById(chatId).lean()
      );

      if (chatError) {
        console.log("chaterror", chatError, chatId);
        notfound = true;
      }

      if (!chat) {
        const [shardError, shard] = await catchError(
          Shard.findById(chatId).select("title, participants, owner").lean()
        );
        if (shardError) {
          logError("sendMessage:shard", shardError);
          return {
            success: false,
            message: "Failed to create chat.",
          };
        }  
        
        // Extract participant user IDs from shard participants (which are objects with {user, role})
        const participantUserIds = shard.participants?.map((p: any) => p.user.toString()) || [];
        
        // Ensure owner is included in participants
        const allParticipantIds = [shard.owner.toString(), ...participantUserIds];
        const uniqueParticipantIds = [...new Set(allParticipantIds)];
        
        const [newShardChatError, newShardChat] = await catchError(
          Chat.create({
            type: "shard",
            shardId: chatId,
            name: shard.title,
            participants: uniqueParticipantIds,
          })
        );

        if (newShardChatError) {
          
          logError("sendMessage:newShardChat", newShardChatError);
          return {
            success: false,
            message: "Failed to create chat.",
          };
        }

        chatId = newShardChat._id;
        chat = newShardChat
      }

      if (notfound) {
        return {
          success: false,
          message: "Chat not found.",
        };
      }

      if (!chat.participants.map((p: any) => p.toString()).includes(context.id)) {
        console.log(chat.participants, context.id);

        return {
          success: false,
          message: "You are not a participant in this chat.",
        };
      }

      // Moderate message content
      if (content && type === 'text') {
        const msgMod = moderate(content, 'chat');
        if (!msgMod.allowed) {
          return {
            success: false,
            message: msgMod.crisisMessage || msgMod.reason || 'Message could not be sent.',
          };
        }
      }

      // Scan URLs in message content for safety
      if (content && type !== 'image' && type !== 'video' && type !== 'audio') {
        const urls = extractUrls(content);
        if (urls.length > 0) {
          const scanResults = await Promise.all(urls.map(scanLink));
          const flagged = scanResults.find(r => !r.safe);
          if (flagged) {
            return {
              success: false,
              message: "Message contains a flagged or unsafe link.",
            };
          }
        }
      }

      // If replying to a message, verify it exists in this chat
      if (replyTo) {
        const [replyError, originalMessage] = await catchError(
          Message.findOne({ _id: replyTo, chatId }).lean()
        );

        if (replyError || !originalMessage) {
          return {
            success: false,
            message: "Original message not found.",
          };
        }
      }

      // Create message
      const messageData: any = {
        chatId,
        sender: context.id,
        content,
        type: type || "text",
        readBy: [context.id], // Mark as read by sender
        readAt: [{ userId: context.id, readAt: new Date() }],
      };

      if (replyTo) {
        messageData.replyTo = replyTo;
      }

      if (attachments) {
        messageData.attachments = attachments;
      }

      const [messageError, newMessage] = await catchError(
        Message.create(messageData)
      );

      if (messageError) {
        logError("sendMessage", messageError);
        return {
          success: false,
          message: "Failed to send message.",
        };
      }

      // Invalidate chat and user chats cache
      await cacheInvalidateChat(chatId);
      await Promise.all(
        chat.participants.map((p: any) => 
          cacheInvalidateUserChats(p.toString())
        )
      );

      // Send notifications to other participants
      const otherParticipants = chat.participants
        .filter((p: any) => p.toString() !== context.id);

      const [senderError, sender] = await catchError(
        User.findById(context.id).select("username").lean()
      );

      for (const participant of otherParticipants) {
        await createNotification(
          participant.toString(),
          `${sender?.username || "Someone"} sent you a message`,
          "message"
        );
      }

      // Send Push Notification
      const recipientIds = otherParticipants.map((p: any) => p.toString());
      await sendNotificationToUsers(
        recipientIds,
        {
          title: `New message from ${sender?.username || "Someone"}`,
          body: content.length > 50 ? content.substring(0, 50) + "..." : content,
          data: { 
            chatId: chatId.toString(), 
            screen: "/(screens)/shard/[id]/chat" 
          }
        },
        'messages' // Check message notification preferences
      );

      // Emit WebSocket event for real-time messaging
      if (io) {
        io.to(`chat:${chatId}`).emit("message:new", {
          id: newMessage._id.toString(),
          chatId,
          sender: context.id,
          senderUsername: sender?.username || "Unknown",
          content: newMessage.content,
          type: newMessage.type,
          mediaUrl: newMessage.attachments && newMessage.attachments.length > 0 
            ? newMessage.attachments[0].url 
            : undefined,
          createdAt: newMessage.createdAt,
        });
      }

      SaveAuditTrail({
        userId: context.id,
        task: "Sent Message",
        details: `Sent message in chat ${chatId}`,
      });

      return {
        success: true,
        message: "Message sent successfully",
        messageData: {
          id: newMessage._id.toString(),
          content: newMessage.content,
          type: newMessage.type,
          sender: {
            id: context.id,
            username: sender?.username || "Unknown",
            profilePic: sender?.profilePic || "",
          },
          createdAt: newMessage.createdAt,
        },
      };
    },

    // Mark messages as read (with detailed timestamps)
    async markMessagesRead(_, { chatId, messageIds }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const now = new Date();

      const [error] = await catchError(
        Message.updateMany(
          { _id: { $in: messageIds }, chatId },
          { 
            $addToSet: { 
              readBy: context.id,
              readAt: { userId: context.id, readAt: now }
            }
          }
        )
      );

      if (error) {
        logError("markMessagesRead", error);
        return {
          success: false,
          message: "Failed to mark messages as read.",
        };
      }

      // Emit WebSocket event for read receipts
      if (io) {
        io.to(`chat:${chatId}`).emit("message:read", {
          messageIds,
          readBy: context.id,
          readAt: now,
        });
      }

      return {
        success: true,
        message: "Messages marked as read.",
      };
    },

    // Edit message
    async editMessage(_, { messageId, content }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Verify message belongs to user
      const [messageError, message] = await catchError(
        Message.findById(messageId).lean()
      );

      if (messageError || !message) {
        return {
          success: false,
          message: "Message not found.",
        };
      }

      if (message.sender.toString() !== context.id) {
        return {
          success: false,
          message: "You can only edit your own messages.",
        };
      }

      if (message.deleted) {
        return {
          success: false,
          message: "Cannot edit deleted message.",
        };
      }

      await Message.findByIdAndUpdate(messageId, {
        content,
        edited: true,
        editedAt: new Date(),
      });

      // Emit WebSocket event
      if (io) {
        io.to(`chat:${message.chatId.toString()}`).emit("message:edited", {
          messageId,
          content,
        });
      }

      return {
        success: true,
        message: "Message edited successfully.",
      };
    },

    // Delete message
    async deleteMessage(_, { messageId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Verify message belongs to user
      const [messageError, message] = await catchError(
        Message.findById(messageId).lean()
      );

      if (messageError || !message) {
        return {
          success: false,
          message: "Message not found.",
        };
      }

      if (message.sender.toString() !== context.id) {
        return {
          success: false,
          message: "You can only delete your own messages.",
        };
      }

      await Message.findByIdAndUpdate(messageId, {
        deleted: true,
        content: "[Message deleted]",
      });

      // Emit WebSocket event
      if (io) {
        io.to(`chat:${message.chatId.toString()}`).emit("message:deleted", {
          messageId,
        });
      }

      return {
        success: true,
        message: "Message deleted successfully.",
      };
    },

    // Add reaction to message
    async addReaction(_, { messageId, emoji }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, message] = await catchError(
        Message.findById(messageId).lean()
      );

      if (error || !message) {
        return {
          success: false,
          message: "Message not found.",
        };
      }

      // Remove existing reaction from user if exists
      let reactions = message.reactions || [];
      reactions = reactions.filter((r: any) => r.userId.toString() !== context.id);

      // Add new reaction
      reactions.push({
        userId: context.id,
        emoji,
      });

      await Message.findByIdAndUpdate(messageId, { reactions });

      // Emit WebSocket event
      if (io) {
        io.to(`chat:${message.chatId.toString()}`).emit("message:reaction", {
          messageId,
          userId: context.id,
          emoji,
        });
      }

      return {
        success: true,
        message: "Reaction added.",
      };
    },

    // Remove reaction
    async removeReaction(_, { messageId, emoji }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, message] = await catchError(
        Message.findById(messageId).lean()
      );

      if (error || !message) {
        return {
          success: false,
          message: "Message not found.",
        };
      }

      const reactions = (message.reactions || []).filter(
        (r: any) => !(r.userId.toString() === context.id && r.emoji === emoji)
      );

      await Message.findByIdAndUpdate(messageId, { reactions });

      // Emit WebSocket event
      if (io) {
        io.to(`chat:${message.chatId.toString()}`).emit("message:reaction:removed", {
          messageId,
          userId: context.id,
          emoji,
        });
      }

      return {
        success: true,
        message: "Reaction removed.",
      };
    },
  },

  Query: {
    // Get user's chats (with caching)
    async myChats(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const chats = await cache.getOrSet(
        `user:${context.id}:chats`,
        async () => {
          const [error, chatList] = await catchError(
            Chat.find({
              participants: context.id,
            })
              .select("type participants createdAt updatedAt")
              .populate("participants", "username profilePic")
              .sort({ updatedAt: -1 })
              .lean()
          );

          if (error) {
            logError("myChats", error);
            return [];
          }

          return chatList;
        },
        1800 // 30 minutes
      );

      return {
        success: true,
        chats: chats.map((chat: any) => ({
          id: chat._id.toString(),
          type: chat.type,
          participants: chat.participants.map((p: any) => ({
            id: p._id.toString(),
            username: p.username,
            profilePic: p.profilePic,
          })),
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
        })),
      };
    },

    // Get chat messages (paginated with caching)
    async getChatMessages(_, { chatId, limit = 50, skip = 0 }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Verify user is participant
      const [chatError, chat] = await catchError(
        Chat.findById(chatId).lean()
      );

      if (chatError || !chat) {
        console.log("cht id", chatId);
        
        return {
          success: false,
          message: "Chat not found.",
          messages: [],
        };
      }

      if (!chat.participants.map((p: any) => p.toString()).includes(context.id)) {
        return {
          success: false,
          message: "You are not a participant in this chat.",
          messages: [],
        };
      }

      // Get messages (don't cache per-request, cache keys vary)
      const [error, messages] = await catchError(
        Message.find({ chatId })
          .select("sender content type readBy attachments createdAt")
          .populate("sender", "username profilePic")
          .sort({ createdAt: -1 })
          .limit(limit)
          .skip(skip)
          .lean()
      );

      if (error) {
        logError("getChatMessages", error);
        return {
          success: false,
          message: "Failed to fetch messages.",
          messages: [],
        };
      }

      return {
        success: true,
        messages: messages.reverse().map((m: any) => ({
          id: m._id.toString(),
          content: m.content,
          type: m.type,
          sender: {
            id: m.sender._id.toString(),
            username: m.sender.username,
            profilePic: m.sender.profilePic,
          },
          readBy: m.readBy || [],
          mediaUrl: m.attachments && m.attachments.length > 0 ? m.attachments[0].url : undefined,
          createdAt: m.createdAt,
        })),
      };
    },

    // Get unread message count
    async getUnreadCount(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, count] = await catchError(
        Message.countDocuments({
          chatId: { $in: await Chat.find({ participants: context.id }).select("_id").lean() },
          sender: { $ne: context.id },
          readBy: { $ne: context.id },
        })
      );

      if (error) {
        logError("getUnreadCount", error);
        return {
          success: false,
          count: 0,
        };
      }

      return {
        success: true,
        count,
      };
    },

    // Get chat details
    async getChat(_, { chatId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const chat = await cache.getOrSet(
        cacheKeys.chat(chatId),
        async () => {
          // First try to find by chat ID
          let [error, chatData] = await catchError(
            Chat.findById(chatId)
              .select("type participants shardId name createdAt updatedAt")
              .populate("participants", "username profilePic")
              .populate("shardId", "title")
              .lean()
          );

          // If not found by chat ID, try finding by shard ID
          if (!chatData) {
            console.log("Chat not found by ID, trying as shard ID:", chatId);
            [error, chatData] = await catchError(
              Chat.findOne({ shardId: chatId })
                .select("type participants shardId name createdAt updatedAt")
                .populate("participants", "username profilePic")
                .populate("shardId", "title")
                .lean()
            );
          }

          if (error || !chatData) {
            throw new Error("Chat not found");
          }

          return chatData;
        },
        1800 // 30 minutes
      );

      // Verify user is participant
      if (!chat.participants.map((p: any) => p._id.toString()).includes(context.id)) {
        return {
          success: false,
          message: "You are not a participant in this chat.",
        };
      }

      return {
        success: true,
        chat: {
          id: chat._id.toString(),
          type: chat.type,
          name: chat.name,
          participants: chat.participants.map((p: any) => ({
            id: p._id.toString(),
            username: p.username,
            profilePic: p.profilePic,
          })),
          shard: chat.shardId ? {
            id: chat.shardId._id.toString(),
            title: (chat.shardId as any)?.title || "Shard Chat",
          } : null,
          createdAt: chat.createdAt,
        },
      };
    },
  },
};

