import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * What "before this task" means.
 *
 * A catch-up completes every task preceding the one tapped, so its ordering has
 * to be the SAME ordering the shard screen displays. It used to lean on
 * `sourceSectionIndex` (absent on every non-course shard) falling back to
 * `createdAt` — and `createdAt` reflects which concurrent insert won the race,
 * not the plan the user approved.
 *
 * The fixture below makes `createdAt` disagree with `order` on purpose. Ordering
 * by insertion time would complete a different, wrong set of tasks.
 */

vi.mock("../../models/MiniGoal.js", () => ({
  default: { find: vi.fn(), findById: vi.fn(), updateOne: vi.fn(), bulkWrite: vi.fn() },
}));
vi.mock("../../models/Shard.js", () => ({ default: { findById: vi.fn() } }));
vi.mock("../../models/CurriculumDraft.js", () => ({ default: {} }));
vi.mock("../../models/User.js", () => ({ User: { findById: vi.fn() } }));
vi.mock("../../Helpers/Cache.js", () => ({
  cacheInvalidate: { shard: vi.fn(), shardList: vi.fn(), user: vi.fn() },
}));
vi.mock("../../Helpers/Telemetry.js", () => ({ logEvent: vi.fn() }));
vi.mock("../../Helpers/Streak.js", () => ({ recordActivity: vi.fn() }));
vi.mock("./XP.js", () => ({
  awardXP: vi.fn(),
  checkAchievements: vi.fn(),
  UNDO_WINDOW_MINUTES: 5,
}));

import MiniGoal from "../../models/MiniGoal.js";
import { resolveCatchUpPrefix } from "./CourseImport.js";

const task = (title: string) => ({ title, completed: false, deleted: false });

/**
 * Three phases whose `createdAt` is the REVERSE of their plan order — the shape
 * a concurrent `Promise.all` write can genuinely produce.
 */
const MINI_GOALS = [
  {
    _id: { toString: () => "mgC" },
    order: 2,
    createdAt: new Date("2026-01-01T00:00:00Z"), // written first, last in plan
    tasks: [task("c1")],
  },
  {
    _id: { toString: () => "mgA" },
    order: 0,
    createdAt: new Date("2026-01-01T00:00:02Z"),
    tasks: [task("a1"), task("a2")],
  },
  {
    _id: { toString: () => "mgB" },
    order: 1,
    createdAt: new Date("2026-01-01T00:00:01Z"),
    tasks: [task("b1")],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(MiniGoal.find).mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(MINI_GOALS) }),
  } as any);
});

describe("resolveCatchUpPrefix — 'before' follows plan order", () => {
  it("walks phases by order, not by which insert landed first", async () => {
    // Catch up to the only task in phase B (order 1). In plan order that's
    // a1, a2, then b1 — three tasks.
    const prefix = await resolveCatchUpPrefix("s1", "mgB", 0);

    expect(prefix.map((p) => p.miniGoalId)).toEqual(["mgA", "mgA", "mgB"]);
    expect(prefix).toHaveLength(3);
    // Sorting by createdAt would have put mgC first and completed its task too.
    expect(prefix.some((p) => p.miniGoalId === "mgC")).toBe(false);
  });

  it("includes the target task itself, and stops there", async () => {
    const prefix = await resolveCatchUpPrefix("s1", "mgA", 1);

    expect(prefix).toEqual([
      { miniGoalId: "mgA", taskIndex: 0 },
      { miniGoalId: "mgA", taskIndex: 1 },
    ]);
  });

  it("returns nothing when the target isn't found, rather than a partial sweep", async () => {
    // A stale client addressing a task that no longer exists must not complete
    // an arbitrary prefix of the plan.
    const prefix = await resolveCatchUpPrefix("s1", "mgA", 99);
    expect(prefix).toEqual([]);
  });
});
