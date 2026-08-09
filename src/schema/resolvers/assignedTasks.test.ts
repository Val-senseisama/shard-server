import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for getMyAssignedTasks.
 *
 * The subtle part is that assignment happens at two levels with two different
 * stored types: `MiniGoal.assignedTo` is an ObjectId, `tasks[].assignedTo` is a
 * String. Both must resolve to the same user, and a mini-goal assigned as a whole
 * must imply every task under it.
 */

vi.mock("../../models/Shard.js", () => ({
  default: { find: vi.fn(), findById: vi.fn(), countDocuments: vi.fn() },
}));
vi.mock("../../models/MiniGoal.js", () => ({ default: { find: vi.fn(), findById: vi.fn() } }));
vi.mock("../../models/User.js", () => ({ User: { find: vi.fn(), findById: vi.fn() } }));
vi.mock("../../models/Chat.js", () => ({ default: {}, Message: { create: vi.fn() } }));
vi.mock("../../models/Analytics.js", () => ({ default: { findOne: vi.fn() } }));
vi.mock("../../models/SideQuest.js", () => ({ default: { findOne: vi.fn(), create: vi.fn() } }));
vi.mock("./XP.js", () => ({ awardXP: vi.fn(), checkAchievements: vi.fn() }));
vi.mock("../../Helpers/AIHelper.js", () => ({
  breakDownGoalWithAI: vi.fn(),
  checkAIUsage: vi.fn(),
  trackAIUsage: vi.fn(async () => true),
  enrichManualShard: vi.fn(),
  generateProductivityInsights: vi.fn(async () => []),
}));
vi.mock("../../Helpers/Cache.js", () => ({
  cache: { getOrSet: vi.fn(async (_k: string, f: () => any) => f()), del: vi.fn() },
  cacheKeys: {},
  cacheInvalidate: { shard: vi.fn(), shardList: vi.fn(), chat: vi.fn() },
}));

import Shard from "../../models/Shard.js";
import MiniGoal from "../../models/MiniGoal.js";
import ShardResolvers from "./Shard.js";

const ME = "507f1f77bcf86cd799439011";
const OTHER = "507f1f77bcf86cd799439022";

const chain = (docs: any): any => {
  const q: any = { lean: () => Promise.resolve(docs) };
  q.select = () => q;
  q.sort = () => q;
  return q;
};

const task = (over: any = {}) => ({
  title: "Run 5k",
  completed: false,
  deleted: false,
  xpReward: 20,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Shard.find).mockReturnValue(chain([{ _id: "s1", title: "Get fit" }]));
});

