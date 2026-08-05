import Shard from "../models/Shard.js";

/**
 * Central entitlement / paywall helper.
 * The trusted source of truth for "is this user Pro?" is User.subscriptionTier,
 * written only by the RevenueCat webhook and admin action — never a client flag.
 */

export const FREE_ACTIVE_SHARD_CAP = 3;
// Free monthly AI-credit grant. Kept intentionally small so free users experience
// the AI value and then hit a wall that drives the paywall. If you change this,
// also update the schema default in models/User.ts (kept in sync manually to avoid
// a circular import User -> Entitlements -> Shard -> User).
export const FREE_MONTHLY_CREDITS = 15;

/**
 * The Pro trial is **milestone-based**, not a flat countdown.
 *
 * A 7-day clock was the wrong shape for this product: the payoff is finishing a
 * real goal, which takes weeks, so the trial expired long before a user could
 * possibly have evidence Shard works for them. They were asked to convert on
 * optimism.
 *
 * So the trial now runs until the user **finishes their first quest** — the
 * moment of proof, and the best upsell moment there is — bounded on both sides:
 *
 *  - never shorter than TRIAL_MIN_DAYS, so a fast finisher isn't punished for
 *    succeeding quickly
 *  - never longer than TRIAL_MAX_DAYS, so it can't run forever
 */
export const TRIAL_MIN_DAYS = 7;
export const TRIAL_MAX_DAYS = 30;

/**
 * @deprecated Kept so existing callers that stamp `trialEndsAt` at signup keep
 * compiling. It is the OUTER bound now — see TRIAL_MAX_DAYS.
 */
export const TRIAL_DURATION_DAYS = TRIAL_MAX_DAYS;

// The RevenueCat entitlement that maps to Shard Pro. Must match the client
// (UserProvider.tsx / purchasesService.ts) and the RevenueCat dashboard.
export const ENTITLEMENT_ID = process.env.REVENUECAT_ENTITLEMENT_ID || "Thinkertech Pro";

/**
 * Whether a RevenueCat event actually concerns our Pro entitlement. Guards the
 * webhook against granting Pro for some other product. If the event carries no
 * entitlement info at all, we don't block (backward compatible with older events).
 */
export function eventMatchesEntitlement(
  entitlementIds?: string[] | null,
  entitlementId?: string | null,
  expected: string = ENTITLEMENT_ID
): boolean {
  const list = Array.isArray(entitlementIds) && entitlementIds.length
    ? entitlementIds
    : entitlementId
      ? [entitlementId]
      : [];
  if (list.length === 0) return true;
  return list.includes(expected);
}

/** A subscription tier that unlocks Pro features. */
export function isEntitled(tier?: string | null): boolean {
  return tier === "pro" || tier === "enterprise";
}

/** The fields the trial computation reads. */
export interface TrialFields {
  subscriptionTier?: string | null;
  trialStartedAt?: Date | string | null;
  trialEndsAt?: Date | string | null;
  /** When the user completed their first quest — the milestone that ends the trial. */
  firstQuestCompletedAt?: Date | string | null;
}

const DAY_MS = 86_400_000;
const ms = (d?: Date | string | null) => (d ? new Date(d).getTime() : null);

/**
 * The instant this user's trial actually ends, or null if they have no trial.
 *
 * Computed on read — no cron, and no way for a stale field to grant Pro forever.
 * Exported so the client and the reminder job describe the same deadline the
 * gating uses.
 */
export function trialEndsAtEffective(user?: TrialFields | null): number | null {
  if (!user || isEntitled(user.subscriptionTier)) return null;

  const started = ms(user.trialStartedAt);
  const hardCap = ms(user.trialEndsAt);
  // No trial was ever granted.
  if (!started && !hardCap) return null;

  const floor = started ? started + TRIAL_MIN_DAYS * DAY_MS : null;
  const ceiling = hardCap ?? (started! + TRIAL_MAX_DAYS * DAY_MS);

  const milestone = ms(user.firstQuestCompletedAt);
  if (!milestone) return ceiling;

  // Finished a quest: the trial ends now, but never before the minimum window.
  const end = floor ? Math.max(milestone, floor) : milestone;
  return Math.min(end, ceiling);
}

/**
 * True while a user is inside their Pro trial. Only meaningful for non-paid
 * users (a paid subscription already grants Pro).
 */
export function isInTrial(user?: TrialFields | null): boolean {
  const end = trialEndsAtEffective(user);
  return end !== null && end > Date.now();
}

/** Whole days of trial left, floored at 0. For UI copy. */
export function trialDaysRemaining(user?: TrialFields | null): number {
  const end = trialEndsAtEffective(user);
  if (end === null) return 0;
  return Math.max(0, Math.ceil((end - Date.now()) / DAY_MS));
}

/**
 * Why the trial is ending — lets the client pick honest copy instead of a
 * generic countdown. "You finished your first quest" converts differently from
 * "your 30 days are up".
 */
export function trialEndReason(user?: TrialFields | null): "milestone" | "expiry" | null {
  if (!isInTrial(user)) return null;
  return user?.firstQuestCompletedAt ? "milestone" : "expiry";
}

/**
 * Derive effective tier from the trusted fields. Pro if paid, admin, or in-trial.
 * NOTE: callers must select `trialStartedAt`, `trialEndsAt` AND
 * `firstQuestCompletedAt` (alongside subscriptionTier/role) or the trial will be
 * silently mis-evaluated. `TRIAL_PROJECTION` exists so you can't forget one.
 */
export function tierOf(
  user?: (TrialFields & { role?: string | null }) | null
): "free" | "pro" {
  if (isEntitled(user?.subscriptionTier) || user?.role === "admin" || isInTrial(user)) return "pro";
  return "free";
}

/**
 * Every field `tierOf` needs. Append this to any projection that gates on tier —
 * a missing field here silently downgrades a trialling user to free.
 */
export const TRIAL_PROJECTION = "subscriptionTier role trialStartedAt trialEndsAt firstQuestCompletedAt";

/** Count a user's active (incl. paused) Shards — matches getMyStats / generateSideQuest. */
export async function countActiveShards(userId: string): Promise<number> {
  // `at_risk` and `stalled` are still the user's open workload — they're just
  // lifecycle flags set by the nightly sweep, not a different kind of shard. If
  // they didn't count here, letting a shard go quiet for five days would silently
  // free up a slot and the free-tier cap would be trivial to bypass.
  return Shard.countDocuments({
    owner: userId,
    status: { $in: ["active", "paused", "at_risk", "stalled"] },
  });
}

/** Uniform failure payload the client keys off (needsUpgrade → show paywall). */
export function upgradeError(message: string) {
  return { success: false, message, needsUpgrade: true };
}
