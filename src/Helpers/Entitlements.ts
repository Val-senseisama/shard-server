import Shard from "../models/Shard.js";

/**
 * Central entitlement / paywall helper.
 * The trusted source of truth for "is this user Pro?" is User.subscriptionTier,
 * written only by the RevenueCat webhook and admin action — never a client flag.
 */

export const FREE_ACTIVE_SHARD_CAP = 3;
export const FREE_MONTHLY_CREDITS = 100;

/** A subscription tier that unlocks Pro features. */
export function isEntitled(tier?: string | null): boolean {
  return tier === "pro" || tier === "enterprise";
}

/** Derive effective tier from the trusted fields. Admins always get Pro access. */
export function tierOf(
  user?: { subscriptionTier?: string | null; role?: string | null } | null
): "free" | "pro" {
  return isEntitled(user?.subscriptionTier) || user?.role === "admin" ? "pro" : "free";
}

/** Count a user's active (incl. paused) Shards — matches getMyStats / generateSideQuest. */
export async function countActiveShards(userId: string): Promise<number> {
  return Shard.countDocuments({ owner: userId, status: { $in: ["active", "paused"] } });
}

/** Uniform failure payload the client keys off (needsUpgrade → show paywall). */
export function upgradeError(message: string) {
  return { success: false, message, needsUpgrade: true };
}