describe("getMyAssignedTasks", () => {
  it("returns only the tasks assigned to the caller", async () => {
    vi.mocked(MiniGoal.find).mockReturnValue(
      chain([
        {
          _id: { toString: () => "mg1" },
          shardId: { toString: () => "s1" },
          title: "Week 1",
          tasks: [
            task({ title: "mine", assignedTo: ME }),
            task({ title: "theirs", assignedTo: OTHER }),
            task({ title: "unassigned" }),
          ],
        },
      ])
    );

    const res: any = await ShardResolvers.Query.getMyAssignedTasks({}, {}, { id: ME });

    expect(res.success).toBe(true);
    expect(res.tasks.map((t: any) => t.title)).toEqual(["mine"]);
  });

  it("treats a whole assigned mini-goal as assigning every task under it", async () => {
    vi.mocked(MiniGoal.find).mockReturnValue(
      chain([
        {
          _id: { toString: () => "mg1" },
          shardId: { toString: () => "s1" },
          title: "Week 1",
          // ObjectId-typed at this level, String-typed on the tasks.
          assignedTo: { toString: () => ME },
          tasks: [task({ title: "a" }), task({ title: "b" })],
        },
      ])
    );

    const res: any = await ShardResolvers.Query.getMyAssignedTasks({}, {}, { id: ME });

    expect(res.tasks.map((t: any) => t.title)).toEqual(["a", "b"]);
  });

  it("excludes completed and soft-deleted tasks by default", async () => {
    vi.mocked(MiniGoal.find).mockReturnValue(
      chain([
        {
          _id: { toString: () => "mg1" },
          shardId: { toString: () => "s1" },
          title: "Week 1",
          tasks: [
            task({ title: "open", assignedTo: ME }),
            task({ title: "done", assignedTo: ME, completed: true }),
            task({ title: "gone", assignedTo: ME, deleted: true }),
          ],
        },
      ])
    );

    const res: any = await ShardResolvers.Query.getMyAssignedTasks({}, {}, { id: ME });

    expect(res.tasks.map((t: any) => t.title)).toEqual(["open"]);
  });

  it("includes completed tasks when asked, but never deleted ones", async () => {
    vi.mocked(MiniGoal.find).mockReturnValue(
      chain([
        {
          _id: { toString: () => "mg1" },
          shardId: { toString: () => "s1" },
          title: "Week 1",
          tasks: [
            task({ title: "open", assignedTo: ME }),
            task({ title: "done", assignedTo: ME, completed: true }),
            task({ title: "gone", assignedTo: ME, deleted: true }),
          ],
        },
      ])
    );

    const res: any = await ShardResolvers.Query.getMyAssignedTasks(
      {}, { includeCompleted: true }, { id: ME }
    );

    expect(res.tasks.map((t: any) => t.title).sort()).toEqual(["done", "open"]);
  });

  it("sorts by soonest due date and puts undated work last", async () => {
    const soon = new Date("2026-08-10").getTime();
    const later = new Date("2026-09-01").getTime();

    vi.mocked(MiniGoal.find).mockReturnValue(
      chain([
        {
          _id: { toString: () => "mg1" },
          shardId: { toString: () => "s1" },
          title: "Week 1",
          tasks: [
            task({ title: "undated", assignedTo: ME }),
            task({ title: "later", assignedTo: ME, dueDate: new Date(later) }),
            task({ title: "soon", assignedTo: ME, dueDate: new Date(soon) }),
          ],
        },
      ])
    );

    const res: any = await ShardResolvers.Query.getMyAssignedTasks({}, {}, { id: ME });

    expect(res.tasks.map((t: any) => t.title)).toEqual(["soon", "later", "undated"]);
  });

  it("carries quest and mini-goal context so the client can link back", async () => {
    vi.mocked(MiniGoal.find).mockReturnValue(
      chain([
        {
          _id: { toString: () => "mg1" },
          shardId: { toString: () => "s1" },
          title: "Week 1",
          tasks: [task({ title: "x" }), task({ title: "mine", assignedTo: ME })],
        },
      ])
    );

    const res: any = await ShardResolvers.Query.getMyAssignedTasks({}, {}, { id: ME });
    const t = res.tasks[0];

    expect(t.shardId).toBe("s1");
    expect(t.shardTitle).toBe("Get fit");
    expect(t.miniGoalId).toBe("mg1");
    expect(t.miniGoalTitle).toBe("Week 1");
    // taskIndex must be the real position, since resolveOverdueTask and
    // completeTask address tasks by index.
    expect(t.taskIndex).toBe(1);
    expect(t.id).toBe("mg1-1");
  });

  it("returns empty rather than querying mini-goals when the user is in no quests", async () => {
    vi.mocked(Shard.find).mockReturnValue(chain([]));

    const res: any = await ShardResolvers.Query.getMyAssignedTasks({}, {}, { id: ME });

    expect(res.success).toBe(true);
    expect(res.tasks).toEqual([]);
    expect(MiniGoal.find).not.toHaveBeenCalled();
  });

  it("requires auth", async () => {
    await expect(
      ShardResolvers.Query.getMyAssignedTasks({}, {}, {})
    ).rejects.toThrow();
  });
});
