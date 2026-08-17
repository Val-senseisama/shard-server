import { Schema, model, Types, Document } from "mongoose";

interface Participant {
  user: Types.ObjectId;
  role: "collaborator" | "accountability_partner";
}

/**
 * When the user can actually work on this, and for how long at a stretch.
 *
 * Shared by the intake interview (what they said) and the shard itself (what the
 * plan was built with) — see the note on `ShardDocument.rhythm` for why those are
 * deliberately two fields rather than one.
 */
export interface Rhythm {
  /** 0–6, Sunday = 0. Empty when the user's answer couldn't be parsed. */
  days: number[];
  sessionMinutes: number;
  timeOfDay?: "morning" | "afternoon" | "evening";
}

/**
 * What the user told us about the goal BEFORE the plan existed.
 *
 * Captured by the intake interview and kept so every later AI touch can read it
 * instead of re-deriving intent from the shard title. Every field is optional:
 * each question is skippable, and the whole interview can be skipped or fail.
 */
export interface QuestBrief {
  /** "What has to be true for this to count as finished?" */
  done?: string;
  /** "What changes for you when this is done?" — the line nudges should quote. */
  why?: string;
  /** As given at intake. `raw` is the user's own words, kept for the prompt. */
  rhythm?: Rhythm & { raw?: string };
  /** "What normally stops you finishing something like this?" */
  blockers?: string;
  /** Slots we offered and the user skipped — so we don't re-ask, and can measure. */
  skipped?: string[];
  capturedAt: Date;
}

const RhythmSchema = new Schema<Rhythm>(
  {
    days: { type: [Number], default: [] },
    sessionMinutes: { type: Number, required: true },
    timeOfDay: { type: String, enum: ["morning", "afternoon", "evening"] },
  },
  { _id: false }
);

export interface ShardDocument extends Document {
  title: string;
  image?: string;
  description?: string;
  owner: Types.ObjectId;
  participants: Participant[];
  chatId?: Types.ObjectId;
  timeline: {
    startDate: Date;
    endDate?: Date;
  };
  progress: {
    completion: number;
    xpEarned: number;
    level: number;
  };
  /**
   * Lifecycle state — see Helpers/ShardLifecycle.ts for the transitions.
   * `at_risk` and `stalled` are set by the nightly sweep from `lastActivityAt`;
   * `completed` and `expired` are terminal.
   */
  status: "active" | "paused" | "at_risk" | "stalled" | "completed" | "expired" | "abandoned";
  /** When the quest was finished, for the completion payout and stats. */
  completedAt?: Date;
  /** XP actually paid out on completion, so it can't be paid twice. */
  completionXPAwarded?: number;
  /** Habit quests: the period key (`YYYY-MM-DD` or `YYYY-Www`) last checked in. */
  lastCycleKey?: string;
  // Removed miniGoals array - using separate MiniGoal collection instead
  rewards: { type: "xp" | "badge"; value: number | string }[];
  questType: "standard" | "habit";
  cadence?: "daily" | "weekly" | "custom";
  habitStreak: number;
  lastActivityAt?: Date;
  lastNudgedAt?: Date;
  isPrivate: boolean;
  isAnonymous: boolean;
  version: number;
  /** What the user said at intake. Absent for shards created before intake shipped. */
  brief?: QuestBrief;
  /**
   * The pace this shard is actually planned against — what a reschedule defaults
   * to.
   *
   * Deliberately NOT `brief.rhythm`: the brief records what the user *said*
   * during intake, this records what the plan was *built with*. They start equal
   * and diverge the first time anyone changes days, and conflating them would
   * make a later reflow silently revert to a rhythm the user abandoned.
   */
  rhythm?: Rhythm;
}

const ShardSchema = new Schema<ShardDocument>(
  {
    title: { type: String, required: true },
    image: String,
    description: String,
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    participants: [
      {
        user: { type: Schema.Types.ObjectId, ref: "User", required: true },
        role: { type: String, enum: ["collaborator", "accountability_partner"], required: true },
      },
    ],
    chatId: { type: Schema.Types.ObjectId, ref: "Chat" },
    timeline: {
      startDate: { type: Date, required: true },
      endDate: Date,
    },
    progress: {
      completion: { type: Number, default: 0 },
      xpEarned: { type: Number, default: 0 },
      level: { type: Number, default: 1 },
    },
    status: {
      type: String,
      enum: ["active", "paused", "at_risk", "stalled", "completed", "expired", "abandoned"],
      default: "active",
    },
    completedAt: Date,
    completionXPAwarded: Number,
    lastCycleKey: { type: String },
    // MiniGoals are now in their own collection (MiniGoal model)
    rewards: [
      {
        type: {
          type: String,
          enum: ["xp", "badge"],
          required: true,
        },
        value: { type: Schema.Types.Mixed, required: true },
      },
    ],
    questType: {
      type: String,
      enum: ["standard", "habit"],
      default: "standard"
    },
    cadence: {
      type: String,
      enum: ["daily", "weekly", "custom"]
    },
    habitStreak: { type: Number, default: 0 },
    lastActivityAt: { type: Date },
    lastNudgedAt: { type: Date },
    isPrivate: { type: Boolean, default: false },
    isAnonymous: { type: Boolean, default: false },
    version: { type: Number, default: 1 },
    brief: {
      type: new Schema<QuestBrief>(
        {
          done: String,
          why: String,
          rhythm: {
            type: new Schema(
              {
                days: { type: [Number], default: [] },
                sessionMinutes: Number,
                timeOfDay: { type: String, enum: ["morning", "afternoon", "evening"] },
                raw: String,
              },
              { _id: false }
            ),
            required: false,
          },
          blockers: String,
          skipped: { type: [String], default: undefined },
          capturedAt: { type: Date, required: true },
        },
        { _id: false }
      ),
      required: false,
    },
    rhythm: { type: RhythmSchema, required: false },
  },
  { timestamps: true }
);

// Add indexes
ShardSchema.index({ owner: 1 });
ShardSchema.index({ status: 1 });
ShardSchema.index({ "timeline.endDate": 1 });
// The lifecycle sweep and campaigns both select open shards by staleness.
ShardSchema.index({ status: 1, lastActivityAt: 1 });
ShardSchema.index({ owner: 1, status: 1 });

export default model<ShardDocument>("Shard", ShardSchema);
