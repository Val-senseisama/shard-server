import { Schema, model, Types, Document } from "mongoose";

export interface FriendshipDocument extends Document {
  user: Types.ObjectId;
  friend: Types.ObjectId;
  status: "pending" | "accepted" | "blocked";
  requestedBy: Types.ObjectId; // who initiated the friendship
  acceptedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const FriendshipSchema = new Schema<FriendshipDocument>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    friend: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "blocked"],
      default: "pending",
    },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    acceptedAt: Date,
  },
  { timestamps: true }
);

// Add compound indexes for common queries
FriendshipSchema.index({ user: 1, status: 1 });
FriendshipSchema.index({ friend: 1, status: 1 });
FriendshipSchema.index({ user: 1, friend: 1 }, { unique: true }); // Prevent duplicate friendships

export default model<FriendshipDocument>("Friendship", FriendshipSchema);

