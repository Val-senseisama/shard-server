import { Schema, model, Types, Document } from "mongoose";

/**
 * A link to a piece of learning material — a YouTube video, article, book,
 * or user-supplied note. Stored on both mini-goals (as `resources[]`) and
 * individual tasks (as `resource`).
 *
 * Additive and optional everywhere: every existing shard works with this absent.
 */
export interface ResourceRef {
  kind: "youtube_video" | "youtube_playlist" | "article" | "book" | "note";
  /** "user" = supplied by the learner; "system" = we found/inserted it. */
  source: "user" | "system";
  url?: string;
  title: string;
  /** Required for YouTube — attribution per compliance. */
  author?: string;
  durationSeconds?: number;
  thumbnail?: string;
  fetchedAt?: Date;
}

interface Task {
  title: string;
  dueDate?: Date;
  completed: boolean;
  xpReward?: number;
  // Undo support: when it was completed, and how much XP it ACTUALLY paid out
  // (the comeback bonus multiplies the base reward, so we can't re-derive it).
  completedAt?: Date;
  xpAwarded?: number;
  // Soft delete
  deleted: boolean;
  deletedAt?: Date;
  deletedBy?: string;
  // Reschedule tracking
  rescheduled: boolean;
  originalDueDate?: Date;
  /**
   * Past its due date and still open. Set by the nightly lifecycle sweep, which
   * used to silently rewrite `dueDate` to today instead — so nothing was ever
   * late and deadlines meant nothing. Cleared when the user reschedules.
   */
  overdue: boolean;
  overdueSince?: Date;
  // Assignment
  assignedTo?: string; // userId string
  /** The lecture / reading this task IS. Populated for course-import tasks. */
  resource?: ResourceRef;
  /** Duration of the content, in seconds. Drives pacer packing. */
  estimatedSeconds?: number;
  /** True when this task was synthesized by the enrichment pass — a practice
   * checkpoint the original course doesn't contain. */
  synthesized?: boolean;
  /**
   * Groups a catch-up batch so `undoCatchUp` can address the whole set.
   * Only set by `catchUpToTask`; absent on tasks completed individually.
   */
  catchUpBatchId?: string;
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
  /**
   * Learning material for this section. Populated from the imported curriculum
   * or added later by the user. Default [] so callers never have to null-check.
   */
  resources: ResourceRef[];
  /**
   * Position of this mini-goal in the original curriculum's section list.
   *
   * PROVENANCE, not sequence — "which section of the course did this come from",
   * used for drift detection and the metadata refresh. Absent on non-course
   * shards. For ordering, read `order`: the two start equal on course shards and
   * diverge the moment anything reorders a plan, exactly like `Shard.rhythm` vs
   * `brief.rhythm`.
   */
  sourceSectionIndex?: number;
  /**
   * Position in the plan. The order the user approved, on every shard.
   *
   * Mini-goals are written with `Promise.all`, so insertion order is whatever
   * the network returned first, and readers used to sort by `createdAt` (or not
   * at all). A four-phase plan could therefore render "1. Phase Three,
   * 2. Phase One" — and "everything before this task", which is what a catch-up
   * means, had no stable definition to appeal to.
   *
   * Optional because shards created before this field existed don't have it;
   * every reader sorts `{ order: 1, createdAt: 1 }` so those keep their old
   * behaviour until the backfill runs.
   */
  order?: number;
}

const ResourceRefSchema = new Schema<ResourceRef>(
  {
    kind: {
      type: String,
      enum: ["youtube_video", "youtube_playlist", "article", "book", "note"],
      required: true,
    },
    source: { type: String, enum: ["user", "system"], required: true },
    url: String,
    title: { type: String, required: true },
    author: String,
    durationSeconds: Number,
    thumbnail: String,
    fetchedAt: Date,
  },
  { _id: false }
);

const TaskSchema = new Schema<Task>(
  {
    title: { type: String, required: true },
    dueDate: Date,
    completed: { type: Boolean, default: false },
    xpReward: { type: Number, default: 20 },
    completedAt: Date,
    xpAwarded: Number,
    // Soft delete
    deleted: { type: Boolean, default: false },
    deletedAt: Date,
    deletedBy: String,
    // Reschedule tracking
    rescheduled: { type: Boolean, default: false },
    originalDueDate: Date,
    overdue: { type: Boolean, default: false },
    overdueSince: Date,
    // Assignment
    assignedTo: { type: String, default: null },
    // Course-import fields
    resource: { type: ResourceRefSchema, required: false },
    estimatedSeconds: Number,
    synthesized: Boolean,
    catchUpBatchId: String,
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
    resources: { type: [ResourceRefSchema], default: [] },
    sourceSectionIndex: Number,
    order: Number,
  },
  { timestamps: true }
);

// Add indexes
MiniGoalSchema.index({ shardId: 1 });
// Every read that shows a plan or resolves "before this task" sorts by this
// pair, so it should not be a collection scan plus an in-memory sort.
MiniGoalSchema.index({ shardId: 1, order: 1, createdAt: 1 });
MiniGoalSchema.index({ completed: 1 });
MiniGoalSchema.index({ assignedTo: 1 });

export default model<MiniGoalDocument>("MiniGoal", MiniGoalSchema);
