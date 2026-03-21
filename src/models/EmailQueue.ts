import { Schema, model, Document } from "mongoose";

export interface EmailQueueDocument extends Document {
  toEmail: string;
  subject: string;
  message: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  lastAttemptAt?: Date;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EmailQueueSchema = new Schema<EmailQueueDocument>(
  {
    toEmail: { 
      type: String, 
      required: true,
      lowercase: true 
    },
    subject: { type: String, required: true },
    message: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
    },
    attempts: { 
      type: Number, 
      default: 0 
    },
    lastAttemptAt: Date,
    sentAt: Date,
  },
  { timestamps: true }
);

// Add indexes
EmailQueueSchema.index({ status: 1, attempts: 1 });
EmailQueueSchema.index({ status: 1, createdAt: 1 });
EmailQueueSchema.index({ toEmail: 1 });

export default model<EmailQueueDocument>("EmailQueue", EmailQueueSchema);

