import { Schema, model, Types, Document } from "mongoose";

interface ProductivityMetric {
  date: Date;
  tasksCompleted: number;
  xpEarned: number;
  shardsActive: number;
  hoursLogged?: number;
}

interface StruggleArea {
  category: string; // e.g., "procrastination", "time_management", "focus"
  severity: number; // 1-10
  lastUpdated: Date;
}

export interface AnalyticsDocument extends Document {
  userId: Types.ObjectId;
  productivityHistory: ProductivityMetric[];
  struggleAreas: StruggleArea[];
  averageCompletionRate: number; // 0-100
  preferredTimes: string[]; // times of day when user is most productive
  createdAt: Date;
  updatedAt: Date;
}

const ProductivityMetricSchema = new Schema<ProductivityMetric>(
  {
    date: { type: Date, required: true },
    tasksCompleted: { type: Number, default: 0 },
    xpEarned: { type: Number, default: 0 },
    shardsActive: { type: Number, default: 0 },
    hoursLogged: Number,
  },
  { _id: false }
);

const StruggleAreaSchema = new Schema<StruggleArea>(
  {
    category: { type: String, required: true },
    severity: { type: Number, min: 1, max: 10, required: true },
    lastUpdated: { type: Date, default: Date.now },
  },
  { _id: false }
);

const AnalyticsSchema = new Schema<AnalyticsDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    productivityHistory: [ProductivityMetricSchema],
    struggleAreas: [StruggleAreaSchema],
    averageCompletionRate: { type: Number, default: 0 },
    preferredTimes: [String],
  },
  { timestamps: true }
);

// Add indexes
AnalyticsSchema.index({ userId: 1 });

export default model<AnalyticsDocument>("Analytics", AnalyticsSchema);

