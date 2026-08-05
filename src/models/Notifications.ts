import { Schema, model, Types, Document } from "mongoose";

export interface NotificationDocument extends Document {
  userId: Types.ObjectId;       // who gets notified
  shardId?: Types.ObjectId;     // optional link to shard
  miniGoalId?: Types.ObjectId;  // optional link to mini-goal/task
  message: string;              // notification text
  type: string;                 // notification type (friend_request, shard_invite, etc.)
  /** The NotifyKind that produced this — finer-grained than `type`. */
  kind?: string;
  /** transactional | celebratory | retention — what the daily budget counts. */
  priority?: string;
  /** `YYYY-MM-DD` in the user's own timezone; the budget window. */
  dayKey?: string;
  /** `kind:scope` — a unique-per-user guard against re-sending the same thing. */
  dedupeKey?: string;
  /** Deep-link payload handed to the client on tap. */
  data?: Record<string, string>;
  triggerAt: Date;              // when the push should fire (may be in future during quiet hours)
  dispatched: boolean;          // has the FCM/email push been sent?
  read: boolean;                // has the user seen it in-app?
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<NotificationDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    shardId: { type: Schema.Types.ObjectId, ref: "Shard" },
    miniGoalId: { type: Schema.Types.ObjectId, ref: "MiniGoal" },
    message: { type: String, required: true },
    type: { type: String, default: "" },
    kind: { type: String },
    priority: { type: String, enum: ["transactional", "celebratory", "retention"] },
    dayKey: { type: String },
    dedupeKey: { type: String },
    data: { type: Schema.Types.Mixed },
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

// Daily-budget lookup: "how many retention pushes has this user had today?"
NotificationSchema.index({ userId: 1, priority: 1, dayKey: 1 });

// Dedupe guard. Unique per user so two concurrent jobs can't both win the race —
// the loser's insert fails and Notify treats it as a duplicate.
//
// MUST be `partialFilterExpression`, not `sparse`. A compound sparse index only
// skips a document when *every* indexed field is absent, and `userId` is always
// present — so with `sparse: true` a second notification that opted out of
// deduping indexes as (userId, null), collides with the first, and gets thrown
// away. That silently swallowed every chat message, friend request and legacy
// notification after the first one, forever. Verified against a real mongod.
NotificationSchema.index(
  { userId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } }
);

// TTL index to auto-delete notifications older than 90 days
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // 90 days in seconds

export default model<NotificationDocument>("Notification", NotificationSchema);
