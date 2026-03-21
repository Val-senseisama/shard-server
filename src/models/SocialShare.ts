import { Schema, model, Types, Document } from "mongoose";

export interface SocialShareDocument extends Document {
  userId: Types.ObjectId;
  shardId?: Types.ObjectId;
  achievementId?: Types.ObjectId;
  platform: "twitter" | "facebook" | "linkedin" | "reddit" | "custom";
  sharedAt: Date;
}

const SocialShareSchema = new Schema<SocialShareDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    shardId: { type: Schema.Types.ObjectId, ref: "Shard" },
    achievementId: { type: Schema.Types.ObjectId, ref: "Achievement" },
    platform: {
      type: String,
      enum: ["twitter", "facebook", "linkedin", "reddit", "custom"],
      required: true,
    },
    sharedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default model<SocialShareDocument>("SocialShare", SocialShareSchema);

