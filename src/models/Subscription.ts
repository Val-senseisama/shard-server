import { Schema, model, Types, Document } from "mongoose";

export interface SubscriptionDocument extends Document {
  userId: Types.ObjectId;
  tier: "free" | "premium";
  startDate: Date;
  endDate?: Date; // null for lifetime, date for expiry
  cancelledAt?: Date;
  paymentId?: string;
  features: string[]; // e.g., ["no_ads", "unlimited_shards", "advanced_analytics"]
}

const SubscriptionSchema = new Schema<SubscriptionDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    tier: {
      type: String,
      enum: ["free", "premium"],
      default: "free",
    },
    startDate: { type: Date, default: Date.now },
    endDate: Date,
    cancelledAt: Date,
    paymentId: String,
    features: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true }
);

export default model<SubscriptionDocument>("Subscription", SubscriptionSchema);

