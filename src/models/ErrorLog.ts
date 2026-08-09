import { Schema, model, Types, Document } from "mongoose";

export interface ErrorLogDocument extends Document {
  task: string;
  resolver?: string;
  errorMessage: string;
  stack?: string;
  userId?: Types.ObjectId;
  severity: "low" | "medium" | "high" | "critical";
  metadata?: Record<string, any>;
  timestamp: string;
  createdAt: Date;
}

const ErrorLogSchema = new Schema<ErrorLogDocument>(
  {
    task: { type: String, required: true },
    resolver: String,
    errorMessage: { type: String, required: true },
    stack: String,
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    severity: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },
    metadata: { type: Schema.Types.Mixed },
    timestamp: { type: String, required: true },
  },
  { timestamps: true }
);

ErrorLogSchema.index({ severity: 1 });
ErrorLogSchema.index({ resolver: 1 });
ErrorLogSchema.index({ userId: 1 });
// TTL: error logs are for debugging the recent past, and /log-errors is a public
// write path — without an expiry this collection grows without bound and the
// first symptom is a full disk.
//
// 14 days, sized for a 512MB Atlas free tier: this is the fastest-growing
// collection here and the one an attacker can grow on purpose. If you are
// debugging something older than two weeks you want the stack trace, not the row.
// NOTE: this replaces a plain { createdAt: 1 } index. Mongo allows only one
// index per key pattern, so the old one must be dropped for this to apply —
// `npm run ensure:indexes` does that via syncIndexes().
ErrorLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });

export default model<ErrorLogDocument>("ErrorLog", ErrorLogSchema);
