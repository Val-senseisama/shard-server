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
ErrorLogSchema.index({ createdAt: 1 });
ErrorLogSchema.index({ userId: 1 });

export default model<ErrorLogDocument>("ErrorLog", ErrorLogSchema);
