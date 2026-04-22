import { Schema, model, Types, Document } from "mongoose";

// Chat model for managing conversations
export interface ChatDocument extends Document {
  type: "direct" | "shard" | "group";
  participants: Types.ObjectId[]; // Users in the chat
  shardId?: Types.ObjectId; // If this is a shard chat
  name?: string; // For group chats
  createdAt: Date;
  updatedAt: Date;
}

const ChatSchema = new Schema<ChatDocument>(
  {
    type: {
      type: String,
      enum: ["direct", "shard", "group"],
      required: true,
    },
    participants: [{ type: Schema.Types.ObjectId, ref: "User", required: true }],
    shardId: { type: Schema.Types.ObjectId, ref: "Shard" },
    name: String,
  },
  { timestamps: true }
);

// Message model for individual messages
export interface MessageDocument extends Document {
  chatId: Types.ObjectId;
  sender: Types.ObjectId;
  content: string;
  type: "text" | "system" | "nudge" | "image" | "audio" | "video" | "file" | "poll" | "minitask_assignment" | "summary_ping";
  replyTo?: Types.ObjectId; // ID of the message this is a reply to
  readBy: Types.ObjectId[]; // Users who have read this message
  readAt?: { userId: Types.ObjectId; readAt: Date }[]; // Detailed read receipts with timestamps
  edited: boolean; // Whether message was edited
  editedAt?: Date;
  deleted: boolean; // Whether message was deleted
  attachments?: { url: string; type: string; name?: string }[]; // File attachments
  reactions?: { userId: Types.ObjectId; emoji: string }[]; // Message reactions
  mentions?: Types.ObjectId[]; // Mentioned users
  poll?: {
    question: string;
    options: { text: string; votes: Types.ObjectId[] }[];
    multipleAnswers: boolean;
  };
  minitaskRef?: {
    miniGoalId: Types.ObjectId;
    taskId: string;
    assignedTo: Types.ObjectId;
  };
  createdAt: Date;
}

const MessageSchema = new Schema<MessageDocument>(
  {
    chatId: { type: Schema.Types.ObjectId, ref: "Chat", required: true },
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true },
    type: {
      type: String,
      enum: ["text", "system", "nudge", "image", "audio", "video", "file", "poll", "minitask_assignment", "summary_ping"],
      default: "text",
    },
    replyTo: { type: Schema.Types.ObjectId, ref: "Message" },
    readBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
    readAt: [{
      userId: { type: Schema.Types.ObjectId, ref: "User" },
      readAt: { type: Date, default: Date.now },
    }],
    edited: { type: Boolean, default: false },
    editedAt: { type: Date },
    deleted: { type: Boolean, default: false },
    attachments: [{
      url: { type: String },
      type: { type: String },
      name: { type: String },
    }],
    reactions: [{
      userId: { type: Schema.Types.ObjectId, ref: "User" },
      emoji: { type: String },
    }],
    mentions: [{ type: Schema.Types.ObjectId, ref: "User" }],
    poll: {
      question: { type: String },
      options: [{
        text: { type: String },
        votes: [{ type: Schema.Types.ObjectId, ref: "User" }],
      }],
      multipleAnswers: { type: Boolean, default: false },
    },
    minitaskRef: {
      miniGoalId: { type: Schema.Types.ObjectId, ref: "MiniGoal" },
      taskId: { type: String },
      assignedTo: { type: Schema.Types.ObjectId, ref: "User" },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Add indexes for Chat
ChatSchema.index({ participants: 1 });
ChatSchema.index({ shardId: 1 }, { sparse: true });
ChatSchema.index({ type: 1, createdAt: -1 });

// Add indexes for Message
MessageSchema.index({ chatId: 1, createdAt: -1 }); // For fetching messages in a chat
MessageSchema.index({ sender: 1, createdAt: -1 }); // For user's message history

const Chat = model<ChatDocument>("Chat", ChatSchema);
const Message = model<MessageDocument>("Message", MessageSchema);

export default Chat;
export { Message };
