import { Schema, model, Types, Document } from "mongoose";

export interface SubscriptionHistoryDocument extends Document {
  userId: Types.ObjectId;
  tier: "free" | "pro" | "enterprise";
  action: "PURCHASE" | "RENEWAL" | "CANCELLATION" | "EXPIRY" | "UPGRADE";
  amount: number;
  currency: string;
  paymentId?: string;
  details?: string;
  timestamp: Date;
}

const SubscriptionHistorySchema = new Schema<SubscriptionHistoryDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tier: {
      type: String,
      enum: ["free", "pro", "enterprise"],
      required: true,
    },
    action: {
      type: String,
      enum: ["PURCHASE", "RENEWAL", "CANCELLATION", "EXPIRY", "UPGRADE"],
      required: true,
    },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    paymentId: String,
    details: String,
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Add index for history lookups
SubscriptionHistorySchema.index({ userId: 1, timestamp: -1 });

export default model<SubscriptionHistoryDocument>("SubscriptionHistory", SubscriptionHistorySchema);
