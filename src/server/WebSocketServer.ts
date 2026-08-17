import { Server as HTTPServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import Chat from "../models/Chat.js";

interface SocketUser {
  userId: string;
  username: string;
  socketId: string;
}

// socketId → { userId, username }
const socketUsers = new Map<string, { userId: string; username: string }>();

// userId → Set<socketId>  (multi-device: one user can have many sockets)
const userSockets = new Map<string, Set<string>>();

// userId → Set<chatId>  (persists across reconnects so rooms are auto-rejoined)
const userActiveChats = new Map<string, Set<string>>();

// userId → last DB write timestamp  (throttle heartbeat writes)
const lastHeartbeatWrite = new Map<string, number>();
const HEARTBEAT_DB_INTERVAL = 60_000; // write lastActive at most once per minute per user

/**
 * userId → the chat they currently have OPEN AND FOCUSED, with a timestamp.
 *
 * Deliberately separate from `userActiveChats`. Room membership is a poor proxy
 * for attention: `chats:join` subscribes to every chat at once so the chat list
 * can badge itself, and `userActiveChats` survives reconnects on purpose. A user
 * is "in" a dozen rooms while looking at none of them.
 *
 * This map means "eyes on this screen, right now", and is what suppresses a push
 * for a message the recipient is watching arrive.
 */
const userViewingChat = new Map<string, { chatId: string; at: number }>();

/**
 * How long a viewing claim stays fresh without a refresh.
 *
 * The client re-asserts it on every heartbeat (30s), so anything older than a
 * couple of missed beats means the app was backgrounded or killed without a
 * clean `chat:unviewing` — exactly the case where the push SHOULD fire. Erring
 * short is the safe direction: a stale claim silently swallows notifications.
 */
const VIEWING_TTL_MS = 90_000;

export function setupWebSocketServer(httpServer: HTTPServer) {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers.authorization?.replace("Bearer ", "") ||
        socket.handshake.query?.token;

      if (!token) return next(new Error("Authentication error"));

      const decoded: any = jwt.verify(token, process.env.JWT_ACCESS_TOKEN_SECRET!);
      socket.data.userId = decoded.id;
      socket.data.username = decoded.username;
      next();
    } catch (error) {
      console.error("WebSocket auth error:", error);
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    const userId: string = socket.data.userId;
    const username: string = socket.data.username;

    console.log(`✅ User connected: ${username} (${userId}) socket=${socket.id}`);

    // Track socket → user mapping
    socketUsers.set(socket.id, { userId, username });

    // Track user → sockets (multi-device)
    const isFirstSocket = !userSockets.has(userId) || userSockets.get(userId)!.size === 0;
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId)!.add(socket.id);

    // Auto-rejoin any chats this user was subscribed to before disconnect
    const knownChats = userActiveChats.get(userId);
    if (knownChats) {
      for (const chatId of knownChats) {
        socket.join(`chat:${chatId}`);
      }
      console.log(`🔄 Auto-rejoined ${knownChats.size} chat(s) for ${username}`);
    }

    // Only broadcast online + update DB on first socket for this user
    if (isFirstSocket) {
      User.findByIdAndUpdate(userId, { lastActive: new Date() }).catch(() => {});
      socket.broadcast.emit("user:online", { userId, username });
    }

    // Typing indicators — must use chat: prefix to match room names
    socket.on("typing:start", (data: { chatId: string }) => {
      socket.to(`chat:${data.chatId}`).emit("typing:indicator", {
        chatId: data.chatId,
        userId,
        username,
        isTyping: true,
      });
    });

    socket.on("typing:stop", (data: { chatId: string }) => {
      socket.to(`chat:${data.chatId}`).emit("typing:indicator", {
        chatId: data.chatId,
        userId,
        username,
        isTyping: false,
      });
    });

    // Join a chat room — validate membership before admitting
    socket.on("chat:join", async (chatId: string) => {
      if (!chatId || !mongoose.isValidObjectId(chatId)) return;
      try {
        const chat = await Chat.findById(chatId).select("participants").lean();
        if (!chat) return;
        const isMember = chat.participants.some(
          (p: any) => p.toString() === userId
        );
        if (!isMember) return; // silently reject — don't reveal room existence
        socket.join(`chat:${chatId}`);
        if (!userActiveChats.has(userId)) userActiveChats.set(userId, new Set());
        userActiveChats.get(userId)!.add(chatId);
      } catch {
        // ignore
      }
    });

    // Leave a chat room
    socket.on("chat:leave", (chatId: string) => {
      if (!chatId || !mongoose.isValidObjectId(chatId)) return;
      socket.leave(`chat:${chatId}`);
      userActiveChats.get(userId)?.delete(chatId);
      // Leaving the room implies the screen is gone, so drop the viewing claim
      // too — otherwise it lingers until the TTL and eats pushes in between.
      const viewing = userViewingChat.get(userId);
      if (viewing?.chatId === chatId) userViewingChat.delete(userId);
    });

    // ─── Attention tracking ───────────────────────────────────────────────────
    // Emitted by the chat screen on focus/blur. Room membership can't stand in
    // for this (see userViewingChat above).

    socket.on("chat:viewing", (chatId: string) => {
      if (!chatId || !mongoose.isValidObjectId(chatId)) return;
      // No membership check needed: the claim can only ever suppress the
      // claimant's OWN notifications, so the worst a forged one does is silence
      // the sender's own pushes.
      userViewingChat.set(userId, { chatId, at: Date.now() });
    });

    socket.on("chat:unviewing", (chatId?: string) => {
      const viewing = userViewingChat.get(userId);
      if (!viewing) return;
      // A bare unviewing clears whatever was claimed; a targeted one only clears
      // a match, so a stale blur from a screen the user already left can't
      // cancel the claim of the screen they just opened.
      if (!chatId || viewing.chatId === chatId) userViewingChat.delete(userId);
    });

    // Join multiple chats at once — each validated individually
    socket.on("chats:join", async (chatIds: string[]) => {
      if (!Array.isArray(chatIds)) return;
      const validIds = chatIds.filter(
        (id) => id && mongoose.isValidObjectId(id)
      );
      if (validIds.length === 0) return;
      try {
        const chats = await Chat.find({
          _id: { $in: validIds },
          participants: new mongoose.Types.ObjectId(userId),
        }).select("_id").lean();
        const allowedIds = new Set(chats.map((c: any) => c._id.toString()));
        if (!userActiveChats.has(userId)) userActiveChats.set(userId, new Set());
        validIds.forEach((chatId) => {
          if (allowedIds.has(chatId)) {
            socket.join(`chat:${chatId}`);
            userActiveChats.get(userId)!.add(chatId);
          }
        });
      } catch {
        // ignore
      }
    });

    // Heartbeat — throttled to one DB write per minute to avoid hammering Mongo
    socket.on("heartbeat", (payload?: { viewingChatId?: string | null }) => {
      const now = Date.now();

      // Re-assert the viewing claim so it stays fresh while the screen is open.
      // Riding the heartbeat rather than its own timer is what makes the claim
      // self-expiring: background the app and the JS timer suspends, the claim
      // goes stale, and pushes resume without needing a clean blur event.
      const viewingChatId = payload?.viewingChatId;
      if (viewingChatId && mongoose.isValidObjectId(viewingChatId)) {
        userViewingChat.set(userId, { chatId: viewingChatId, at: now });
      } else if (viewingChatId === null) {
        userViewingChat.delete(userId);
      }

      const last = lastHeartbeatWrite.get(userId) ?? 0;
      if (now - last >= HEARTBEAT_DB_INTERVAL) {
        lastHeartbeatWrite.set(userId, now);
        User.findByIdAndUpdate(userId, { lastActive: new Date() }).catch(() => {});
      }
    });

    // Disconnection
    socket.on("disconnect", () => {
      socketUsers.delete(socket.id);

      const userSocketSet = userSockets.get(userId);
      if (userSocketSet) {
        userSocketSet.delete(socket.id);

        if (userSocketSet.size === 0) {
          // Last socket for this user — they're fully offline
          userSockets.delete(userId);
          lastHeartbeatWrite.delete(userId);
          userViewingChat.delete(userId);
          User.findByIdAndUpdate(userId, { lastActive: new Date() }).catch(() => {});
          socket.broadcast.emit("user:offline", { userId, username });
          console.log(`❌ ${username} fully disconnected`);
        } else {
          console.log(`📱 Socket closed for ${username}, ${userSocketSet.size} device(s) still connected`);
        }
      }
    });

    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  });

  return io;
}

