import { Schema, model, Types, Document } from "mongoose";
import type { QuestBrief, Rhythm } from "./Shard.js";

/**
 * A quest that isn't real yet.
 *
 * `createShard` writes the Shard and its MiniGoals to the database *before* the
 * user has seen the plan, and every rigid thing about creation follows from
 * that: review can only delete (editing would mutate a live quest), removing a
 * mini-goal is an irreversible write, and "regenerate" abandons a shard that
 * still counts against FREE_ACTIVE_SHARD_CAP — so a free user who regenerates
 * twice is locked out of creating anything.
 *
 * A draft is the fix. Nothing is written to Shard/MiniGoal until
 * `commitQuestDraft`, so edits are cheap, abandonment is free, and the free-tier
 * cap is checked with the finished plan on screen rather than before the user
 * has seen anything.
 *
 * Expires on a TTL index — no cron, no orphan story.
 */

export interface DraftStep {
  /** Stable within the draft so the client can address a step it's editing. */
  id: string;
  text: string;
  estimatedDuration?: string;
  xpReward?: number;
  /** Hand-edited or hand-added. A refinement is forbidden from rewriting it. */
  edited?: boolean;
}

export interface DraftMiniQuest {
  id: string;
  title: string;
  description?: string;
  estimatedDuration?: string;
  xpReward?: number;
  steps: DraftStep[];
  /**
   * What to search for to find learning material — never a URL. Only present
   * when the user opted in via `brief.wantsSuggestions`. See AIHelper.
   */
  searchHint?: string;
  /** Hand-renamed. A refinement is forbidden from rewriting it. */
  edited?: boolean;
  /**
   * A due date the user set by hand.
   *
   * Absent by default — dates are normally derived at commit from the deadline
   * and the user's working days. When present this WINS: they picked it looking
   * at the plan, which beats anything the scheduler infers.
   */
  dueDate?: Date;
}

export interface DraftPlan {
  mainQuest: {
    title: string;
    description?: string;
    estimatedDuration?: string;
    xpReward?: number;
  };
  miniQuests: DraftMiniQuest[];
  /** The honest-arithmetic warning, e.g. "this lands 2 weeks past your deadline". */
  warning?: string | null;
}

export interface QuestDraftDocument extends Document {
  userId: Types.ObjectId;
  goal: string;
  deadline?: Date;
  image?: string;
  brief?: QuestBrief;
  rhythm?: Rhythm;
  questType?: "standard" | "habit";
  cadence?: "daily" | "weekly" | "custom";
  isPrivate?: boolean;
  isAnonymous?: boolean;
  participants?: { user: Types.ObjectId; role: string }[];
  plan?: DraftPlan;
  /** True once the AI call succeeded and a credit was spent for this draft. */
  generated: boolean;
  /** What the user has asked for, in order — shown back as removable chips. */
  refinements: { text: string; at: Date }[];
  refinementsUsed: number;
  /**
   * The plan as it was before the last refinement, for a single-level undo.
   *
   * One level, not a stack: a refinement that made things worse is obvious
   * immediately, and an unbounded history on a 7-day draft is storage for a
   * case nobody hits.
   */
  previousPlan?: DraftPlan;
  /** Set at commit so a double-tap can't create the quest twice. */
  committedShardId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const StepSchema = new Schema<DraftStep>(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    estimatedDuration: String,
    xpReward: Number,
    edited: Boolean,
  },
  { _id: false }
);

const MiniQuestSchema = new Schema<DraftMiniQuest>(
  {
    id: { type: String, required: true },
    title: { type: String, required: true },
    description: String,
    estimatedDuration: String,
    xpReward: Number,
    steps: { type: [StepSchema], default: [] },
    searchHint: String,
    edited: Boolean,
    dueDate: Date,
  },
  { _id: false }
);

const QuestDraftSchema = new Schema<QuestDraftDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    goal: { type: String, required: true },
    deadline: Date,
    image: String,
    brief: { type: Schema.Types.Mixed },
    rhythm: { type: Schema.Types.Mixed },
    questType: { type: String, enum: ["standard", "habit"] },
    cadence: { type: String, enum: ["daily", "weekly", "custom"] },
    isPrivate: Boolean,
    isAnonymous: Boolean,
    participants: [
      {
        _id: false,
        user: { type: Schema.Types.ObjectId, ref: "User" },
        role: String,
      },
    ],
    plan: {
      type: new Schema<DraftPlan>(
        {
          mainQuest: {
            title: { type: String, required: true },
            description: String,
            estimatedDuration: String,
            xpReward: Number,
          },
          miniQuests: { type: [MiniQuestSchema], default: [] },
          warning: String,
        },
        { _id: false }
      ),
      required: false,
    },
    generated: { type: Boolean, default: false },
    refinements: {
      type: [{ _id: false, text: String, at: Date }],
      default: [],
    },
    refinementsUsed: { type: Number, default: 0 },
    previousPlan: { type: Schema.Types.Mixed },
    committedShardId: { type: Schema.Types.ObjectId, ref: "Shard" },
  },
  { timestamps: true }
);

QuestDraftSchema.index({ userId: 1, createdAt: -1 });

/**
 * Seven days. Long enough to come back to a plan after a weekend, short enough
 * that abandoned drafts don't accumulate. Mongo does the sweeping.
 */
QuestDraftSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

export default model<QuestDraftDocument>("QuestDraft", QuestDraftSchema);
