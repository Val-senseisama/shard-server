/**
 * Progress and XP weighting — the single source of truth for "how far along is
 * this?" and "what is this worth?".
 *
 * Both questions used to have two answers. `completeTask` wrote the unweighted
 * mean of mini-goal progress; `completeMiniGoal` wrote the completed-mini-goal
 * ratio. They overwrote each other, so a shard's progress visibly jumped up and
 * down depending on which button you last pressed. And every task paid a flat
 * 20 XP regardless of size, even though the AI already sizes `xpReward` per
 * task — so a 5-minute task and a 3-hour task were worth the same.
 */

import MiniGoal from "../models/MiniGoal.js";
import Shard from "../models/Shard.js";
import { dateKeyInZone } from "./Timezone.js";

/** Fallback when a task carries no explicit reward. */
export const DEFAULT_TASK_XP = 20;

/** Base XP for finishing a whole mini-goal, on top of its tasks. */
export const MINI_GOAL_COMPLETION_XP = 100;

/** XP per day early a mini-goal is finished. */
export const EARLY_BONUS_XP_PER_DAY = 5;

/** Cap on the early-completion bonus, so a year-out due date isn't a jackpot. */
export const EARLY_BONUS_MAX_DAYS = 14;

interface TaskLike {
  completed?: boolean;
  deleted?: boolean;
  xpReward?: number;
  dueDate?: Date;
}

/**
 * What one task is worth. Doubles as its progress weight: a task worth more XP
 * represents more of the work, which is exactly what we want progress to mean.
 */
export function taskXPValue(task: TaskLike | undefined): number {
  const raw = task?.xpReward;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_TASK_XP;
  // Clamp so a bad AI response (or a hand-edited doc) can't mint XP.
  return Math.min(500, Math.max(5, Math.round(raw)));
}

/** Tasks that count toward progress — soft-deleted ones don't. */
const liveTasks = <T extends TaskLike>(tasks: T[] = []): T[] => tasks.filter((t) => !t?.deleted);

/**
 * Weighted completion percentage for one mini-goal, 0–100.
 * Weight is each task's XP value, so finishing the big task moves the bar more
 * than ticking off a trivial one.
 */
export function miniGoalProgress(tasks: TaskLike[] = []): number {
  const live = liveTasks(tasks);
  if (live.length === 0) return 0;

  const totalWeight = live.reduce((sum, t) => sum + taskXPValue(t), 0);
  if (totalWeight === 0) return 0;

  const doneWeight = live
    .filter((t) => t.completed)
    .reduce((sum, t) => sum + taskXPValue(t), 0);

  return Math.round((doneWeight / totalWeight) * 100);
}

/** True once every live task is done (and there is at least one). */
export function allTasksComplete(tasks: TaskLike[] = []): boolean {
  const live = liveTasks(tasks);
  return live.length > 0 && live.every((t) => t.completed);
}

export interface ShardProgressResult {
  /** 0–100, weighted by each mini-goal's size. */
  completion: number;
  miniGoalCount: number;
  completedMiniGoals: number;
}

/**
 * Recompute and persist a shard's progress from its mini-goals — the ONE
 * formula. Weighted by each mini-goal's total task weight so a mini-goal with
 * twenty tasks isn't worth the same as one with a single task.
 *
 * Also refreshes `lastActivityAt`, which the stall detection and inactivity
 * nudges read. `completeMiniGoal` never used to touch it, so the coach could
 * nag a shard the user had just made real progress on.
 */
export async function recomputeShardProgress(
  shardId: string,
  options: { touchActivity?: boolean } = {}
): Promise<ShardProgressResult> {
  const { touchActivity = true } = options;

  const miniGoals = await MiniGoal.find({ shardId }).select("tasks completed").lean();

  let totalWeight = 0;
  let doneWeight = 0;
  let completedMiniGoals = 0;

  for (const mg of miniGoals as any[]) {
    const live = liveTasks(mg.tasks as TaskLike[]);
    if (mg.completed) completedMiniGoals++;

    if (live.length === 0) {
      // A mini-goal with no tasks is all-or-nothing on its own flag; give it a
      // nominal weight so it still contributes to the bar.
      totalWeight += DEFAULT_TASK_XP;
      if (mg.completed) doneWeight += DEFAULT_TASK_XP;
      continue;
    }

    for (const t of live) {
      const w = taskXPValue(t);
      totalWeight += w;
      if (t.completed || mg.completed) doneWeight += w;
    }
  }

  const completion = totalWeight === 0 ? 0 : Math.round((doneWeight / totalWeight) * 100);

  const update: Record<string, any> = { "progress.completion": completion };
  if (touchActivity) update.lastActivityAt = new Date();
  await Shard.findByIdAndUpdate(shardId, { $set: update });

  return { completion, miniGoalCount: miniGoals.length, completedMiniGoals };
}

