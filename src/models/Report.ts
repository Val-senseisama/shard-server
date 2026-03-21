import { Schema, model, Types, Document } from "mongoose";

export interface ReportDocument extends Document {
  reporterId: Types.ObjectId;      // Who reported
  reportedUserId: Types.ObjectId;  // Who was reported
  reason: string;                   // Type of report
  details?: string;                // Additional details
  reportedItemId?: Types.ObjectId; // Optional: what was reported (message, shard, etc)
  reportedItemType?: "message" | "shard" | "user"; // Type of item
  status: "pending" | "reviewed" | "resolved" | "rejected";
  reviewedBy?: Types.ObjectId;     // Admin who reviewed
  reviewedAt?: Date;
  resolution?: string;            // Admin's resolution note
  createdAt: Date;
  updatedAt: Date;
}

const ReportSchema = new Schema<ReportDocument>(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reportedUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reason: { type: String, required: true }, // "harassment", "spam", "inappropriate", "scam", etc.
    details: { type: String },
    reportedItemId: { type: Schema.Types.ObjectId },
    reportedItemType: { 
      type: String, 
      enum: ["message", "shard", "user"],
    },
    status: { 
      type: String, 
      enum: ["pending", "reviewed", "resolved", "rejected"], 
      default: "pending" 
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    resolution: { type: String },
  },
  { timestamps: true }
);

// Indexes
ReportSchema.index({ reportedUserId: 1, status: 1 });
ReportSchema.index({ reporterId: 1, createdAt: -1 });
ReportSchema.index({ status: 1, createdAt: -1 });

export default model<ReportDocument>("Report", ReportSchema);

