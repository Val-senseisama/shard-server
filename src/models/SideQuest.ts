import { Schema, model, Types, Document } from "mongoose";

export interface SideQuestDocument extends Document {
  userId: Types.ObjectId;
  title: string;
  description: string;
  difficulty: "easy" | "medium" | "hard" | "extreme";
  recommendedBy: "ai" | "user";
  xpReward: number;
  category: string;
  completed: boolean;
  createdAt: Date;
  completedAt?: Date;
}

const SideQuestSchema = new Schema<SideQuestDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    difficulty: {
      type: String,
      enum: ["easy", "medium", "hard", "extreme"],
      required: true,
    },
    recommendedBy: {
      type: String,
      enum: ["ai", "user"],
      default: "ai",
    },
    xpReward: { type: Number, required: true },
    category: { type: String, required: true },
    completed: { type: Boolean, default: false },
    completedAt: Date,
  },
  { timestamps: true }
);

// Add indexes
SideQuestSchema.index({ userId: 1, completed: 1 });
SideQuestSchema.index({ recommendedBy: 1 });

export default model<SideQuestDocument>("SideQuest", SideQuestSchema);