// Emit to all active sockets for a user (multi-device aware)
export function emitToUser(io: SocketIOServer, userId: string, event: string, data: any) {
  const socketIds = userSockets.get(userId);
  if (socketIds) {
    for (const socketId of socketIds) {
      io.to(socketId).emit(event, data);
    }
  }
}

export function emitToChat(io: SocketIOServer, chatId: string, event: string, data: any) {
  io.to(`chat:${chatId}`).emit(event, data);
}

export function isUserOnline(userId: string): boolean {
  const sockets = userSockets.get(userId);
  return !!(sockets && sockets.size > 0);
}

/**
 * Is this user looking at one of these chats right now?
 *
 * Variadic because the mobile client addresses a shard chat by the SHARD id
 * until `getChat` resolves, then upgrades to the chat document's own `_id` — so
 * the claim on file may be either. Callers pass both and let this sort it out.
 *
 * Returns false for a claim older than VIEWING_TTL_MS. A stale claim is
 * indistinguishable from a killed app, and the failure modes are not symmetric:
 * a wrongly-suppressed message is one the user never learns about, while a
 * wrongly-sent one is a redundant buzz.
 *
 * In-process only. With multiple server instances a user's socket may live on a
 * different instance than the one handling their friend's `sendMessage`, and
 * this returns false there — degrading to today's behaviour (a redundant push),
 * never to a swallowed one. Moving it to Redis is the fix if that starts to bite.
 */
export function isViewingChat(userId: string, ...chatIds: (string | null | undefined)[]): boolean {
  const viewing = userViewingChat.get(userId);
  if (!viewing) return false;
  if (Date.now() - viewing.at > VIEWING_TTL_MS) {
    userViewingChat.delete(userId);
    return false;
  }
  return chatIds.some((id) => !!id && id === viewing.chatId);
}

export function getOnlineUsers(): SocketUser[] {
  return Array.from(userSockets.entries()).map(([userId, socketIds]) => {
    const firstSocketId = socketIds.values().next().value ?? "";
    const user = socketUsers.get(firstSocketId);
    return { userId, username: user?.username ?? "", socketId: firstSocketId };
  });
}
