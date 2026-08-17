import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Streak repair is Pro-only.
 *
 * It used to accept a freeze token from free users, which made the paid moment
 * purchasable with a currency the weekly cron hands out to everyone. The gate
 * existed; the key was free. Nothing covered that path, which is how it
 * survived — these tests exist so the next person to touch the streak economy
 * has to do it deliberately.
 *
 * The invariant that matters most is the LAST one: a refusal must not spend
 * anything. A free user who taps Repair and gets a paywall still has their
 * freeze tokens.
 */

vi.mock("../../models/User.js", () => ({
  User: { findById: vi.fn(), findByIdAndUpdate: vi.fn(async () => ({})) },
}));
vi.mock("../../models/Shard.js", () => ({
  default: { find: vi.fn(), countDocuments: vi.fn() },
}));
vi.mock("../../models/MiniGoal.js", () => ({
  default: { aggregate: vi.fn(), countDocuments: vi.fn() },
}));
vi.mock("../../models/Friendship.js", () => ({ default: { countDocuments: vi.fn() } }));
vi.mock("../../Helpers/Cache.js", () => ({
  cache: { getOrSet: vi.fn(async (_k: string, f: () => any) => f()), del: vi.fn() },
  cacheKeys: {},
  cacheInvalidate: { user: vi.fn(), shard: vi.fn(), shardList: vi.fn() },
}));
vi.mock("../../Helpers/Notify.js", () => ({
  notify: vi.fn(async () => ({})),
  notifyStreakProgress: vi.fn(async () => ({})),
}));
vi.mock("../../Helpers/Telemetry.js", () => ({ logEvent: vi.fn() }));
vi.mock("../../Helpers/Helpers.js", async (orig) => {
  const actual: any = await orig();
  return { ...actual, SaveAuditTrail: vi.fn(), logError: vi.fn() };
});
vi.mock("../../Helpers/Streak.js", () => ({
  recordActivity: vi.fn(),
  getStreak: vi.fn(),
  xpMultiplierFor: vi.fn(() => 1),
  repairStreak: vi.fn(async () => ({
    success: true,
    message: "Your 23-day streak is back.",
    restored: 23,
  })),
}));

import { User } from "../../models/User.js";
import { repairStreak as repairStreakHelper } from "../../Helpers/Streak.js";
import XPResolvers from "./XP.js";

const USER = "507f1f77bcf86cd799439011";
const ctx = { id: USER };

const lean = (doc: any) => ({ select: () => lean(doc), lean: () => Promise.resolve(doc) }) as any;

/** A free user sitting on a full stock of freeze tokens. */
function freeUser(overrides: any = {}) {
  return { subscriptionTier: "free", streakFreezeTokens: 3, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(repairStreakHelper).mockResolvedValue({
    success: true,
    message: "Your 23-day streak is back.",
    restored: 23,
  });
});

describe("repairStreak — Pro only", () => {
  it("refuses a free user even with freeze tokens in hand", async () => {
    vi.mocked(User.findById).mockReturnValue(lean(freeUser()));

    const res: any = await (XPResolvers as any).Mutation.repairStreak({}, {}, ctx);

    expect(res.success).toBe(false);
    // Tokens are the free mechanic; they must not buy the paid one.
    expect(repairStreakHelper).not.toHaveBeenCalled();
  });

  it("flags the refusal so the client opens the paywall instead of an error", async () => {
    vi.mocked(User.findById).mockReturnValue(lean(freeUser()));

    const res: any = await (XPResolvers as any).Mutation.repairStreak({}, {}, ctx);

    expect(res.needsUpgrade).toBe(true);
    expect(res.message).toMatch(/Pro/);
  });

  it("does not spend a freeze token on a refused repair", async () => {
    vi.mocked(User.findById).mockReturnValue(lean(freeUser()));

    await (XPResolvers as any).Mutation.repairStreak({}, {}, ctx);

    // The old code decremented after a successful repair; the new one must not
    // write anything at all when it turns the user away.
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("lets a paid user repair", async () => {
    vi.mocked(User.findById).mockReturnValue(lean({ subscriptionTier: "pro" }));

    const res: any = await (XPResolvers as any).Mutation.repairStreak({}, {}, ctx);

    expect(res.success).toBe(true);
    expect(res.restored).toBe(23);
    expect(repairStreakHelper).toHaveBeenCalledWith(USER);
  });

  it("lets a trialling user repair — the trial IS Pro", async () => {
    vi.mocked(User.findById).mockReturnValue(
      lean({
        subscriptionTier: "free",
        trialStartedAt: new Date(),
        trialEndsAt: new Date(Date.now() + 5 * 86_400_000),
      })
    );

    const res: any = await (XPResolvers as any).Mutation.repairStreak({}, {}, ctx);

    expect(res.success).toBe(true);
  });

  it("never charges a Pro repair to the freeze stock", async () => {
    vi.mocked(User.findById).mockReturnValue(
      lean({ subscriptionTier: "pro", streakFreezeTokens: 3 })
    );

    await (XPResolvers as any).Mutation.repairStreak({}, {}, ctx);

    // Their subscription already covers this. Spending a token would quietly
    // bill them twice for one repair.
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
