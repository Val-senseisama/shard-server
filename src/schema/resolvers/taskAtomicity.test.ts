import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Regression tests for the completeTask / uncompleteTask concurrency fixes.
 *
 * Both used to read the whole `tasks` array, mutate one element, and write the
 * array back. That had two failure modes:
 *
 *  - Two tasks completed at once in the same mini-goal clobbered each other —
 *    last write wins, one completion silently lost.
 *  - `completed` was checked in application code before the write, leaving a
 *    TOCTOU window in which a double-tap paid XP twice.
 *
 * Both now claim the task with one conditional update and branch on
 * `modifiedCount`, so only one caller can ever win.
 */

vi.mock("../../models/MiniGoal.js", () => ({
  default: {
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(async () => ({})),
    find: vi.fn(),
    updateOne: vi.fn(),
    countDocuments: vi.fn(),
    aggregate: vi.fn(),
  },
}));
vi.mock("../../models/Shard.js", () => ({
  default: { findById: vi.fn(), findByIdAndUpdate: vi.fn(async () => ({})), find: vi.fn(), countDocuments: vi.fn() },
}));
vi.mock("../../models/User.js", () => ({
  User: { findById: vi.fn(), findByIdAndUpdate: vi.fn(async () => ({})) },
}));
vi.mock("../../models/Friendship.js", () => ({ default: { countDocuments: vi.fn(async () => 0) } }));
vi.mock("../../Helpers/Cache.js", () => ({
  cache: {}, cacheKeys: {}, cacheInvalidate: { user: vi.fn(async () => {}) },
}));
vi.mock("../../Helpers/Streak.js", () => ({
  recordActivity: vi.fn(async () => ({ counted: false })),
  getStreak: vi.fn(),
  xpMultiplierFor: vi.fn(() => 1),
  repairStreak: vi.fn(),
}));
vi.mock("../../Helpers/Notify.js", () => ({
  notify: vi.fn(async () => ({})),
  notifyStreakProgress: vi.fn(async () => ({})),
}));
vi.mock("../../Helpers/Activation.js", () => ({ stampFirstMiniGoal: vi.fn(async () => {}) }));
vi.mock("../../Helpers/Progress.js", async (orig) => {
  const actual: any = await orig();
  return { ...actual, recomputeShardProgress: vi.fn(async () => ({})) };
});

import MiniGoal from "../../models/MiniGoal.js";
import Shard from "../../models/Shard.js";
import { User } from "../../models/User.js";
import { completeTask, uncompleteTask } from "./XP.js";

const USER = "u1";
const SHARD = "s1";
const MG = "mg1";

// Chainable query stub — callers mix `.lean()`, `.select().lean()` and
// `.populate().lean()`, so every link returns the same object.
const lean = (doc: any): any => {
  const q: any = { lean: () => Promise.resolve(doc) };
  q.select = () => q;
  q.populate = () => q;
  q.sort = () => q;
  return q;
};
const select = lean;

const miniGoal = (tasks: any[]) => ({
  _id: MG,
  shardId: { toString: () => SHARD },
  title: "Ship it",
  completed: false,
  tasks,
});

const openTask = { title: "Run 5k", completed: false, xpReward: 20 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Shard.findById).mockReturnValue(lean({ owner: { toString: () => USER }, participants: [] }));
  vi.mocked(Shard.find).mockReturnValue(lean([]) as any);
  vi.mocked(Shard.countDocuments).mockResolvedValue(0 as any);
  vi.mocked(MiniGoal.find).mockReturnValue(select([{ tasks: [], completed: false }]));
  vi.mocked(MiniGoal.countDocuments).mockResolvedValue(0 as any);
  vi.mocked(MiniGoal.aggregate).mockResolvedValue([] as any);
  vi.mocked(User.findById).mockReturnValue(lean({ xp: 100, level: 2, achievements: [] }));
});

