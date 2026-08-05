/**
 * The streak engine — the ONLY thing that may write streak state.
 *
 * It replaces three implementations that disagreed with each other:
 *   - an inline block in `completeTask` (freeze tokens + comeback bonus)
 *   - `StreakHelper.updateStreak` (no freeze tokens, called by completeMiniGoal)
 *   - `XP.updateStreak(userId, type)` (the per-type Streak collection)
 * so that completing a task and completing a mini-goal on the same day no longer
 * apply different rules to the same `User.currentStreak`.
 *
 * Two invariants everything else depends on:
 *
 * 1. **A day is a day in the USER's timezone.** Never `setHours(0,0,0,0)` (that
 *    is midnight on Railway, i.e. UTC). Day identity is a `YYYY-MM-DD` key from
 *    `dateKeyInZone`, so a 9pm completion in UTC-8 counts for the day the user
 *    thinks it is.
 *
 * 2. **Streaks decay.** Previously nothing ever set `currentStreak` back to 0:
 *    a streak of 12 stayed 12 forever, the UI lied, and the streak-break
 *    re-engagement query (`currentStreak: 0`) could never match a single row.
 *    `rollOverStreaks` is what makes a break a real, observable event.
 */

import { User } from "../models/User.js";
import { dateKeyInZone } from "./Timezone.js";
import { logError } from "./Helpers.js";

/** Days of grace a freeze token buys. */
export const FREEZE_GRACE_DAYS = 1;

/** XP multiplier while a comeback bonus is live. */
export const COMEBACK_MULTIPLIER = 1.2;

/** Idle days after which returning earns the comeback bonus. */
export const COMEBACK_AFTER_IDLE_DAYS = 7;

/** How long the comeback bonus lasts once granted. */
export const COMEBACK_DURATION_DAYS = 3;

export type StreakState = "none" | "active" | "at_risk" | "frozen" | "broken";

export interface StreakSnapshot {
  current: number;
  longest: number;
  state: StreakState;
  /** Day key of the last qualifying activity, in the user's zone. */
  lastDayKey?: string;
  freezesAvailable: number;
  /** True when the streak has not yet been secured for the user's today. */
  atRiskToday: boolean;
}

/** `YYYY-MM-DD` for the user's current local day. */
export const todayKeyFor = (timezone?: string) => dateKeyInZone(new Date(), timezone);

/** `YYYY-MM-DD` for `offsetDays` before the user's current local day. */
export function dayKeyOffset(timezone: string | undefined, offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return dateKeyInZone(d, timezone);
}

/**
 * Whole days between two `YYYY-MM-DD` keys. Both are parsed as UTC midnight,
 * which is safe because we only ever subtract two keys built the same way — the
 * zone is already baked into the key.
 */
