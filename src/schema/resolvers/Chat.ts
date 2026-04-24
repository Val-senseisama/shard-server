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
import { enqueuePushNotification } from "../../Helpers/Queue.js";
import { moderate } from "../../Helpers/ContentModerator.js";
import { generateChatSummary } from "../../Helpers/AIHelper.js";
import { Types } from "mongoose";

const cacheInvalidateChat = cacheInvalidate.chat;
const cacheInvalidateUserChats = cacheInvalidate.userChats;

let io: any = null;
export function setSocketIO(ioInstance: any) {
  io = ioInstance;
}

/**
 * Parse @mentions in a message and notify mentioned users.
 */
async function processMentions(
  content: string,
  participants: string[],
  senderId: string,
  chatId: string,
  senderUsername: string
): Promise<string[]> {
  const atMatches = content.match(/@(\w+)/g);
  if (!atMatches) return [];

  const foundUsernames = atMatches.map((m) => m.substring(1).toLowerCase());
  let mentionedIds: string[] = [];

  if (foundUsernames.includes("everyone")) {
    mentionedIds = participants.filter((p) => p !== senderId);
  } else {
    const [error, users] = await catchError(
      User.find({
        username: { $in: foundUsernames.map((u) => new RegExp(`^${u}$`, "i")) },
      })
        .select("_id")
        .lean()
    );

    if (!error && users) {
      mentionedIds = users
        .map((u: any) => u._id.toString())
        .filter((id) => id !== senderId && participants.includes(id));
    }
  }

  const uniqueMentions = [...new Set(mentionedIds)];

  if (uniqueMentions.length > 0) {
    enqueuePushNotification(
      uniqueMentions,
      {
        title: `@${senderUsername} mentioned you`,
        body: content.length > 60 ? content.substring(0, 60) + "..." : content,
        data: { chatId, screen: "/(screens)/shard/[id]/chat", isMention: "true" },
      },
      "messages"
    ).catch((e) => logError("MentionNotificationError", e));
  }

  return uniqueMentions;
}

