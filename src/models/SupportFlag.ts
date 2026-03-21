import { Schema, model, Types, Document } from "mongoose";

export interface SupportFlagDocument extends Document {
  userId: Types.ObjectId;
  issueType: "bug" | "feature_request" | "complaint" | "other";
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "urgent";
  status: "open" | "in_progress" | "resolved" | "closed";
  assignedTo?: Types.ObjectId; // Support team member
  attachments?: string[]; // URLs to screenshots, etc.
  resolution?: string;
  resolvedBy?: Types.ObjectId;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SupportFlagSchema = new Schema<SupportFlagDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    issueType: { 
      type: String, 
      enum: ["bug", "feature_request", "complaint", "other"], 
      required: true 
    },
    title: { type: String, required: true },
    description: { type: String, required: true },
    priority: { 
      type: String, 
      enum: ["low", "medium", "high", "urgent"], 
      default: "low" 
    },
    status: { 
      type: String, 
      enum: ["open", "in_progress", "resolved", "closed"], 
      default: "open" 
    },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User" },
    attachments: [{ type: String }],
    resolution: { type: String },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    resolvedAt: { type: Date },
  },
  { timestamps: true }
);

// Indexes
SupportFlagSchema.index({ userId: 1, status: 1 });
SupportFlagSchema.index({ status: 1, priority: 1, createdAt: -1 });
SupportFlagSchema.index({ issueType: 1 });

export default model<SupportFlagDocument>("SupportFlag", SupportFlagSchema);

