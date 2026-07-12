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

// New users get a time-boxed Pro trial to experience the full product.
export const TRIAL_DURATION_DAYS = 7;

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

/**
 * True while a user is inside their 7-day Pro trial. Computed on read, so it
 * expires automatically with no cron. Only meaningful for non-paid users
 * (a paid subscription already grants Pro).
 */
export function isInTrial(
  user?: { subscriptionTier?: string | null; trialEndsAt?: Date | string | null } | null
): boolean {
  if (!user?.trialEndsAt || isEntitled(user.subscriptionTier)) return false;
  return new Date(user.trialEndsAt).getTime() > Date.now();
}

/**
 * Derive effective tier from the trusted fields. Pro if paid, admin, or in-trial.
 * NOTE: callers must select `trialEndsAt` (alongside subscriptionTier/role) or the
 * trial will be silently ignored.
 */
export function tierOf(
  user?: { subscriptionTier?: string | null; role?: string | null; trialEndsAt?: Date | string | null } | null
): "free" | "pro" {
  if (isEntitled(user?.subscriptionTier) || user?.role === "admin" || isInTrial(user)) return "pro";
  return "free";
}

/** Count a user's active (incl. paused) Shards — matches getMyStats / generateSideQuest. */
export async function countActiveShards(userId: string): Promise<number> {
  return Shard.countDocuments({ owner: userId, status: { $in: ["active", "paused"] } });
}

/** Uniform failure payload the client keys off (needsUpgrade → show paywall). */
export function upgradeError(message: string) {
  return { success: false, message, needsUpgrade: true };
}
