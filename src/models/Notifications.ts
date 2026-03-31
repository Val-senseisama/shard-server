import { Schema, model, Types, Document } from "mongoose";

export interface NotificationDocument extends Document {
  userId: Types.ObjectId;       // who gets notified
  shardId?: Types.ObjectId;     // optional link to shard
  miniGoalId?: Types.ObjectId;  // optional link to mini-goal/task
  message: string;              // notification text
  type: string;                 // notification type (friend_request, shard_invite, etc.)
  triggerAt: Date;              // when the push should fire (may be in future during quiet hours)
  dispatched: boolean;          // has the FCM/email push been sent?
  read: boolean;                // has the user seen it in-app?
}

const NotificationSchema = new Schema<NotificationDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    shardId: { type: Schema.Types.ObjectId, ref: "Shard" },
    miniGoalId: { type: Schema.Types.ObjectId, ref: "MiniGoal" },
    message: { type: String, required: true },
    type: { type: String, default: "" },
    triggerAt: { type: Date, required: true },
    dispatched: { type: Boolean, default: false },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Add compound indexes
NotificationSchema.index({ userId: 1, read: 1 });
NotificationSchema.index({ userId: 1, read: 1, triggerAt: 1 });
NotificationSchema.index({ triggerAt: 1 }, { sparse: true }); // Sparse index for scheduled notifications

// TTL index to auto-delete notifications older than 90 days
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // 90 days in seconds

export default model<NotificationDocument>("Notification", NotificationSchema);
