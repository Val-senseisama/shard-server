import { Schema, model, Types } from "mongoose";
import { type Curriculum } from "../Helpers/Curriculum.js";

/**
 * Transient store for a curriculum that has been imported but not yet committed
 * as a shard.
 *
 * The review-then-commit flow (§5.5.1) requires a place to hold a curriculum
 * between `importCurriculum` (which may have cost an API round-trip and a
 * vision call) and `createShardFromCurriculum`. Three alternatives were
 * considered:
 *
 *   - **Client-only state** — loses the import on an app kill, which is exactly
 *     the expensive step you can't afford to redo.
 *   - **Redis** — this deployment's Redis is `volatile-lru`; a 20KB draft can
 *     be evicted under memory pressure. Cache semantics for something we promised
 *     to keep.
 *   - **TTL index** — no cron, no cleanup code, same mechanism already expiring
 *     notifications at 90 days. Correct semantic: "keep for a week, then discard".
 */
export interface CurriculumDraftDocument {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  curriculum: Curriculum;
  /** What the user wants out of the course — used by the enrichment pass. */
  goal?: string;
  createdAt: Date;
}

const CurriculumDraftSchema = new Schema<CurriculumDraftDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    curriculum: { type: Schema.Types.Mixed, required: true },
    goal: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// 7-day TTL — MongoDB removes the document automatically.
CurriculumDraftSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });
// Resume-on-launch: find the most recent unconsumed draft for this user.
CurriculumDraftSchema.index({ userId: 1, createdAt: -1 });

export default model<CurriculumDraftDocument>("CurriculumDraft", CurriculumDraftSchema);
