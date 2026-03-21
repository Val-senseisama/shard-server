import { Schema, model, Types, Document } from "mongoose";

export interface NotificationPreferencesDocument extends Document {
  userId: Types.ObjectId;
  
  // Notification types
  friendRequests: boolean;
  messages: boolean;
  shardInvites: boolean;
  shardUpdates: boolean;
  questDeadlines: boolean;
  achievements: boolean;
  
  // Quiet hours
  quietHoursEnabled: boolean;
  quietHoursStart: string; // e.g., "22:00"
  quietHoursEnd: string;   // e.g., "08:00"
  
  // Delivery preferences
  pushEnabled: boolean;
  emailEnabled: boolean;
  
  createdAt: Date;
  updatedAt: Date;
}

const NotificationPreferencesSchema = new Schema<NotificationPreferencesDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", unique: true, required: true },
    
    friendRequests: { type: Boolean, default: true },
    messages: { type: Boolean, default: true },
    shardInvites: { type: Boolean, default: true },
    shardUpdates: { type: Boolean, default: true },
    questDeadlines: { type: Boolean, default: true },
    achievements: { type: Boolean, default: true },
    
    quietHoursEnabled: { type: Boolean, default: false },
    quietHoursStart: { type: String, default: "22:00" },
    quietHoursEnd: { type: String, default: "08:00" },
    
    pushEnabled: { type: Boolean, default: true },
    emailEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Index
NotificationPreferencesSchema.index({ userId: 1 });

export default model<NotificationPreferencesDocument>("NotificationPreference", NotificationPreferencesSchema);