/**
 * Early-completion bonus for a mini-goal, capped.
 * (Replaces `StreakHelper.calculateEarlyCompletionBonus`, which was uncapped
 * and used server-local midnight.)
 */
export function earlyCompletionBonus(
  dueDate: Date | undefined,
  completedAt: Date,
  timezone?: string
): { isEarly: boolean; daysEarly: number; bonusXP: number } {
  if (!dueDate) return { isEarly: false, daysEarly: 0, bonusXP: 0 };

  // Compare in the user's own day space, not the server's.
  const dueKey = dateKeyInZone(new Date(dueDate), timezone);
  const doneKey = dateKeyInZone(completedAt, timezone);
  const daysEarly = Math.round(
    (Date.parse(`${dueKey}T00:00:00Z`) - Date.parse(`${doneKey}T00:00:00Z`)) / 86_400_000
  );

  if (!Number.isFinite(daysEarly) || daysEarly <= 0) {
    return { isEarly: false, daysEarly: 0, bonusXP: 0 };
  }

  const credited = Math.min(daysEarly, EARLY_BONUS_MAX_DAYS);
  return { isEarly: true, daysEarly, bonusXP: credited * EARLY_BONUS_XP_PER_DAY };
}

// ─── Habit cadence ────────────────────────────────────────────────────────────

/**
 * The period a habit quest is currently in, as a stable key.
 *
 * `daily`  → `2026-07-27`
 * `weekly` → `2026-W30` (ISO week)
 *
 * Stored on the shard as `lastCycleKey`, which is what makes a check-in
 * idempotent per period. `completeHabitCycle` previously had no such gate, so it
 * could be called repeatedly and each call incremented the streak and paid a
 * bonus proportional to it.
 */
export function cadencePeriodKey(
  cadence: string | undefined,
  timezone?: string,
  at: Date = new Date()
): string {
  const dayKey = dateKeyInZone(at, timezone);
  if (cadence === "weekly") return isoWeekKey(dayKey);
  // `daily` and `custom` both gate per day — a custom cadence still shouldn't
  // allow two check-ins in one day.
  return dayKey;
}

/** The key for the period immediately before the current one. */
export function previousCadencePeriodKey(
  cadence: string | undefined,
  timezone?: string,
  at: Date = new Date()
): string {
  const step = cadence === "weekly" ? 7 : 1;
  return cadencePeriodKey(cadence, timezone, new Date(at.getTime() - step * 86_400_000));
}

/** `YYYY-Www` (ISO 8601 week) for a `YYYY-MM-DD` key. */
export function isoWeekKey(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dayKey;

  // ISO weeks run Monday–Sunday and belong to the year containing their Thursday.
  const target = new Date(date);
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon = 0
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // the Thursday
  const isoYear = target.getUTCFullYear();

  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);

  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

// ─── Completion payout ────────────────────────────────────────────────────────

/**
 * XP for finishing a whole shard.
 *
 * Finishing a quest used to pay **nothing**: the `rewards` array was written at
 * creation (`[{ type: 'xp', value: 200 }]`) and never read by anything, and
 * completion was just a manual status change. The single biggest moment in the
 * product awarded zero XP.
 *
 * On-time completion is worth more than a late one — that's the whole point of
 * having set a date.
 *
 * The payout scales with how much of the quest was actually done. Without that,
 * `completeShard` is an XP printer: create a quest, finish it at 0%, collect the
 * full reward, repeat. Proportional payout also makes "give up and close it"
 * an honest option rather than a free jackpot.
 */
export function shardCompletionXP(
  rewards: { type: string; value: any }[] | undefined,
  opts: { onTime: boolean; completion: number }
): { base: number; earned: number; onTimeBonus: number; total: number } {
  const declared = (rewards ?? []).find((r) => r.type === "xp");
  const parsed = Number(declared?.value);
  const base = Number.isFinite(parsed) && parsed > 0 ? Math.min(2000, parsed) : 200;

  const ratio = Math.min(1, Math.max(0, (opts.completion ?? 0) / 100));
  const earned = Math.round(base * ratio);

  // The on-time bonus rides on what was earned, not on the headline figure —
  // finishing 10% of a quest "on time" is not a 25%-of-everything achievement.
  const onTimeBonus = opts.onTime ? Math.round(earned * 0.25) : 0;
  return { base, earned, onTimeBonus, total: earned + onTimeBonus };
}
