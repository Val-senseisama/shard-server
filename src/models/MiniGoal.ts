import { Schema, model, Types, Document } from "mongoose";

interface Task {
  title: string;
  dueDate?: Date;
  completed: boolean;
  xpReward?: number;
  // Soft delete
  deleted: boolean;
  deletedAt?: Date;
  deletedBy?: string;
  // Reschedule tracking
  rescheduled: boolean;
  originalDueDate?: Date;
  // Assignment
  assignedTo?: string; // userId string
}

export interface MiniGoalDocument extends Document {
  shardId: Types.ObjectId; // link back to parent shard
  title: string;
  description?: string;
  dueDate?: Date;
  progress: number;
  completed: boolean;
  tasks: Task[];
  assignedTo?: Types.ObjectId; // User assigned to this mini-goal (collaborator only)
  overdueNotifiedAt?: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const TaskSchema = new Schema<Task>(
  {
    title: { type: String, required: true },
    dueDate: Date,
    completed: { type: Boolean, default: false },
    xpReward: { type: Number, default: 20 },
    // Soft delete
    deleted: { type: Boolean, default: false },
    deletedAt: Date,
    deletedBy: String,
    // Reschedule tracking
    rescheduled: { type: Boolean, default: false },
    originalDueDate: Date,
    // Assignment
    assignedTo: { type: String, default: null },
  },
  { _id: false }
);

const MiniGoalSchema = new Schema<MiniGoalDocument>(
  {
    shardId: { type: Schema.Types.ObjectId, ref: "Shard", required: true },
    title: { type: String, required: true },
    description: String,
    dueDate: Date,
    progress: { type: Number, default: 0 },
    completed: { type: Boolean, default: false },
    tasks: [TaskSchema],
    assignedTo: { type: Schema.Types.ObjectId, ref: "User" }, // Collaborator assigned
    overdueNotifiedAt: Date,
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

// Add indexes
MiniGoalSchema.index({ shardId: 1 });
MiniGoalSchema.index({ completed: 1 });
MiniGoalSchema.index({ assignedTo: 1 });

export default model<MiniGoalDocument>("MiniGoal", MiniGoalSchema);