export function daysBetweenKeys(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

type StreakUserFields = {
  _id: any;
  timezone?: string;
  currentStreak?: number;
  longestStreak?: number;
  previousStreak?: number;
  lastStreakDayKey?: string;
  /** Last day a spent freeze covers. Never treated as earned activity. */
  freezeCoveredThrough?: string;
  streakFreezeTokens?: number;
  comebackBonusUntil?: Date;
};

/** The projection every streak read needs. Keep call sites in sync via this. */
export const STREAK_FIELDS =
  "timezone currentStreak longestStreak previousStreak lastStreakDayKey freezeCoveredThrough lastCompletionDate streakFreezeTokens comebackBonusUntil";

export interface RecordActivityResult {
  /** False when the day was already counted — the caller should not re-reward. */
  counted: boolean;
  current: number;
  longest: number;
  /** Set when this activity extended the streak to a new personal best. */
  isPersonalBest: boolean;
  /** Set when a freeze token was spent to bridge a missed day. */
  freezeUsed: boolean;
  /** Milestone reached by this activity (7, 14, 30, …), else null. */
  milestone: number | null;
}

/** Milestones worth telling the user about. */
const MILESTONES = [3, 7, 14, 30, 60, 100, 180, 365];

/**
 * Record a qualifying activity (task, mini-goal, habit check-in, side quest).
 *
 * Idempotent per local day: the second completion of the day returns
 * `counted: false` and changes nothing, which is what makes it safe to call
 * from every completion path without inflating streaks.
 */
export async function recordActivity(userId: string): Promise<RecordActivityResult> {
  const noop: RecordActivityResult = {
    counted: false,
    current: 0,
    longest: 0,
    isPersonalBest: false,
    freezeUsed: false,
    milestone: null,
  };

  const user = (await User.findById(userId)
    .select(STREAK_FIELDS)
    .lean()) as StreakUserFields | null;
  if (!user) return noop;

  const tz = user.timezone;
  const today = todayKeyFor(tz);
  // Counts freeze cover: a gap the rollover already bridged must not be charged
  // a second time when the user comes back.
  const lastKey = effectiveLastDay(user);

  // Already counted today.
  if (user.lastStreakDayKey === today) {
    return {
      ...noop,
      current: user.currentStreak ?? 0,
      longest: user.longestStreak ?? 0,
    };
  }

  const gap = lastKey ? daysBetweenKeys(lastKey, today) : null;
  let current = user.currentStreak ?? 0;
  let freezesAvailable = user.streakFreezeTokens ?? 0;
  let freezeUsed = false;
  const set: Record<string, any> = {};
  const unset: Record<string, string> = {};

  if (gap === null) {
    // First ever activity.
    current = 1;
  } else if (gap === 1) {
    current += 1;
  } else if (gap > 1) {
    // A gap. `rollOverStreaks` normally handles breaks at midnight, but a user
    // can also return before the rollover ran (or from a zone it hasn't reached
    // yet), so the same rules are applied here.
    const missedDays = gap - 1;
    if (missedDays <= FREEZE_GRACE_DAYS && freezesAvailable > 0) {
      freezesAvailable -= 1;
      freezeUsed = true;
      current += 1;
    } else {
      current = 1;
    }

    // Coming back from a long absence earns a temporary XP bonus. Granting it
    // here (rather than on the break) means it's live for the session where the
    // user actually returned.
    if (gap - 1 >= COMEBACK_AFTER_IDLE_DAYS) {
      set.comebackBonusUntil = new Date(Date.now() + COMEBACK_DURATION_DAYS * 86_400_000);
    }
  } else {
    // gap < 0: clock or timezone moved backwards. Don't punish, don't reward.
    return {
      ...noop,
      current: user.currentStreak ?? 0,
      longest: user.longestStreak ?? 0,
    };
  }

  const longest = Math.max(user.longestStreak ?? 0, current);
  const isPersonalBest = current > (user.longestStreak ?? 0) && current > 1;

  set.currentStreak = current;
  set.longestStreak = longest;
  set.lastStreakDayKey = today;
  set.lastCompletionDate = new Date();
  set.streakFreezeTokens = freezesAvailable;
  // Legacy mirror — some older reads still use `streaks`.
  set.streaks = current;
  // A live streak is not a broken one, and the freeze cover has served its
  // purpose — clearing it re-arms the grace window for the NEXT absence.
  unset.streakBrokenAt = "";
  unset.freezeCoveredThrough = "";

  await User.findByIdAndUpdate(userId, {
    $set: set,
    ...(Object.keys(unset).length ? { $unset: unset } : {}),
  });

  return {
    counted: true,
    current,
    longest,
    isPersonalBest,
    freezeUsed,
    milestone: MILESTONES.includes(current) ? current : null,
  };
}

/** Read-only view for UI and campaign decisions. */
export async function getStreak(userId: string): Promise<StreakSnapshot | null> {
  const user = (await User.findById(userId)
    .select(STREAK_FIELDS)
    .lean()) as StreakUserFields | null;
  if (!user) return null;
  return snapshotOf(user);
}

export function snapshotOf(user: StreakUserFields & { streakBrokenAt?: Date }): StreakSnapshot {
  const tz = user.timezone;
  const today = todayKeyFor(tz);
  const current = user.currentStreak ?? 0;
  const lastDayKey = user.lastStreakDayKey;
  const freezesAvailable = user.streakFreezeTokens ?? 0;
  const covered = effectiveLastDay(user);
  const yesterday = dayKeyOffsetFromKey(today, -1);

  let state: StreakState;
  if (current === 0) {
    state = user.previousStreak && user.previousStreak > 0 ? "broken" : "none";
  } else if (lastDayKey === today) {
    state = "active";
  } else if (user.freezeCoveredThrough && user.freezeCoveredThrough >= yesterday) {
    // A spent freeze is holding this streak up — say so, rather than implying
    // the user earned the day.
    state = "frozen";
  } else if (covered && covered >= yesterday) {
    // Yesterday secured, today not yet — the window where a nudge still works.
    state = "at_risk";
  } else {
    state = freezesAvailable > 0 ? "frozen" : "at_risk";
  }

  return {
    current,
    longest: user.longestStreak ?? 0,
    state,
    lastDayKey,
    freezesAvailable,
    atRiskToday: lastDayKey !== today,
  };
}

/** True while a comeback bonus is live. */
export function hasComebackBonus(user: { comebackBonusUntil?: Date | null }): boolean {
  return !!user.comebackBonusUntil && new Date(user.comebackBonusUntil) > new Date();
}

/** The XP multiplier to apply for this user right now. */
export function xpMultiplierFor(user: { comebackBonusUntil?: Date | null }): number {
  return hasComebackBonus(user) ? COMEBACK_MULTIPLIER : 1;
}

export interface BreakOutcome {
  userId: string;
  /** The streak length that was lost — what the winback message quotes. */
  lostStreak: number;
  /** True when a freeze absorbed the miss and the streak survived. */
  frozen: boolean;
  freezesRemaining: number;
  /** When frozen: the day key the spent freeze covers. */
  coversDayKey?: string;
}

/**
 * The last day this streak is credited with, counting freeze cover.
 *
 * Kept separate from `lastStreakDayKey` (which only ever records a day the user
 * actually earned) so that spending a freeze doesn't forge activity.
 */
function effectiveLastDay(user: StreakUserFields): string | undefined {
  const earned = user.lastStreakDayKey;
  const covered = user.freezeCoveredThrough;
  if (!earned) return covered;
  if (!covered) return earned;
  // Day keys are `YYYY-MM-DD`, so lexicographic order is chronological order.
  return covered > earned ? covered : earned;
}

/**
 * Decide what happens to one user's streak given the day it now is for them.
 * Pure, so the rollover window is unit-testable without a database.
 *
 * A freeze covers **one isolated missed day**. Freezes deliberately do not
 * stack across consecutive days: an earlier version advanced the day marker on
 * every freeze, which re-armed the same grace window every night and burned a
 * user's entire freeze stock while they were away — leaving them with none for
 * the day they actually came back, which is precisely backwards.
 *
 * Returns null when nothing should change (no streak, or already covered).
 */
export function evaluateRollover(
  user: StreakUserFields,
  todayKey: string
): BreakOutcome | null {
  const current = user.currentStreak ?? 0;
  if (current <= 0) return null;

  if (!user.lastStreakDayKey) return null;

  const lastKey = effectiveLastDay(user)!;
  const yesterday = dayKeyOffsetFromKey(todayKey, -1);

  // Yesterday (or today) is already accounted for.
  if (lastKey >= yesterday) return null;

  const freezes = user.streakFreezeTokens ?? 0;
  const covered = user.freezeCoveredThrough;
  const dayBeforeYesterday = dayKeyOffsetFromKey(yesterday, -1);
  // Was the immediately preceding day itself only surviving on a freeze?
  const wouldStack = !!covered && covered >= dayBeforeYesterday;

  const gap = daysBetweenKeys(lastKey, todayKey);
  const missedDays = gap - 1;

  if (freezes > 0 && !wouldStack && missedDays <= FREEZE_GRACE_DAYS) {
    return {
      userId: user._id.toString(),
      lostStreak: current,
      frozen: true,
      freezesRemaining: freezes - 1,
      coversDayKey: yesterday,
    };
  }

  return {
    userId: user._id.toString(),
    lostStreak: current,
    frozen: false,
    freezesRemaining: freezes,
  };
}

/**
 * Apply a break/freeze decision. Writes `previousStreak` ONLY here — the old
 * code wrote it on every completion (including the second of the same day), so
 * it never actually held "the streak before the break" and the winback message
 * had no number to quote.
 */
export async function applyRollover(outcome: BreakOutcome, todayKey: string): Promise<void> {
  if (outcome.frozen) {
    // Consume the token and record which day it covers. `lastStreakDayKey` is
    // deliberately NOT advanced — it records days the user actually earned, and
    // moving it would both forge activity and re-arm the grace window nightly.
    await User.findByIdAndUpdate(outcome.userId, {
      $set: {
        streakFreezeTokens: outcome.freezesRemaining,
        freezeCoveredThrough: outcome.coversDayKey ?? dayKeyOffsetFromKey(todayKey, -1),
        lastFreezeUsedAt: new Date(),
      },
    });
    return;
  }

  await User.findByIdAndUpdate(outcome.userId, {
    $set: {
      previousStreak: outcome.lostStreak,
      currentStreak: 0,
      streaks: 0,
      streakBrokenAt: new Date(),
    },
    // A dead streak carries no freeze cover forward.
    $unset: { freezeCoveredThrough: "" },
  });
}

/** `YYYY-MM-DD` shifted by whole days, staying in key space. */
export function dayKeyOffsetFromKey(key: string, offsetDays: number): string {
  const base = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(base)) return key;
  return new Date(base + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Nightly rollover for every user whose local day just turned over.
 *
 * Called hourly; `timezones` is the set of zones currently at the target local
 * hour, so each user is evaluated once per local day.
 *
 * Returns the breaks that actually happened so the caller can fire the
 * re-engagement campaign — this is the event the whole winback ladder hangs on.
 */
export async function rollOverStreaks(timezones: string[]): Promise<BreakOutcome[]> {
  if (timezones.length === 0) return [];

  const outcomes: BreakOutcome[] = [];

  try {
    const users = (await User.find({
      timezone: { $in: timezones },
      currentStreak: { $gt: 0 },
    })
      .select(STREAK_FIELDS)
      .lean()) as StreakUserFields[];

    for (const user of users) {
      const todayKey = todayKeyFor(user.timezone);
      const outcome = evaluateRollover(user, todayKey);
      if (!outcome) continue;
      await applyRollover(outcome, todayKey);
      outcomes.push(outcome);
    }
  } catch (error) {
    logError("rollOverStreaks", error);
  }

  return outcomes;
}

/**
 * Grant freeze tokens, capped. Used by the weekly replenish and by the Pro
 * streak-repair purchase. Previously freezes were granted once at signup and
 * never again, so the mechanic was invisible and un-sellable.
 */
export const MAX_FREEZE_TOKENS = 3;

export async function grantFreezeTokens(userId: string, count: number): Promise<number> {
  const user = await User.findById(userId).select("streakFreezeTokens").lean();
  if (!user) return 0;
  const next = Math.min(MAX_FREEZE_TOKENS, ((user as any).streakFreezeTokens ?? 0) + count);
  await User.findByIdAndUpdate(userId, { $set: { streakFreezeTokens: next } });
  return next;
}

/**
 * Restore a broken streak. The retention save AND a natural paid moment:
 * a user who just lost 23 days is the most motivated buyer in the product.
 *
 * Only valid within `REPAIR_WINDOW_DAYS` of the break, and only from
 * `previousStreak` — which is why that field must be written exactly once, at
 * the break.
 */
export const REPAIR_WINDOW_DAYS = 2;

export async function repairStreak(
  userId: string
): Promise<{ success: boolean; message: string; restored?: number }> {
  const user = (await User.findById(userId)
    .select(`${STREAK_FIELDS} streakBrokenAt`)
    .lean()) as (StreakUserFields & { streakBrokenAt?: Date }) | null;
  if (!user) return { success: false, message: "User not found." };

  const lost = user.previousStreak ?? 0;
  if ((user.currentStreak ?? 0) > 0 || lost <= 0) {
    return { success: false, message: "You don't have a broken streak to repair." };
  }

  if (!user.streakBrokenAt) {
    return { success: false, message: "This streak is too old to repair." };
  }

  const daysSinceBreak =
    (Date.now() - new Date(user.streakBrokenAt).getTime()) / 86_400_000;
  if (daysSinceBreak > REPAIR_WINDOW_DAYS) {
    return {
      success: false,
      message: `Streaks can only be repaired within ${REPAIR_WINDOW_DAYS} days of breaking.`,
    };
  }

  // Restore, and mark yesterday as secured so today's first completion
  // continues the streak rather than restarting it.
  const todayKey = todayKeyFor(user.timezone);
  await User.findByIdAndUpdate(userId, {
    $set: {
      currentStreak: lost,
      streaks: lost,
      longestStreak: Math.max(user.longestStreak ?? 0, lost),
      lastStreakDayKey: dayKeyOffsetFromKey(todayKey, -1),
      previousStreak: 0,
    },
    $unset: { streakBrokenAt: "" },
  });

  return { success: true, message: `Your ${lost}-day streak is back.`, restored: lost };
}
