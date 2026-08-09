import { Schema, model, Types, Document } from "mongoose";

export interface AuditTrailDocument extends Document {
  userId: Types.ObjectId;
  task: string;
  details: string;
  createdAt: Date;
}

const AuditTrailSchema = new Schema<AuditTrailDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    task: { type: String, required: true },
    details: { type: String, required: true },
  },
  { timestamps: true }
);

// The admin audit view pages by user and by recency; neither had an index.
AuditTrailSchema.index({ userId: 1, createdAt: -1 });
// TTL: 90 days. This is append-only and written on nearly every mutation —
// XP awards, logins, admin actions — so on a 512MB tier it is the collection most
// likely to exhaust storage first. A quarter is long enough to answer "what
// happened to this account". Raise it only alongside a bigger cluster, or if a
// compliance requirement demands it.
AuditTrailSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export default model<AuditTrailDocument>("AuditTrail", AuditTrailSchema);