describe("completeTask — atomic claim", () => {
  it("claims the task with a conditional update, not a whole-array write", async () => {
    vi.mocked(MiniGoal.findById).mockReturnValue(lean(miniGoal([openTask])));
    vi.mocked(MiniGoal.updateOne).mockResolvedValue({ modifiedCount: 1 } as any);

    await completeTask(USER, SHARD, MG, 0);

    const [filter, update] = vi.mocked(MiniGoal.updateOne).mock.calls[0] as any;

    // The guard lives in the query, which is what makes it atomic.
    expect(filter["tasks.0.completed"]).toBe(false);
    expect(update.$set["tasks.0.completed"]).toBe(true);

    // The whole-array write is what lost sibling updates.
    expect(update.$set).not.toHaveProperty("tasks");
    expect(MiniGoal.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("pays no XP when the claim is lost to a concurrent completion", async () => {
    vi.mocked(MiniGoal.findById).mockReturnValue(lean(miniGoal([openTask])));
    // modifiedCount 0 = another caller already flipped this task.
    vi.mocked(MiniGoal.updateOne).mockResolvedValue({ modifiedCount: 0 } as any);

    const res: any = await completeTask(USER, SHARD, MG, 0);

    expect(res.success).toBe(true);
    expect(res.xpEarned).toBe(0);
    expect(res.message).toMatch(/already completed/i);
    // No XP write, so a double-tap cannot pay twice.
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("awards XP exactly once when the claim is won", async () => {
    vi.mocked(MiniGoal.findById).mockReturnValue(lean(miniGoal([openTask])));
    vi.mocked(MiniGoal.updateOne).mockResolvedValue({ modifiedCount: 1 } as any);

    const res: any = await completeTask(USER, SHARD, MG, 0);

    expect(res.success).toBe(true);
    expect(res.xpEarned).toBe(20);

    // Exactly one XP increment. (findByIdAndUpdate is also used to push
    // achievement unlocks, so filter to the write that moves XP.)
    const xpWrites = vi.mocked(User.findByIdAndUpdate).mock.calls
      .map((c: any) => c[1])
      .filter((u: any) => u?.$inc?.xp !== undefined);

    expect(xpWrites).toHaveLength(1);
    expect(xpWrites[0].$inc.xp).toBe(20);
  });

  it("computes progress from a re-read, so a sibling completion is not lost", async () => {
    // Opening snapshot: both tasks open. By the time we re-read, another writer
    // has completed task 1 — progress must reflect both, not the stale view.
    vi.mocked(MiniGoal.findById)
      .mockReturnValueOnce(lean(miniGoal([openTask, { ...openTask, title: "other" }])))
      .mockReturnValueOnce(
        lean(miniGoal([
          { ...openTask, completed: true },
          { ...openTask, title: "other", completed: true },
        ]))
      );
    vi.mocked(MiniGoal.updateOne).mockResolvedValue({ modifiedCount: 1 } as any);

    await completeTask(USER, SHARD, MG, 0);

    const progressWrite = vi.mocked(MiniGoal.updateOne).mock.calls
      .map((c: any) => c[1])
      .find((u: any) => u.$set && "progress" in u.$set);

    expect(progressWrite.$set.progress).toBe(100);
    expect(progressWrite.$set.completed).toBe(true);
  });
});

describe("uncompleteTask — atomic release", () => {
  const justCompleted = {
    title: "Run 5k",
    completed: true,
    xpReward: 20,
    xpAwarded: 24,
    completedAt: new Date(),
  };

  it("releases with a conditional update guarded on completed: true", async () => {
    vi.mocked(MiniGoal.findById).mockReturnValue(lean(miniGoal([justCompleted])));
    vi.mocked(MiniGoal.updateOne).mockResolvedValue({ modifiedCount: 1 } as any);

    await uncompleteTask(USER, SHARD, MG, 0);

    const [filter, update] = vi.mocked(MiniGoal.updateOne).mock.calls[0] as any;

    expect(filter["tasks.0.completed"]).toBe(true);
    expect(update.$set["tasks.0.completed"]).toBe(false);
    expect(update.$unset).toHaveProperty("tasks.0.xpAwarded");
    expect(MiniGoal.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("claws back nothing when the release is lost to a concurrent undo", async () => {
    vi.mocked(MiniGoal.findById).mockReturnValue(lean(miniGoal([justCompleted])));
    vi.mocked(MiniGoal.updateOne).mockResolvedValue({ modifiedCount: 0 } as any);

    const res: any = await uncompleteTask(USER, SHARD, MG, 0);

    expect(res.success).toBe(true);
    expect(res.xpEarned).toBe(0);
    // The XP was already clawed back by the winner — doing it twice would
    // charge the user 48 XP for a single 24 XP completion.
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
