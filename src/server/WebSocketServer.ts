import { Server as HTTPServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";

interface SocketUser {
  userId: string;
  username: string;
  socketId: string;
}

interface ChatMessage {
  chatId: string;
  senderId: string;
  senderUsername: string;
  content: string;
  type: string;
  createdAt: Date;
}

interface TypingUser {
  chatId: string;
  userId: string;
  username: string;
}

// Store active users
const activeUsers = new Map<string, SocketUser>();

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
      const token = socket.handshake.auth?.token || 
                    socket.handshake.headers.authorization?.replace("Bearer ", "") ||
                    socket.handshake.query?.token;
      
      if (!token) {
        return next(new Error("Authentication error"));
      }

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
    const userId = socket.data.userId;
    const username = socket.data.username;

    console.log(`✅ User connected: ${username} (${userId})`);

    // Add user to active users
    activeUsers.set(userId, {
      userId,
      username,
      socketId: socket.id,
    });

    // Persist lastActive on connect
    User.findByIdAndUpdate(userId, { lastActive: new Date() }).catch(() => {});

    // Broadcast user is online
    socket.broadcast.emit("user:online", { userId, username });

    // Handle typing indicator
    socket.on("typing:start", (data: TypingUser) => {
      socket.to(data.chatId).emit("typing:indicator", {
        chatId: data.chatId,
        userId,
        username,
        isTyping: true,
      });
    });

    socket.on("typing:stop", (data: TypingUser) => {
      socket.to(data.chatId).emit("typing:indicator", {
        chatId: data.chatId,
        userId,
        username,
        isTyping: false,
      });
    });

    // Handle new message (from GraphQL, notify others)
    socket.on("message:new", (data: ChatMessage) => {
      socket.to(data.chatId).emit("message:received", data);
    });

    // Handle message read receipt
    socket.on("message:read", (data: { messageId: string, userId: string }) => {
      socket.to(data.messageId).emit("message:read", data);
    });

    // Join chat room
    socket.on("chat:join", (chatId: string) => {
      socket.join(`chat:${chatId}`);
      console.log(`📨 User ${username} joined chat ${chatId}`);
    });

    // Leave chat room
    socket.on("chat:leave", (chatId: string) => {
      socket.leave(`chat:${chatId}`);
      console.log(`👋 User ${username} left chat ${chatId}`);
    });

    // Handle connection to multiple chats
    socket.on("chats:join", (chatIds: string[]) => {
      chatIds.forEach((chatId) => {
        socket.join(`chat:${chatId}`);
      });
    });

    // Heartbeat to keep lastActive fresh during long sessions
    socket.on("heartbeat", () => {
      User.findByIdAndUpdate(userId, { lastActive: new Date() }).catch(() => {});
    });

    // Handle disconnection
    socket.on("disconnect", () => {
      activeUsers.delete(userId);

      // Persist lastActive on disconnect (records last-seen time)
      User.findByIdAndUpdate(userId, { lastActive: new Date() }).catch(() => {});

      // Broadcast user is offline
      socket.broadcast.emit("user:offline", { userId, username });
      
      console.log(`❌ User disconnected: ${username} (${userId})`);
    });

    // Handle errors
    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  });

  return io;
}

// Helper function to emit to specific chat (must be called with io instance)
export function emitToChat(io: SocketIOServer, chatId: string, event: string, data: any) {
  io.to(`chat:${chatId}`).emit(event, data);
}

// Helper function to emit to specific user (must be called with io instance)
export function emitToUser(io: SocketIOServer, userId: string, event: string, data: any) {
  const user = activeUsers.get(userId);
  if (user) {
    io.to(user.socketId).emit(event, data);
  }
}

// Helper function to check if user is online
export function isUserOnline(userId: string): boolean {
  return activeUsers.has(userId);
}

// Helper function to get online users
export function getOnlineUsers(): SocketUser[] {
  return Array.from(activeUsers.values());
}

