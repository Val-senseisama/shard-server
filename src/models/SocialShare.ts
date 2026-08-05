import { Schema, model, Types, Document } from "mongoose";

/**
 * Two things live here:
 *
 *  - `completion_card` — a shareable artifact the server generates when a quest
 *    is finished. This is the thing a user can actually post; until quests had a
 *    real completion event there was nothing to generate, and this whole
 *    collection was unused.
 *  - `platform_share` — a record that the user did share it somewhere, which is
 *    what the original model was for.
 */
export interface SocialShareDocument extends Document {
  userId: Types.ObjectId;
  shardId?: Types.ObjectId;
  achievementId?: Types.ObjectId;
  type: "shard_completed" | "achievement" | "streak_milestone" | "platform_share";
  /** Rendered copy for the card. */
  content?: string;
  /** Card facts — completion %, XP, days taken, on-time. */
  metadata?: Record<string, any>;
  /** Set only once the user actually shares it outward. */
  platform?: "twitter" | "facebook" | "linkedin" | "reddit" | "custom";
  sharedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SocialShareSchema = new Schema<SocialShareDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    shardId: { type: Schema.Types.ObjectId, ref: "Shard" },
    achievementId: { type: Schema.Types.ObjectId, ref: "Achievement" },
    type: {
      type: String,
      enum: ["shard_completed", "achievement", "streak_milestone", "platform_share"],
      required: true,
    },
    content: { type: String },
    metadata: { type: Schema.Types.Mixed },
    platform: {
      type: String,
      enum: ["twitter", "facebook", "linkedin", "reddit", "custom"],
    },
    // Only set when shared outward, so it can't default to "now".
    sharedAt: { type: Date },
  },
  { timestamps: true }
);

SocialShareSchema.index({ userId: 1, createdAt: -1 });
SocialShareSchema.index({ shardId: 1 });

export default model<SocialShareDocument>("SocialShare", SocialShareSchema);
