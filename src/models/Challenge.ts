import { Schema, model, Types, Document } from "mongoose";

export interface ChallengeDocument extends Document {
  userId: Types.ObjectId;
  type: "daily" | "weekly";
  title: string;
  description?: string;
  shardId?: Types.ObjectId; // optional link to a specific shard
  targetDate: Date;
  xpReward: number;
  completed: boolean;
  completedAt?: Date;
}

const ChallengeSchema = new Schema<ChallengeDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: ["daily", "weekly"],
      required: true,
    },
    title: { type: String, required: true },
    description: String,
    shardId: { type: Schema.Types.ObjectId, ref: "Shard" },
    targetDate: { type: Date, required: true },
    xpReward: { type: Number, default: 50 },
    completed: { type: Boolean, default: false },
    completedAt: Date,
  },
  { timestamps: true }
);

// Add compound indexes
ChallengeSchema.index({ userId: 1, completed: 1 });
ChallengeSchema.index({ userId: 1, type: 1, completed: 1 });
ChallengeSchema.index({ type: 1, targetDate: 1 });

export default model<ChallengeDocument>("Challenge", ChallengeSchema);

