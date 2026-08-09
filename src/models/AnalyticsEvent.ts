import { Schema, model, Types, Document } from "mongoose";

/**
 * Product-analytics event (revenue funnel). Distinct from the Analytics model,
 * which stores user-facing productivity data. These are lightweight, append-only
 * telemetry rows: signup -> activation -> paywall impression -> upgrade -> purchase.
 */
export interface AnalyticsEventDocument extends Document {
  userId?: Types.ObjectId; // null for pre-auth / anonymous events
  anonId?: string; // stable client install id, ties pre-auth events together
  name: string; // canonical event name, e.g. "paywall_impression"
  source?: string; // context, e.g. paywall source "ai_credits" | "shard_limit"
  props?: Record<string, unknown>; // small free-form payload
  tier?: string; // user's tier at event time ("free" | "pro" | "anon")
  platform?: string; // "ios" | "android" | "web"
  createdAt: Date;
}

const AnalyticsEventSchema = new Schema<AnalyticsEventDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    anonId: { type: String },
    name: { type: String, required: true },
    source: { type: String },
    props: { type: Schema.Types.Mixed },
    tier: { type: String },
    platform: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Funnel queries scan by event name within a time window.
AnalyticsEventSchema.index({ name: 1, createdAt: -1 });
AnalyticsEventSchema.index({ userId: 1, createdAt: -1 });
// TTL: the funnel only ever looks back over a window (getFunnelStats defaults to
// 30 days), so raw events beyond a quarter are pure storage cost on a 512MB
// tier. If you need longer trends, roll these up into a summary collection —
// do not widen this and hope.
AnalyticsEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export default model<AnalyticsEventDocument>("AnalyticsEvent", AnalyticsEventSchema);
