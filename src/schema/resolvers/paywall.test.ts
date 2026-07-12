import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock the data + heavy-infra layer so resolvers run without Mongo/Redis/Groq ──
vi.mock("../../models/User.js", () => ({ User: { findById: vi.fn() } }));
vi.mock("../../models/Shard.js", () => ({ default: { countDocuments: vi.fn() } }));
vi.mock("../../models/MiniGoal.js", () => ({ default: {} }));
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

import { User } from "../../models/User.js";
import Shard from "../../models/Shard.js";
import SideQuest from "../../models/SideQuest.js";
import Analytics from "../../models/Analytics.js";
import { checkAIUsage, trackAIUsage, breakDownGoalWithAI } from "../../Helpers/AIHelper.js";
import AnalyticsResolvers from "./Analytics.js";
import SideQuestResolvers from "./SideQuest.js";

const ctx = (id = "u1") => ({ id });
const asUser = (doc: any) => ({ lean: () => Promise.resolve(doc) }) as any;

beforeEach(() => vi.clearAllMocks());

describe("getProductivityData — advanced analytics is Pro-only", () => {
  it("blocks a free user with an upgrade payload and no data", async () => {
    vi.mocked(User.findById).mockReturnValue(asUser({ subscriptionTier: "free" }));
    const res: any = await AnalyticsResolvers.Query.getProductivityData({}, {}, ctx());
    expect(res.needsUpgrade).toBe(true);
    expect(res.success).toBe(false);
    expect(res.weeklyData).toEqual([]);
  });

  it("allows a Pro user through", async () => {
    vi.mocked(User.findById).mockReturnValue(asUser({ subscriptionTier: "pro" }));
    vi.mocked(Analytics.findOne).mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) } as any);
    const res: any = await AnalyticsResolvers.Query.getProductivityData({}, {}, ctx());
    expect(res.success).toBe(true);
    expect(res.needsUpgrade).toBeUndefined();
  });
});

describe("generateSideQuest — AI credits metered for free, unlimited for Pro", () => {
  const sqDoc = {
    _id: { toString: () => "sq1" }, title: "Do a thing", description: "d",
    difficulty: "medium", xpReward: 50, category: "general", completed: false, createdAt: new Date(),
  };

  beforeEach(() => {
    vi.mocked(Shard.countDocuments).mockResolvedValue(0 as any);          // under the <3 side-quest rule
    vi.mocked(SideQuest.findOne).mockReturnValue({ lean: () => Promise.resolve(null) } as any);
    vi.mocked(SideQuest.create).mockResolvedValue(sqDoc as any);
    vi.mocked(breakDownGoalWithAI).mockResolvedValue({ miniQuests: [{ title: "Do a thing", description: "d", xpReward: 50 }], mainQuest: { xpReward: 50 } } as any);
  });

  it("refuses a free user at 0 credits and never calls the AI", async () => {
    vi.mocked(User.findById).mockReturnValue(asUser({ subscriptionTier: "free" }));
    vi.mocked(checkAIUsage).mockResolvedValue({ canProceed: false, limit: 0, used: 0, remaining: 0 });
    const res: any = await SideQuestResolvers.Mutation.generateSideQuest({}, { category: "fitness" }, ctx());
    expect(res.needsUpgrade).toBe(true);
    expect(breakDownGoalWithAI).not.toHaveBeenCalled();
  });

  it("lets a free user with credits through and deducts exactly one", async () => {
    vi.mocked(User.findById).mockReturnValue(asUser({ subscriptionTier: "free" }));
    vi.mocked(checkAIUsage).mockResolvedValue({ canProceed: true, limit: 5, used: 0, remaining: 5 });
    const res: any = await SideQuestResolvers.Mutation.generateSideQuest({}, { category: "fitness" }, ctx());
    expect(res.success).toBe(true);
    expect(trackAIUsage).toHaveBeenCalledTimes(1);
  });

  it("lets a Pro user through without spending credits", async () => {
    vi.mocked(User.findById).mockReturnValue(asUser({ subscriptionTier: "pro" }));
    const res: any = await SideQuestResolvers.Mutation.generateSideQuest({}, { category: "fitness" }, ctx());
    expect(res.success).toBe(true);
    expect(checkAIUsage).not.toHaveBeenCalled();
    expect(trackAIUsage).not.toHaveBeenCalled();
  });
});
