import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Regression tests for the object-level authorisation fixes.
 *
 * `getShard` previously had only a login check, so any authenticated user could
 * read any quest by id — including one flagged `isPrivate` — together with every
 * mini-goal and task on it. `assignTaskFromChat` had no authorisation at all.
 */

vi.mock("../../models/Shard.js", () => ({
  default: { findById: vi.fn(), countDocuments: vi.fn() },
}));
vi.mock("../../models/MiniGoal.js", () => ({ default: { find: vi.fn() } }));
vi.mock("../../models/User.js", () => ({ User: { findById: vi.fn(), find: vi.fn() } }));
vi.mock("../../models/Analytics.js", () => ({ default: { findOne: vi.fn() } }));
vi.mock("../../models/SideQuest.js", () => ({ default: { findOne: vi.fn(), create: vi.fn() } }));
vi.mock("./XP.js", () => ({ awardXP: vi.fn(), checkAchievements: vi.fn() }));
vi.mock("../../Helpers/AIHelper.js", () => ({
  breakDownGoalWithAI: vi.fn(),
  checkAIUsage: vi.fn(),
  trackAIUsage: vi.fn(async () => true),
  generateProductivityInsights: vi.fn(async () => []),
}));
vi.mock("../../Helpers/Cache.js", () => ({
  cache: { getOrSet: vi.fn(async (_k: string, factory: () => any) => factory()), del: vi.fn() },
  cacheKeys: {},
  cacheInvalidate: { shard: vi.fn(), shardList: vi.fn(), chat: vi.fn() },
}));

import Shard from "../../models/Shard.js";
import MiniGoal from "../../models/MiniGoal.js";
import { User } from "../../models/User.js";
import ShardResolvers from "./Shard.js";

const OWNER = "owner-1";
const PARTICIPANT = "participant-1";
const STRANGER = "stranger-9";

// getShard populates `owner`, so the id arrives nested under `_id`.
const shardDoc = (isPrivate = false) => ({
  _id: { toString: () => "shard-1" },
  title: "Ship the thing",
  description: "secret plan",
  status: "active",
  isPrivate,
  progress: { completion: 0 },
  timeline: { startDate: new Date() },
  participants: [{ user: { toString: () => PARTICIPANT }, role: "collaborator" }],
  owner: { _id: { toString: () => OWNER }, username: "owner", profilePic: null },
});

const chain = (doc: any) => ({
  select: () => chain(doc),
  populate: () => chain(doc),
  sort: () => chain(doc),
  lean: () => Promise.resolve(doc),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(MiniGoal.find).mockReturnValue(chain([]) as any);
  vi.mocked(User.find).mockReturnValue(chain([]) as any);
});

describe("getShard — object-level authorisation", () => {
  it("denies a user who is neither owner nor participant", async () => {
    vi.mocked(Shard.findById).mockReturnValue(chain(shardDoc()) as any);

    const res: any = await ShardResolvers.Query.getShard({}, { id: "shard-1" }, { id: STRANGER });

    expect(res.success).toBe(false);
    expect(res.shard).toBeNull();
  });

  it("does not leak quest contents to a stranger", async () => {
    vi.mocked(Shard.findById).mockReturnValue(chain(shardDoc(true)) as any);

    const res: any = await ShardResolvers.Query.getShard({}, { id: "shard-1" }, { id: STRANGER });

    expect(JSON.stringify(res)).not.toContain("secret plan");
    expect(JSON.stringify(res)).not.toContain("Ship the thing");
  });

  it("returns the same 'not found' shape as a missing quest, so ids can't be probed", async () => {
    vi.mocked(Shard.findById).mockReturnValue(chain(shardDoc()) as any);
    const denied: any = await ShardResolvers.Query.getShard({}, { id: "shard-1" }, { id: STRANGER });

    vi.mocked(Shard.findById).mockReturnValue(chain(null) as any);
    const missing: any = await ShardResolvers.Query.getShard({}, { id: "nope" }, { id: STRANGER });

    expect(denied.message).toBe(missing.message);
    expect(denied.success).toBe(missing.success);
  });

  it("allows the owner", async () => {
    vi.mocked(Shard.findById).mockReturnValue(chain(shardDoc()) as any);

    const res: any = await ShardResolvers.Query.getShard({}, { id: "shard-1" }, { id: OWNER });

    expect(res.success).toBe(true);
    expect(res.shard.title).toBe("Ship the thing");
  });

  it("allows a participant", async () => {
    vi.mocked(Shard.findById).mockReturnValue(chain(shardDoc()) as any);

    const res: any = await ShardResolvers.Query.getShard({}, { id: "shard-1" }, { id: PARTICIPANT });

    expect(res.success).toBe(true);
    expect(res.shard.title).toBe("Ship the thing");
  });
});

describe("getSignedUploadUrl — upload credentials require auth", () => {
  it("rejects an unauthenticated caller", async () => {
    await expect(
      ShardResolvers.Query.getSignedUploadUrl({}, {}, {})
    ).rejects.toThrow();
  });
});