export default {
  Mutation: {
    async createOrGetDirectChat(_, { friendId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [friendshipError, friendship] = await catchError(
        Friendship.findOne({ user: context.id, friend: friendId, status: "accepted" }).lean()
      );

      if (friendshipError || !friendship) {
        return { success: false, message: "You can only chat with friends." };
      }

      const [existingError, existingChat] = await catchError(
        Chat.findOne({ type: "direct", participants: { $all: [context.id, friendId] } }).lean()
      );

      if (existingError) {
        logError("createOrGetDirectChat:findExisting", existingError);
        return { success: false, message: "An error occurred." };
      }

      if (existingChat) {
        return { success: true, chatId: existingChat._id.toString() };
      }

      const [createError, newChat] = await catchError(
        Chat.create({ type: "direct", participants: [context.id, friendId] })
      );

      if (createError) {
        logError("createOrGetDirectChat:create", createError);
        return { success: false, message: "Failed to create chat." };
      }

      return { success: true, chatId: newChat._id.toString() };
    },

    async createOrGetShardChat(_, { shardId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [shardError, shard] = await catchError(Shard.findById(shardId).lean());

      if (shardError || !shard) {
        return { success: false, message: "Shard not found." };
      }

      const isOwner = shard.owner.toString() === context.id;
      const isParticipant = shard.participants?.some(
        (p: any) => p.user.toString() === context.id
      );

      if (!isOwner && !isParticipant) {
        return { success: false, message: "You are not a participant in this shard." };
      }

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

      const [existingError, existingChat] = await catchError(
        Chat.findOne({ type: "group", shardId }).lean()
      );

      if (existingError) {
        logError("createOrGetShardChat:findExisting", existingError);
        return { success: false, message: "An error occurred." };
      }

      if (existingChat) {
        return { success: true, chatId: existingChat._id.toString() };
      }

      const [createError, newChat] = await catchError(
        Chat.create({
          type: "group",
          shardId,
          name: `${shard.title} Chat`,
          participants: uniqueParticipants,
        })
      );

      if (createError) {
        logError("createOrGetShardChat:create", createError);
        return { success: false, message: "Failed to create chat." };
      }

      await Shard.findByIdAndUpdate(shardId, { chatId: newChat._id });

      return { success: true, chatId: newChat._id.toString() };
    },

    async sendMessage(_, { chatId, content, type, replyTo, attachments }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Find chat — if not found by chat ID, try to auto-create from shard
      let [chatError, chat] = await catchError(Chat.findById(chatId).lean());

      if (!chat) {
        const [shardError, shard] = await catchError(
          Shard.findById(chatId).select("title participants owner").lean()
        );

        if (shardError || !shard) {
          return { success: false, message: "Chat not found." };
        }

        const participantUserIds = shard.participants?.map((p: any) => p.user.toString()) || [];
        const allParticipantIds = [shard.owner.toString(), ...participantUserIds];
        const uniqueParticipantIds = [...new Set(allParticipantIds)];

        const [newChatError, newShardChat] = await catchError(
          Chat.create({
            type: "shard",
            shardId: chatId,
            name: shard.title,
            participants: uniqueParticipantIds,
          })
        );

        if (newChatError) {
          logError("sendMessage:newShardChat", newChatError);
          return { success: false, message: "Failed to create chat." };
        }

        chatId = newShardChat._id;
        chat = newShardChat;
      }

      if (!chat.participants.map((p: any) => p.toString()).includes(context.id)) {
        return { success: false, message: "You are not a participant in this chat." };
      }

      // Content moderation
      if (content && type === "text") {
        const msgMod = moderate(content, "chat");
        if (!msgMod.allowed) {
          return {
            success: false,
            message: msgMod.crisisMessage || msgMod.reason || "Message could not be sent.",
          };
        }
      }

      // Validate reply target exists in this chat
      if (replyTo) {
        const [replyError, originalMessage] = await catchError(
          Message.findOne({ _id: replyTo, chatId }).lean()
        );
        if (replyError || !originalMessage) {
          return { success: false, message: "Original message not found." };
        }
      }

      const [senderError, sender] = await catchError(
        User.findById(context.id).select("username profilePic").lean()
      );

      // Process @mentions
      let mentionedIds: string[] = [];
      if (type === "text" || !type) {
        mentionedIds = await processMentions(
          content,
          chat.participants.map((p: any) => p.toString()),
          context.id,
          chatId.toString(),
          sender?.username || "Someone"
        );
      }

      const messageData: any = {
        chatId,
        sender: context.id,
        content,
        type: type || "text",
        readBy: [context.id],
        readAt: [{ userId: context.id, readAt: new Date() }],
        mentions: mentionedIds,
      };

      if (replyTo) messageData.replyTo = replyTo;
      if (attachments) messageData.attachments = attachments;

      const [messageError, newMessage] = await catchError(Message.create(messageData));

      if (messageError) {
        logError("sendMessage", messageError);
        return { success: false, message: "Failed to send message." };
      }

      // Invalidate caches
      await cacheInvalidateChat(chatId);
      await Promise.all(
        chat.participants.map((p: any) => cacheInvalidateUserChats(p.toString()))
      );

      // Notify participants
      const otherParticipants = chat.participants.filter(
        (p: any) => p.toString() !== context.id
      );

      for (const participant of otherParticipants) {
        await createNotification(
          participant.toString(),
          `${sender?.username || "Someone"} sent you a message`,
          "message"
        );
      }

      const recipientIds = otherParticipants
        .map((p: any) => p.toString())
        .filter((id) => !mentionedIds.includes(id));

      if (recipientIds.length > 0) {
        enqueuePushNotification(
          recipientIds,
          {
            title: `New message from ${sender?.username || "Someone"}`,
            body: content.length > 50 ? content.substring(0, 50) + "..." : content,
            data: { chatId: chatId.toString(), screen: "/(screens)/shard/[id]/chat" },
          },
          "messages"
        ).catch((e) => logError("QueueDispatchError", e));
      }

      // Real-time broadcast — includes replyTo so clients can render quote previews
      if (io) {
        io.to(`chat:${chatId}`).emit("message:new", {
          id: newMessage._id.toString(),
          chatId,
          sender: context.id,
          senderUsername: sender?.username || "Unknown",
          content: newMessage.content,
          type: newMessage.type,
          mediaUrl:
            newMessage.attachments && newMessage.attachments.length > 0
              ? newMessage.attachments[0].url
              : undefined,
          replyTo: replyTo || null,
          createdAt: newMessage.createdAt,
        });
      }

      // URL safety scan — non-blocking, runs after response is sent
      if (content && type !== "image" && type !== "audio" && type !== "file") {
        const urls = extractUrls(content);
        if (urls.length > 0) {
          Promise.all(urls.map(scanLink))
            .then(async (results) => {
              const flagged = results.find((r) => !r.safe);
              if (flagged) {
                await Message.findByIdAndUpdate(newMessage._id, {
                  deleted: true,
                  content: "[Message removed — contains a flagged link]",
                });
                if (io) {
                  io.to(`chat:${chatId}`).emit("message:deleted", {
                    messageId: newMessage._id.toString(),
                  });
                }
              }
            })
            .catch(() => {}); // scan failure is non-fatal
        }
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

    async markMessagesRead(_, { chatId, messageIds }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const now = new Date();

      const [error] = await catchError(
        Message.updateMany(
          { _id: { $in: messageIds }, chatId },
          {
            $addToSet: {
              readBy: context.id,
              readAt: { userId: context.id, readAt: now },
            },
          }
        )
      );

      if (error) {
        logError("markMessagesRead", error);
        return { success: false, message: "Failed to mark messages as read." };
      }

      if (io) {
        io.to(`chat:${chatId}`).emit("message:read", {
          messageIds,
          readBy: context.id,
          readAt: now,
        });
      }

      return { success: true, message: "Messages marked as read." };
    },

    async editMessage(_, { messageId, content }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [messageError, message] = await catchError(Message.findById(messageId).lean());

      if (messageError || !message) {
        return { success: false, message: "Message not found." };
      }

      if (message.sender.toString() !== context.id) {
        return { success: false, message: "You can only edit your own messages." };
      }

      if (message.deleted) {
        return { success: false, message: "Cannot edit deleted message." };
      }

      await Message.findByIdAndUpdate(messageId, {
        content,
        edited: true,
        editedAt: new Date(),
      });

      if (io) {
        io.to(`chat:${message.chatId.toString()}`).emit("message:edited", {
          messageId,
          content,
        });
      }

      return { success: true, message: "Message edited successfully." };
    },

    async deleteMessage(_, { messageId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [messageError, message] = await catchError(Message.findById(messageId).lean());

      if (messageError || !message) {
        return { success: false, message: "Message not found." };
      }

      if (message.sender.toString() !== context.id) {
        return { success: false, message: "You can only delete your own messages." };
      }

      await Message.findByIdAndUpdate(messageId, {
        deleted: true,
        content: "[Message deleted]",
      });

      if (io) {
        io.to(`chat:${message.chatId.toString()}`).emit("message:deleted", { messageId });
      }

      return { success: true, message: "Message deleted successfully." };
    },

    async addReaction(_, { messageId, emoji }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, message] = await catchError(Message.findById(messageId).lean());

      if (error || !message) {
        return { success: false, message: "Message not found." };
      }

      let reactions = message.reactions || [];
      // Replace existing reaction from this user
      reactions = reactions.filter((r: any) => r.userId.toString() !== context.id);
      reactions.push({ userId: context.id, emoji });

      await Message.findByIdAndUpdate(messageId, { reactions });

      if (io) {
        io.to(`chat:${message.chatId.toString()}`).emit("message:reaction", {
          messageId,
          userId: context.id,
          emoji,
        });
      }

      return { success: true, message: "Reaction added." };
    },

    async removeReaction(_, { messageId, emoji }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, message] = await catchError(Message.findById(messageId).lean());

      if (error || !message) {
        return { success: false, message: "Message not found." };
      }

      const reactions = (message.reactions || []).filter(
        (r: any) => !(r.userId.toString() === context.id && r.emoji === emoji)
      );

      await Message.findByIdAndUpdate(messageId, { reactions });

      if (io) {
        io.to(`chat:${message.chatId.toString()}`).emit("message:reaction:removed", {
          messageId,
          userId: context.id,
          emoji,
        });
      }

      return { success: true, message: "Reaction removed." };
    },

    async createPoll(_, { chatId, question, options }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const chat = await Chat.findById(chatId).lean();
      if (!chat) return { success: false, message: "Chat not found" };

      const [senderError, sender] = await catchError(
        User.findById(context.id).select("username profilePic").lean()
      );

      const pollOptions = options.map((text: string) => ({ text, votes: [] }));
      const newMessage = await Message.create({
        chatId,
        sender: context.id,
        content: `📊 Poll: ${question}`,
        type: "poll",
        poll: { question, options: pollOptions, multipleAnswers: false },
        readBy: [context.id],
        readAt: [{ userId: context.id, readAt: new Date() }],
      });

      if (io) {
        io.to(`chat:${chatId}`).emit("message:new", {
          id: newMessage._id.toString(),
          chatId,
          sender: context.id,
          senderUsername: sender?.username || "Unknown",
          content: newMessage.content,
          type: newMessage.type,
          createdAt: newMessage.createdAt,
        });
      }

      return {
        success: true,
        message: "Poll created successfully",
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

    async votePoll(_, { messageId, optionIndex }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const message = await Message.findById(messageId);
      if (!message || message.type !== "poll" || !message.poll) {
        return { success: false, message: "Poll not found." };
      }

      // Remove existing vote from this user (single-answer)
      message.poll.options.forEach((opt: any) => {
        opt.votes = opt.votes.filter((v: any) => v.toString() !== context.id);
      });

      if (message.poll.options[optionIndex]) {
        message.poll.options[optionIndex].votes.push(context.id as any);
      }

      await message.save();

      // Emit full updated options so clients can update state in-place without refetching
      if (io) {
        io.to(`chat:${message.chatId.toString()}`).emit("message:poll:voted", {
          messageId,
          options: message.poll.options.map((opt: any) => ({
            text: opt.text,
            votes: opt.votes.map((v: any) => v.toString()),
          })),
        });
      }

      return { success: true, message: "Voted successfully." };
    },

    async assignTaskFromChat(_, { chatId, taskId, assigneeId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [senderError, sender] = await catchError(
        User.findById(context.id).select("username profilePic").lean()
      );
      const [chatError, chat] = await catchError(Chat.findById(chatId).lean());
      if (!chat) ThrowError("Chat not found");

      let finalTaskId = taskId;

      if (!finalTaskId && chat.shardId) {
        const MiniGoal = (await import("../../models/MiniGoal.js")).default;
        const [goalError, goal] = await catchError(
          MiniGoal.findOne({ shardId: chat.shardId, completed: false }).sort({ createdAt: 1 })
        );
        if (goal) {
          goal.tasks.push({
            title: "Chat Assigned Task",
            completed: false,
            assignedTo: assigneeId,
            deleted: false,
          } as any);
          await goal.save();
          finalTaskId = "dynamic-" + Date.now();
        }
      }

      const [assigneeErr, assignee] = await catchError(
        User.findById(assigneeId).select("username").lean()
      );

      const newMessage = await Message.create({
        chatId,
        sender: context.id,
        content: `📋 Task Assigned.`,
        type: "minitask_assignment",
        minitaskRef: {
          taskId: finalTaskId || "general",
          assignedTo: assigneeId,
        },
        readBy: [context.id],
        readAt: [{ userId: context.id, readAt: new Date() }],
      });

      if (io) {
        io.to(`chat:${chatId}`).emit("message:new", {
          id: newMessage._id.toString(),
          chatId,
          sender: context.id,
          senderUsername: sender?.username || "Unknown",
          content: newMessage.content,
          type: newMessage.type,
          createdAt: newMessage.createdAt,
        });
      }

      return {
        success: true,
        message: "Task assigned and announced in chat.",
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

    async summonSummary(_, { chatId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Fetch recent text messages for context
      const [msgErr, recentMessages] = await catchError(
        Message.find({ chatId, type: { $in: ["text", "system"] }, deleted: false })
          .sort({ _id: -1 })
          .limit(30)
          .populate("sender", "username")
          .lean()
      );

      // Get shard title and progress for richer summary
      const [chatErr, chat] = await catchError(Chat.findById(chatId).lean());
      let shardTitle = "this shard";
      let shardProgress = 0;
      if (chat?.shardId) {
        const [shardErr, shard] = await catchError(
          Shard.findById(chat.shardId).select("title progress").lean()
        );
        if (shard) {
          shardTitle = shard.title;
          shardProgress = shard.progress?.completion ?? 0;
        }
      }

      const messages = (recentMessages || []).reverse();
      const messageHistory = messages
        .map((m: any) => `${m.sender?.username || "User"}: ${m.content}`)
        .join("\n");

      const summaryContent = await generateChatSummary(messageHistory, shardTitle, shardProgress);

      const [senderErr, sender] = await catchError(
        User.findById(context.id).select("username profilePic").lean()
      );

      const newMessage = await Message.create({
        chatId,
        sender: context.id,
        content: summaryContent,
        type: "summary_ping",
        readBy: [context.id],
        readAt: [{ userId: context.id, readAt: new Date() }],
      });

      if (io) {
        io.to(`chat:${chatId}`).emit("message:new", {
          id: newMessage._id.toString(),
          chatId,
          sender: context.id,
          senderUsername: "AI Summary",
          content: newMessage.content,
          type: newMessage.type,
          createdAt: newMessage.createdAt,
        });
      }

      return {
        success: true,
        message: "Summary summoned",
        messageData: {
          id: newMessage._id.toString(),
          content: newMessage.content,
          type: newMessage.type,
          sender: {
            id: context.id,
            username: sender?.username || "AI Summary",
            profilePic: "",
          },
          createdAt: newMessage.createdAt,
        },
      };
    },
  },

  Query: {
    async myChats(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const userId = new Types.ObjectId(context.id);

      // Single aggregation: chats + last message + unread count + participants
      // Cached per user; invalidated on every sendMessage for all participants
      const cacheKey = cacheKeys.userChats(context.id);
      const cached = await cache.get<any[]>(cacheKey);
      if (cached) return { success: true, chats: cached };

      const [aggErr, chatList] = await catchError(
        Chat.aggregate([
          { $match: { participants: userId } },

          // Last message per chat
          {
            $lookup: {
              from: "messages",
              let: { chatId: "$_id" },
              pipeline: [
                { $match: { $expr: { $eq: ["$chatId", "$$chatId"] } } },
                { $sort: { _id: -1 } },
                { $limit: 1 },
                {
                  $lookup: {
                    from: "users",
                    localField: "sender",
                    foreignField: "_id",
                    as: "senderData",
                    pipeline: [{ $project: { username: 1, profilePic: 1 } }],
                  },
                },
                { $addFields: { sender: { $arrayElemAt: ["$senderData", 0] } } },
                { $project: { senderData: 0 } },
              ],
              as: "lastMessages",
            },
          },

          // Unread count per chat for this user
          {
            $lookup: {
              from: "messages",
              let: { chatId: "$_id" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ["$chatId", "$$chatId"] },
                        { $not: { $in: [userId, "$readBy"] } },
                        { $ne: ["$sender", userId] },
                      ],
                    },
                  },
                },
                { $count: "n" },
              ],
              as: "unreadData",
            },
          },

          // Populate participants
          {
            $lookup: {
              from: "users",
              localField: "participants",
              foreignField: "_id",
              as: "participantDetails",
              pipeline: [{ $project: { username: 1, profilePic: 1 } }],
            },
          },

          {
            $addFields: {
              lastMessage: { $arrayElemAt: ["$lastMessages", 0] },
              unreadCount: {
                $ifNull: [{ $arrayElemAt: ["$unreadData.n", 0] }, 0],
              },
              // Sort key: last message time or chat creation time
              lastActivity: {
                $ifNull: [{ $arrayElemAt: ["$lastMessages._id", 0] }, "$_id"],
              },
            },
          },

          { $sort: { lastActivity: -1 } },
          { $project: { lastMessages: 0, unreadData: 0 } },
        ])
      );

      if (aggErr) {
        logError("myChats:aggregate", aggErr);
        return { success: false, chats: [] };
      }

      const chats = (chatList || []).map((chat: any) => ({
        id: chat._id.toString(),
        type: chat.type,
        name: chat.name || null,
        participants: (chat.participantDetails || []).map((p: any) => ({
          id: p._id.toString(),
          username: p.username,
          profilePic: p.profilePic || "",
        })),
        unreadCount: chat.unreadCount,
        lastMessage: chat.lastMessage
          ? {
              id: chat.lastMessage._id.toString(),
              content: chat.lastMessage.deleted
                ? "[Message deleted]"
                : chat.lastMessage.content,
              type: chat.lastMessage.type,
              sender: {
                id: chat.lastMessage.sender?._id?.toString() || "",
                username: chat.lastMessage.sender?.username || "",
                profilePic: chat.lastMessage.sender?.profilePic || "",
              },
              createdAt:
                chat.lastMessage.createdAt instanceof Date
                  ? chat.lastMessage.createdAt.toISOString()
                  : new Date(chat.lastMessage.createdAt).toISOString(),
            }
          : null,
        createdAt:
          chat.createdAt instanceof Date
            ? chat.createdAt.toISOString()
            : new Date(chat.createdAt).toISOString(),
        updatedAt:
          chat.updatedAt instanceof Date
            ? chat.updatedAt.toISOString()
            : new Date(chat.updatedAt || chat.createdAt).toISOString(),
      }));

      // Cache for 5 minutes; invalidated on every sendMessage
      await cache.set(cacheKey, chats, 300);

      return { success: true, chats };
    },

    async getChatMessages(_, { chatId, limit = 50, skip = 0, before }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [chatError, chat] = await catchError(Chat.findById(chatId).lean());

      if (chatError || !chat) {
        return { success: false, message: "Chat not found.", messages: [] };
      }

      if (!chat.participants.map((p: any) => p.toString()).includes(context.id)) {
        return {
          success: false,
          message: "You are not a participant in this chat.",
          messages: [],
        };
      }

      // Cursor-based pagination when `before` is provided; fall back to skip/limit
      const query: any = { chatId };
      if (before) {
        try {
          query._id = { $lt: new Types.ObjectId(before) };
        } catch {
          // invalid cursor — ignore and fetch from top
        }
      }

      const fetchLimit = limit + 1; // fetch one extra to determine hasMore

      const [error, messages] = await catchError(
        Message.find(query)
          .select(
            "sender content type readBy readAt attachments poll minitaskRef mentions replyTo createdAt edited editedAt deleted reactions"
          )
          .populate("sender", "username profilePic")
          .populate("poll.options.votes", "username profilePic")
          .populate("mentions", "username profilePic")
          .populate("minitaskRef.assignedTo", "username profilePic")
          .sort({ _id: -1 })
          .limit(before ? fetchLimit : limit)
          .skip(before ? 0 : skip)
          .lean()
      );

      if (error) {
        logError("getChatMessages", error);
        return { success: false, message: "Failed to fetch messages.", messages: [] };
      }

      const hasMore = before ? messages.length > limit : false;
      if (hasMore) messages.pop();

      const ordered = messages.reverse();
      const nextCursor =
        hasMore && ordered.length > 0 ? ordered[0]._id.toString() : null;

      return {
        success: true,
        nextCursor,
        hasMore,
        messages: ordered.map((m: any) => ({
          id: m._id.toString(),
          content: m.content,
          type: m.type,
          sender: m.sender
            ? {
                id: m.sender._id?.toString(),
                username: m.sender.username,
                profilePic: m.sender.profilePic,
              }
            : { id: "unknown", username: "Unknown User", profilePic: "" },
          readBy: m.readBy || [],
          readAt: m.readAt || [],
          edited: !!m.edited,
          editedAt: m.editedAt ? new Date(m.editedAt).toISOString() : null,
          deleted: !!m.deleted,
          reactions: m.reactions || [],
          replyTo: m.replyTo ? m.replyTo.toString() : null,
          mediaUrl:
            m.attachments && m.attachments.length > 0 ? m.attachments[0].url : undefined,
          poll: m.poll,
          minitaskRef: m.minitaskRef
            ? {
                ...m.minitaskRef,
                assignedTo: m.minitaskRef.assignedTo
                  ? {
                      id: m.minitaskRef.assignedTo._id?.toString(),
                      username: m.minitaskRef.assignedTo.username,
                      profilePic: m.minitaskRef.assignedTo.profilePic,
                    }
                  : { id: "unknown", username: "Unknown", profilePic: "" },
              }
            : null,
          mentions: m.mentions?.map((u: any) => ({
            id: u._id?.toString(),
            username: u.username,
            profilePic: u.profilePic,
          })),
          attachments: m.attachments || [],
          createdAt:
            m.createdAt instanceof Date
              ? m.createdAt.toISOString()
              : new Date(m.createdAt).toISOString(),
        })),
      };
    },

    async getUnreadCount(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Use distinct to get chat IDs in a single query, then count unread messages
      const [chatIdsErr, chatIds] = await catchError(
        Chat.distinct("_id", { participants: context.id })
      );

      if (chatIdsErr) {
        logError("getUnreadCount:distinct", chatIdsErr);
        return { success: false, count: 0 };
      }

      const [countErr, count] = await catchError(
        Message.countDocuments({
          chatId: { $in: chatIds },
          sender: { $ne: context.id },
          readBy: { $ne: context.id },
        })
      );

      if (countErr) {
        logError("getUnreadCount:count", countErr);
        return { success: false, count: 0 };
      }

      return { success: true, count };
    },

    async getChat(_, { chatId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const chat = await cache.getOrSet(
        cacheKeys.chat(chatId),
        async () => {
          let [error, chatData] = await catchError(
            Chat.findById(chatId)
              .select("type participants shardId name createdAt updatedAt")
              .populate("participants", "username profilePic")
              .populate("shardId", "title")
              .lean()
          );

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

          if (error || !chatData) throw new Error("Chat not found");
          return chatData;
        },
        1800
      );

      if (!chat.participants.map((p: any) => p._id.toString()).includes(context.id)) {
        return { success: false, message: "You are not a participant in this chat." };
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
          shard: chat.shardId
            ? {
                id: chat.shardId._id.toString(),
                title: (chat.shardId as any)?.title || "Shard Chat",
              }
            : null,
          createdAt: chat.createdAt,
        },
      };
    },
  },
};
