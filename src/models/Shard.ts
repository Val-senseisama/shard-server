import { Schema, model, Types, Document } from "mongoose";

interface Participant {
  user: Types.ObjectId;
  role: "collaborator" | "accountability_partner";
}

export interface ShardDocument extends Document {
  title: string;
  image?: string;
  description?: string;
  owner: Types.ObjectId;
  participants: Participant[];
  chatId?: Types.ObjectId;
  timeline: {
    startDate: Date;
    endDate?: Date;
  };
  progress: {
    completion: number;
    xpEarned: number;
    level: number;
  };
  status: "active" | "paused" | "completed" | "expired";
  // Removed miniGoals array - using separate MiniGoal collection instead
  rewards: { type: "xp" | "badge"; value: number | string }[];
  isPrivate: boolean;
  isAnonymous: boolean;
  version: number;
}

const ShardSchema = new Schema<ShardDocument>(
  {
    title: { type: String, required: true },
    image: String,
    description: String,
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    participants: [
      {
        user: { type: Schema.Types.ObjectId, ref: "User", required: true },
        role: { type: String, enum: ["collaborator", "accountability_partner"], required: true },
      },
    ],
    chatId: { type: Schema.Types.ObjectId, ref: "Chat" },
    timeline: {
      startDate: { type: Date, required: true },
      endDate: Date,
    },
    progress: {
      completion: { type: Number, default: 0 },
      xpEarned: { type: Number, default: 0 },
      level: { type: Number, default: 1 },
    },
    status: {
      type: String,
      enum: ["active", "paused", "completed", "expired"],
      default: "active",
    },
    // MiniGoals are now in their own collection (MiniGoal model)
    rewards: [
      {
        type: {
          type: String,
          enum: ["xp", "badge"],
          required: true,
        },
        value: { type: Schema.Types.Mixed, required: true },
      },
    ],
    isPrivate: { type: Boolean, default: false },
    isAnonymous: { type: Boolean, default: false },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

// Add indexes
ShardSchema.index({ owner: 1 });
ShardSchema.index({ status: 1 });
ShardSchema.index({ "timeline.endDate": 1 });

export default model<ShardDocument>("Shard", ShardSchema);
