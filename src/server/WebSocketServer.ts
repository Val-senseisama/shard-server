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
    socket.on("heartbeat", () => {
      const now = Date.now();
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

export function getOnlineUsers(): SocketUser[] {
  return Array.from(userSockets.entries()).map(([userId, socketIds]) => {
    const firstSocketId = socketIds.values().next().value ?? "";
    const user = socketUsers.get(firstSocketId);
    return { userId, username: user?.username ?? "", socketId: firstSocketId };
  });
}
