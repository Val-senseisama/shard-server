import { Schema, model, Types, Document } from "mongoose";

export interface AchievementDocument extends Document {
  title: string;
  description: string;
  icon: string; // emoji or icon name
  category: "consistency" | "speed" | "social" | "milestone" | "streak" | "custom";
  rarity: "common" | "rare" | "epic" | "legendary";
  requiredValue?: number; // for streak achievements, for example
  createdAt: Date;
}

const AchievementSchema = new Schema<AchievementDocument>(
  {
    title: { type: String, required: true },
    description: { type: String, required: true },
    icon: { type: String, required: true },
    category: {
      type: String,
      enum: ["consistency", "speed", "social", "milestone", "streak", "custom"],
      required: true,
    },
    rarity: {
      type: String,
      enum: ["common", "rare", "epic", "legendary"],
      required: true,
    },
    requiredValue: Number,
  },
  { timestamps: true }
);

export default model<AchievementDocument>("Achievement", AchievementSchema);

