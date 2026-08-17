import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Regression tests for the achievement stat queries.
 *
 * Three separate bugs in `buildUserStats` pinned `friendCount`, `tasksCompleted`
 * and `miniGoalsCompleted` to 0 forever, making 13 of the 43 achievements
 * permanently unreachable:
 *
 *  - Friendship was queried with `requester` / `recipient`; the model's fields
 *    are `user` / `friend`.
 *  - The aggregation `$match` compared a string userId to a stored ObjectId.
 *    Mongoose does not cast inside `aggregate()`, so it never matched.
 *  - A dead `countDocuments` referenced `shard.owner`, a path that does not
 *    exist on MiniGoal, behind a `.catch(() => 0)`.
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
vi.mock("../../Helpers/Helpers.js", async (orig) => {
  const actual: any = await orig();
  return { ...actual, SaveAuditTrail: vi.fn(), logError: vi.fn() };
});

import { User } from "../../models/User.js";
import Shard from "../../models/Shard.js";
import MiniGoal from "../../models/MiniGoal.js";
import Friendship from "../../models/Friendship.js";
import { notify } from "../../Helpers/Notify.js";
import { checkAchievements } from "./XP.js";
import XPResolvers from "./XP.js";

const USER = "507f1f77bcf86cd799439011";
const OTHER = "507f1f77bcf86cd799439022";

const lean = (doc: any) => ({ select: () => lean(doc), lean: () => Promise.resolve(doc) }) as any;
const find = (docs: any) => ({ lean: () => Promise.resolve(docs) }) as any;

/** No achievements earned yet, baseline progression stats all zero. */
function baseUser(overrides: any = {}) {
  return {
    achievements: [],
    xp: 0,
    level: 1,
    currentStreak: 0,
    longestStreak: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(User.findById).mockReturnValue(lean(baseUser()));
  vi.mocked(Shard.find).mockReturnValue(find([]) as any);
  vi.mocked(Shard.countDocuments).mockResolvedValue(0 as any);
  vi.mocked(MiniGoal.countDocuments).mockResolvedValue(0 as any);
  vi.mocked(MiniGoal.aggregate).mockResolvedValue([] as any);
  vi.mocked(Friendship.countDocuments).mockResolvedValue(0 as any);
});

describe("checkAchievements — friend achievements", () => {
  it("queries Friendship on the fields the model actually defines", async () => {
    await checkAchievements(USER);

    const query = vi.mocked(Friendship.countDocuments).mock.calls[0][0] as any;
    const keys = query.$or.flatMap((c: any) => Object.keys(c));

    expect(keys).toContain("user");
    expect(keys).toContain("friend");
    // The fields that made this always return 0.
    expect(keys).not.toContain("requester");
    expect(keys).not.toContain("recipient");
  });

  it("unlocks a friend achievement once the user has friends", async () => {
    vi.mocked(Friendship.countDocuments).mockResolvedValue(1 as any);

    const unlocked = await checkAchievements(USER);

    expect(unlocked).toContain("friends_1");
  });
});

describe("checkAchievements — task and mini-goal achievements", () => {
  it("counts completed tasks and unlocks the first task achievement", async () => {
    vi.mocked(Shard.find).mockReturnValue(find([{ _id: "s1", owner: { toString: () => USER } }]) as any);
    vi.mocked(MiniGoal.aggregate).mockResolvedValue([{ _id: null, total: 1 }] as any);

    const unlocked = await checkAchievements(USER);

    expect(unlocked).toContain("tasks_1");
  });

  it("counts completed mini-goals", async () => {
    vi.mocked(Shard.find).mockReturnValue(find([{ _id: "s1", owner: { toString: () => USER } }]) as any);
    vi.mocked(MiniGoal.countDocuments).mockResolvedValue(1 as any);

    const unlocked = await checkAchievements(USER);

    expect(unlocked).toContain("minigoals_1");
  });

  it("scopes mini-goal stats by shardId rather than a $lookup on shard.owner", async () => {
    vi.mocked(Shard.find).mockReturnValue(find([{ _id: "s1", owner: { toString: () => USER } }]) as any);

    await checkAchievements(USER);

    const countQuery = vi.mocked(MiniGoal.countDocuments).mock.calls[0][0] as any;
    expect(countQuery).toHaveProperty("shardId");
    expect(JSON.stringify(countQuery)).not.toContain("shard.owner");
  });
});

