import { Schema, model, Types, Document } from "mongoose";

export interface SupportFlagDocument extends Document {
  /**
   * The account that raised the ticket. Optional: the public support form on
   * shard.app submits without a session, and those tickets carry guestName /
   * guestEmail instead. Anything reading this field must handle null — see the
   * mappers in resolvers/Support.ts and resolvers/Admin.ts.
   */
  userId?: Types.ObjectId;
  /** Set only on guest tickets (no userId). */
  guestName?: string;
  /** Set only on guest tickets — the only way to reply to them. */
  guestEmail?: string;
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
    userId: { type: Schema.Types.ObjectId, ref: "User", required: false },
    guestName: { type: String, trim: true },
    guestEmail: { type: String, trim: true, lowercase: true },
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
// Guest tickets are looked up by email when someone follows up without an account.
SupportFlagSchema.index({ guestEmail: 1, createdAt: -1 }, { sparse: true });

export default model<SupportFlagDocument>("SupportFlag", SupportFlagSchema);

