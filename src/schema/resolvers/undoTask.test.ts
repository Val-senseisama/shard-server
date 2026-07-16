import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the data layer so the resolver runs without Mongo.
vi.mock("../../models/MiniGoal.js", () => ({
  default: { findById: vi.fn(), findByIdAndUpdate: vi.fn(async () => ({})), find: vi.fn(), updateOne: vi.fn(async () => ({})) },
}));
vi.mock("../../models/Shard.js", () => ({
  default: { findById: vi.fn(), findByIdAndUpdate: vi.fn(async () => ({})) },
}));
vi.mock("../../models/User.js", () => ({
  User: { findById: vi.fn(), findByIdAndUpdate: vi.fn(async () => ({})) },
}));
vi.mock("../../models/Streak.js", () => ({ default: {} }));
vi.mock("../../models/Friendship.js", () => ({ default: { countDocuments: vi.fn() } }));
vi.mock("../../Helpers/Cache.js", () => ({
  cache: {}, cacheKeys: {}, cacheInvalidate: { user: vi.fn(async () => {}) },
}));
vi.mock("./Notifications.js", () => ({ createNotification: vi.fn() }));

import MiniGoal from "../../models/MiniGoal.js";
import Shard from "../../models/Shard.js";
import { User } from "../../models/User.js";
import { uncompleteTask, UNDO_WINDOW_MINUTES } from "./XP.js";

const USER = "u1";
const SHARD = "s1";
const MG = "mg1";

const lean = (doc: any) => ({ lean: () => Promise.resolve(doc) }) as any;
const select = (doc: any) => ({ select: () => lean(doc) }) as any;

/** A mini-goal whose task 0 was completed `agoMs` ago for `xpAwarded` XP. */
const miniGoalWith = (task: any) => ({
  _id: MG,
  shardId: { toString: () => SHARD },
  title: "Ship it",
  tasks: [task, { title: "other", completed: false }],
});

const completedTask = (agoMs: number, xpAwarded?: number) => ({
  title: "Run 5k",
  completed: true,
  xpReward: 20,
  xpAwarded,
  completedAt: new Date(Date.now() - agoMs),
});

const ownedShard = { owner: { toString: () => USER }, participants: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Shard.findById).mockReturnValue(lean(ownedShard));
  vi.mocked(MiniGoal.find).mockReturnValue(lean([{ progress: 0 }]));
  vi.mocked(User.findById).mockReturnValue(select({ xp: 500, level: 3 }));
});

describe("uncompleteTask — the 5-minute undo window", () => {
  it("claws back the EXACT xp that was awarded, bonus multiplier included", async () => {
    // 24, not the 20 base reward: this task was completed during a comeback bonus.
    vi.mocked(MiniGoal.findById).mockReturnValue(lean(miniGoalWith(completedTask(60_000, 24))));

    const res: any = await uncompleteTask(USER, SHARD, MG, 0);

    expect(res.success).toBe(true);
    expect(res.xpEarned).toBe(-24);
    const [, update] = vi.mocked(User.findByIdAndUpdate).mock.calls[0] as any;
    expect(update.$set.xp).toBe(500 - 24); // NOT 500 - 20
  });

  it("refuses once the window has closed", async () => {
    const stale = (UNDO_WINDOW_MINUTES + 1) * 60 * 1000;
    vi.mocked(MiniGoal.findById).mockReturnValue(lean(miniGoalWith(completedTask(stale, 20))));

    const res: any = await uncompleteTask(USER, SHARD, MG, 0);

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/within 5 minutes/i);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled(); // no XP moved
  });

  it("refuses tasks completed before this feature existed (no completedAt)", async () => {
    const legacy = { title: "old", completed: true, xpReward: 20 };
    vi.mocked(MiniGoal.findById).mockReturnValue(lean(miniGoalWith(legacy)));

    const res: any = await uncompleteTask(USER, SHARD, MG, 0);

    expect(res.success).toBe(false);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("never drives XP negative", async () => {
    vi.mocked(User.findById).mockReturnValue(select({ xp: 10, level: 1 }));
    vi.mocked(MiniGoal.findById).mockReturnValue(lean(miniGoalWith(completedTask(1000, 20))));

    await uncompleteTask(USER, SHARD, MG, 0);

    const [, update] = vi.mocked(User.findByIdAndUpdate).mock.calls[0] as any;
    expect(update.$set.xp).toBe(0);
  });

  it("falls back to xpReward when xpAwarded was never recorded", async () => {
    vi.mocked(MiniGoal.findById).mockReturnValue(lean(miniGoalWith(completedTask(1000, undefined))));

    const res: any = await uncompleteTask(USER, SHARD, MG, 0);

    expect(res.xpEarned).toBe(-20);
  });

  it("is a no-op on a task that isn't completed", async () => {
    const open = { title: "todo", completed: false, xpReward: 20 };
    vi.mocked(MiniGoal.findById).mockReturnValue(lean(miniGoalWith(open)));

    const res: any = await uncompleteTask(USER, SHARD, MG, 0);

    expect(res.success).toBe(true);
    expect(res.xpEarned).toBe(0);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("denies a user who is neither owner nor collaborator", async () => {
    vi.mocked(Shard.findById).mockReturnValue(
      lean({ owner: { toString: () => "someone-else" }, participants: [] })
    );
    vi.mocked(MiniGoal.findById).mockReturnValue(lean(miniGoalWith(completedTask(1000, 20))));

    const res: any = await uncompleteTask(USER, SHARD, MG, 0);

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/permission/i);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