describe("checkAchievements — collaborationsJoined", () => {
  it("counts only shards owned by someone else", async () => {
    vi.mocked(Shard.find).mockReturnValue(
      find([
        { _id: "mine", owner: { toString: () => USER } },
        { _id: "theirs", owner: { toString: () => OTHER } },
      ]) as any
    );

    const unlocked = await checkAchievements(USER);

    // One joined collaboration — enough for the first tier, and proof that the
    // user's own shard was not counted as a collaboration.
    expect(unlocked).toContain("collab_1");
  });

  it("does not count a user's own shard as a collaboration", async () => {
    vi.mocked(Shard.find).mockReturnValue(
      find([{ _id: "mine", owner: { toString: () => USER } }]) as any
    );

    const unlocked = await checkAchievements(USER);

    expect(unlocked).not.toContain("collab_1");
  });
});

describe("checkAchievements — silent grants for backfill", () => {
  beforeEach(() => {
    vi.mocked(Friendship.countDocuments).mockResolvedValue(1 as any);
  });

  it("notifies by default, so the live path still celebrates", async () => {
    const unlocked = await checkAchievements(USER);

    expect(unlocked.length).toBeGreaterThan(0);
    expect(notify).toHaveBeenCalled();
  });

  it("grants without pushing when silent", async () => {
    const unlocked = await checkAchievements(USER, { silent: true });

    // Still granted...
    expect(unlocked).toContain("friends_1");
    expect(User.findByIdAndUpdate).toHaveBeenCalled();
    // ...but no push. A backfill that fires one notification per unlock blasts a
    // user with a pile of alerts for things they earned weeks ago, which is how
    // people turn notifications off for good.
    expect(notify).not.toHaveBeenCalled();
  });

  it("still queues silent grants for in-app display", async () => {
    await checkAchievements(USER, { silent: true });

    const [, update] = vi.mocked(User.findByIdAndUpdate).mock.calls[0] as any;
    // pendingAchievements is what surfaces the celebration on next app open —
    // silent must not mean invisible.
    expect(update.$push.pendingAchievements.$each).toContain("friends_1");
  });
});

// ─── getAchievements progress ────────────────────────────────────────────────

describe("getAchievements — progress toward the next unlock", () => {
  const ctx = { id: USER };

  async function fetch(overrides: any = {}, earned: string[] = []) {
    vi.mocked(User.findById).mockReturnValue(
      lean(baseUser({ ...overrides, achievements: earned }))
    );
    const res: any = await (XPResolvers as any).Query.getAchievements({}, {}, ctx);
    return new Map<string, any>(res.achievements.map((a: any) => [a.id, a]));
  }

  it("reports the live stat against each threshold", async () => {
    vi.mocked(Shard.find).mockReturnValue(
      find([{ _id: "s1", owner: { toString: () => USER } }]) as any
    );
    vi.mocked(MiniGoal.aggregate).mockResolvedValue([{ _id: null, total: 7 }] as any);

    const byId = await fetch();

    // "7 / 10" is what turns a padlock into a goal.
    expect(byId.get("tasks_10")).toMatchObject({ progress: 7, target: 10, earned: false });
  });

  it("clamps progress to the target rather than reporting 5000 / 10", async () => {
    vi.mocked(Shard.find).mockReturnValue(
      find([{ _id: "s1", owner: { toString: () => USER } }]) as any
    );
    vi.mocked(MiniGoal.aggregate).mockResolvedValue([{ _id: null, total: 5000 }] as any);

    const byId = await fetch();

    expect(byId.get("tasks_10").progress).toBe(10);
  });

  it("reports an earned badge as full even after the streak that won it broke", async () => {
    // Earned streak_7, current streak since reset to 2. A trophy that reads
    // "2 / 7" next to a tick is worse than no number at all.
    const byId = await fetch({ currentStreak: 2 }, ["streak_7"]);

    expect(byId.get("streak_7")).toMatchObject({ progress: 7, target: 7, earned: true });
    // The unearned rung above it still shows honest progress.
    expect(byId.get("streak_14")).toMatchObject({ progress: 2, target: 14, earned: false });
  });
});
