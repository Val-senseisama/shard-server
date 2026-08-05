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
  /**
   * Lifecycle state — see Helpers/ShardLifecycle.ts for the transitions.
   * `at_risk` and `stalled` are set by the nightly sweep from `lastActivityAt`;
   * `completed` and `expired` are terminal.
   */
  status: "active" | "paused" | "at_risk" | "stalled" | "completed" | "expired" | "abandoned";
  /** When the quest was finished, for the completion payout and stats. */
  completedAt?: Date;
  /** XP actually paid out on completion, so it can't be paid twice. */
  completionXPAwarded?: number;
  /** Habit quests: the period key (`YYYY-MM-DD` or `YYYY-Www`) last checked in. */
  lastCycleKey?: string;
  // Removed miniGoals array - using separate MiniGoal collection instead
  rewards: { type: "xp" | "badge"; value: number | string }[];
  questType: "standard" | "habit";
  cadence?: "daily" | "weekly" | "custom";
  habitStreak: number;
  lastActivityAt?: Date;
  lastNudgedAt?: Date;
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
      enum: ["active", "paused", "at_risk", "stalled", "completed", "expired", "abandoned"],
      default: "active",
    },
    completedAt: Date,
    completionXPAwarded: Number,
    lastCycleKey: { type: String },
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
    questType: {
      type: String,
      enum: ["standard", "habit"],
      default: "standard"
    },
    cadence: {
      type: String,
      enum: ["daily", "weekly", "custom"]
    },
    habitStreak: { type: Number, default: 0 },
    lastActivityAt: { type: Date },
    lastNudgedAt: { type: Date },
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
// The lifecycle sweep and campaigns both select open shards by staleness.
ShardSchema.index({ status: 1, lastActivityAt: 1 });
ShardSchema.index({ owner: 1, status: 1 });

export default model<ShardDocument>("Shard", ShardSchema);
