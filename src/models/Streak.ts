import { Schema, model, Types, Document } from "mongoose";

export interface StreakDocument extends Document {
  userId: Types.ObjectId;
  type: "daily_login" | "shard_completion" | "task_completion" | "mini_goal_completion";
  currentStreak: number;
  longestStreak: number;
  lastActivityDate: Date;
  streakStartDate: Date;
}

const StreakSchema = new Schema<StreakDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: ["daily_login", "shard_completion", "task_completion", "mini_goal_completion"],
      required: true,
    },
    currentStreak: { type: Number, default: 0 },
    longestStreak: { type: Number, default: 0 },
    lastActivityDate: { type: Date, default: Date.now },
    streakStartDate: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Add indexes
StreakSchema.index({ userId: 1, type: 1 });

export default model<StreakDocument>("Streak", StreakSchema);

