/**
 * Shard lifecycle — the state machine a quest actually moves through.
 *
 * `status` used to be `active | paused | completed | expired`, but only the first
 * two were ever written by anything: nothing auto-completed a shard at 100%, and
 * nothing ever set `expired` despite the enum and the `timeline.endDate` index
 * existing. Abandoned quests stayed `active` forever and kept feeding the
 * inactivity nudge every seven days, indefinitely.
 *
 * Now:
 *
 *   active ──(no activity 5d)──▶ at_risk ──(no activity 14d)──▶ stalled
 *      │                            │                             │
 *      └──────── activity ──────────┴─────────────────────────────┘
 *      │
 *      ├──(weighted progress hits 100%)──▶ completed
 *      └──(endDate passed, unfinished)───▶ expired
 *
 * `at_risk` and `stalled` are what the coach and the campaigns select on, so a
 * nudge can be proportionate to how far gone the quest actually is.
 */

import Shard from "../models/Shard.js";
import MiniGoal from "../models/MiniGoal.js";
import { logError, mapWithConcurrency } from "./Helpers.js";
import { recomputeShardProgress } from "./Progress.js";

const DAY = 86_400_000;

/** Days of no activity before a shard is flagged at risk. */
export const AT_RISK_AFTER_DAYS = 5;

/** Days of no activity before a shard is considered stalled. */
export const STALLED_AFTER_DAYS = 14;

/** Statuses that still count as the user's live workload. */
export const OPEN_STATUSES = ["active", "at_risk", "stalled"] as const;

/** Statuses that count against the free-tier active-shard cap. */
export const COUNTED_STATUSES = ["active", "paused", "at_risk", "stalled"] as const;

export interface LifecycleTransitions {
  atRisk: number;
  stalled: number;
  expired: number;
  completed: number;
  revived: number;
}

/**
 * Decide a shard's status from its own state. Pure, so the thresholds are
 * testable without a database.
 */
export function nextStatus(
  shard: {
    status: string;
    progress?: { completion?: number };
    lastActivityAt?: Date | null;
    createdAt?: Date;
    timeline?: { endDate?: Date | null };
  },
  now: Date = new Date()
): string | null {
  // Terminal and user-chosen states are never moved automatically. Pausing is a
  // deliberate act; overriding it would be surprising.
  if (["completed", "expired", "abandoned", "paused"].includes(shard.status)) return null;

  if ((shard.progress?.completion ?? 0) >= 100) return "completed";

  const endDate = shard.timeline?.endDate ? new Date(shard.timeline.endDate) : null;
  if (endDate && endDate.getTime() < now.getTime()) return "expired";

  const last = shard.lastActivityAt
    ? new Date(shard.lastActivityAt).getTime()
    : shard.createdAt
      ? new Date(shard.createdAt).getTime()
      : now.getTime();
  const idleDays = Math.floor((now.getTime() - last) / DAY);

  if (idleDays >= STALLED_AFTER_DAYS) return "stalled";
  if (idleDays >= AT_RISK_AFTER_DAYS) return "at_risk";
  return "active";
}

/**
 * Walk every open shard and apply `nextStatus`.
 *
 * Progress is recomputed first (without touching `lastActivityAt`, which would
 * defeat the idle detection this then performs) so an auto-complete can't be
 * missed because the stored percentage was stale.
 */
export async function sweepShardLifecycle(): Promise<LifecycleTransitions> {
  const transitions: LifecycleTransitions = {
    atRisk: 0,
    stalled: 0,
    expired: 0,
    completed: 0,
    revived: 0,
  };

  try {
    const shards = await Shard.find({ status: { $in: OPEN_STATUSES } })
      .select("status progress lastActivityAt createdAt timeline owner title")
      .lean();

    const now = new Date();

    // Each shard costs a couple of round-trips; a small window keeps the sweep
    // bounded as the collection grows.
    const moves = await mapWithConcurrency(shards as any[], 10, async (shard) => {
      const id = shard._id.toString();

      // Refresh the stored percentage from the mini-goals, but do NOT mark
      // activity — this is a background sweep, not user progress.
      const { completion } = await recomputeShardProgress(id, { touchActivity: false });

      const next = nextStatus({ ...shard, progress: { completion } }, now);
      if (!next || next === shard.status) return null;

      await Shard.findByIdAndUpdate(id, { $set: { status: next } });
      return next;
    });

    for (const next of moves) {
      if (next === "completed") transitions.completed++;
      else if (next === "expired") transitions.expired++;
      else if (next === "stalled") transitions.stalled++;
      else if (next === "at_risk") transitions.atRisk++;
      else if (next === "active") transitions.revived++;
    }
  } catch (error) {
    logError("sweepShardLifecycle", error);
  }

  return transitions;
}

/**
 * Flag tasks whose due date has passed, without moving the date.
 *
 * The job this replaces (`overdue-task-reschedule`) rewrote every overdue task's
 * `dueDate` to today, every night. That made deadlines unfalsifiable — nothing
 * was ever late — and destroyed the signal the whole reminder system depends on.
 * Marking instead of moving means the user gets an explicit
 * "reschedule or drop?" decision, which is a reason to open the app.
 *
 * Returns the number of tasks newly marked.
 */
export async function markOverdueTasks(): Promise<number> {
  let marked = 0;

  try {
    const now = new Date();

    // Only look at shards that are still open — no point flagging tasks on a
    // completed or expired quest.
    const openShardIds = await Shard.find({ status: { $in: OPEN_STATUSES } })
      .select("_id")
      .lean();
    if (openShardIds.length === 0) return 0;

    const miniGoals = await MiniGoal.find({
      shardId: { $in: openShardIds.map((s: any) => s._id) },
      completed: false,
      "tasks.dueDate": { $lt: now },
    });

    for (const miniGoal of miniGoals) {
      let changed = false;

      for (const task of miniGoal.tasks as any[]) {
        if (task.completed || task.deleted || !task.dueDate) continue;
        if (task.overdue) continue; // already flagged
        if (new Date(task.dueDate).getTime() >= now.getTime()) continue;

        task.overdue = true;
        task.overdueSince = task.overdueSince ?? new Date(task.dueDate);
        changed = true;
        marked++;
      }

      if (changed) await miniGoal.save();
    }
  } catch (error) {
    logError("markOverdueTasks", error);
  }

  return marked;
}

/**
 * Move a task's due date and clear its overdue flag — the explicit
 * "reschedule" half of the decision the sweep now asks the user to make.
 */
export function rescheduleTaskFields(newDueDate: Date, originalDueDate?: Date) {
  return {
    dueDate: newDueDate,
    rescheduled: true,
    originalDueDate: originalDueDate ?? newDueDate,
    overdue: false,
    overdueSince: undefined,
  };
}
