import { describe, it, expect, vi, beforeEach } from "vitest";

const draftDoc = (over: any = {}) => ({
  _id: "draft1",
  userId: { toString: () => "u1" },
  goal: "Run a half marathon",
  plan: {
    mainQuest: { title: "Half marathon", xpReward: 200 },
    miniQuests: [{ id: "mq1", title: "Base building", steps: [{ id: "s1", text: "Easy 5k" }] }],
    warning: null,
  },
  committedShardId: undefined,
  save: vi.fn(async () => {}),
  ...over,
});

// vi.mock is hoisted above const declarations, so anything a factory closes over
// has to be hoisted too.
const {
  QuestDraft,
  writeQuest,
  countActiveShards,
  trackAIUsage,
  breakDownGoalWithAI,
  streamChatCompletion,
} =
  vi.hoisted(() => ({
    QuestDraft: { create: vi.fn(), findById: vi.fn() },
    writeQuest: vi.fn(),
    countActiveShards: vi.fn(async () => 0),
    trackAIUsage: vi.fn(async () => true),
    breakDownGoalWithAI: vi.fn(),
    // Streaming is attempted first; returning null exercises the fallback,
    // which is the path these tests are about.
    streamChatCompletion: vi.fn(async () => null),
  }));

vi.mock("../../models/QuestDraft.js", () => ({ default: QuestDraft }));
vi.mock("../../models/User.js", () => ({
  User: { findById: vi.fn(() => ({ lean: async () => ({ _id: "u1", role: "user", preferences: {} }) })) },
}));
vi.mock("../../Helpers/QuestWriter.js", () => ({ writeQuest: (...a: any[]) => writeQuest(...a) }));
vi.mock("../../Helpers/AIHelper.js", () => ({
  breakDownGoalWithAI: (...a: any[]) => breakDownGoalWithAI(...a),
  checkAIUsage: async () => ({ canProceed: true, limit: 15, used: 0, remaining: 15 }),
  trackAIUsage: (...a: any[]) => trackAIUsage(...a),
  buildQuestUserPrompt: () => "prompt",
  QUEST_ARCHITECT_PROMPT: "system",
}));
vi.mock("../../Helpers/PlanStream.js", () => ({
  streamChatCompletion: (...a: any[]) => streamChatCompletion(...a),
}));
vi.mock("../../Helpers/Refine.js", () => ({ refinePlan: vi.fn(), MAX_REFINEMENTS: 3 }));
vi.mock("./Chat.js", () => ({ getSocketIO: () => null }));
vi.mock("../../server/WebSocketServer.js", () => ({ emitToUser: vi.fn() }));
vi.mock("../../Helpers/Entitlements.js", () => ({
  tierOf: () => "free",
  countActiveShards: (...a: any[]) => countActiveShards(...a),
  upgradeError: (message: string) => ({ success: false, message, needsUpgrade: true }),
  FREE_ACTIVE_SHARD_CAP: 3,
}));
vi.mock("../../Helpers/ContentModerator.js", () => ({ moderate: () => ({ allowed: true }) }));
vi.mock("../../Helpers/Telemetry.js", () => ({ logEvent: vi.fn() }));
vi.mock("./XP.js", () => ({ checkAchievements: vi.fn(async () => {}) }));

import resolvers from "./QuestDraft.js";

const ctx = { id: "u1" };
const { startQuestDraft, commitQuestDraft } = resolvers.Mutation as any;

beforeEach(() => {
  vi.clearAllMocks();
  countActiveShards.mockResolvedValue(0);
  QuestDraft.create.mockImplementation(async (d: any) => ({ ...draftDoc(), ...d, _id: "draft1" }));
  writeQuest.mockResolvedValue({ shardId: "s99", title: "Half marathon", shard: { _id: "s99" } });
  breakDownGoalWithAI.mockResolvedValue({
    mainQuest: { title: "Half marathon", xpReward: 200 },
    miniQuests: [{ title: "Base building", steps: [{ text: "Easy 5k" }, { text: "Rest" }] }],
    warning: null,
  });
});

describe("startQuestDraft", () => {
  it("generates a plan without writing a quest", async () => {
    const res = await startQuestDraft({}, { goal: "Run a half marathon" }, ctx);

    expect(res.success).toBe(true);
    expect(QuestDraft.create).toHaveBeenCalledOnce();
    // The whole point: nothing reaches the user's quest list yet.
    expect(writeQuest).not.toHaveBeenCalled();
  });

  it("gives every mini-quest and step a stable id", async () => {
    const res = await startQuestDraft({}, { goal: "Run a half marathon" }, ctx);
    const mq = res.draft.plan.miniQuests[0];

    // Array position is what changes when you reorder, so identity can't be it.
    expect(mq.id).toMatch(/[0-9a-f-]{36}/);
    expect(mq.steps.map((s: any) => s.id)).toHaveLength(2);
    expect(new Set(mq.steps.map((s: any) => s.id)).size).toBe(2);
  });

  it("spends a credit only after the model returns a plan", async () => {
    breakDownGoalWithAI.mockRejectedValueOnce(new Error("model down"));

    const res = await startQuestDraft({}, { goal: "Run a half marathon" }, ctx);

    expect(res.success).toBe(false);
    expect(trackAIUsage).not.toHaveBeenCalled();
    expect(QuestDraft.create).not.toHaveBeenCalled();
  });

  it("refuses at the free cap before spending a credit", async () => {
    countActiveShards.mockResolvedValue(3);

    const res = await startQuestDraft({}, { goal: "Run a half marathon" }, ctx);

    expect(res.needsUpgrade).toBe(true);
    expect(breakDownGoalWithAI).not.toHaveBeenCalled();
    expect(trackAIUsage).not.toHaveBeenCalled();
  });

  it("rejects a deadline in the past without calling the model", async () => {
    const res = await startQuestDraft(
      {},
      { goal: "Run a half marathon", deadline: "2020-01-01" },
      ctx
    );

    expect(res.success).toBe(false);
    expect(breakDownGoalWithAI).not.toHaveBeenCalled();
  });
});

describe("commitQuestDraft", () => {
  it("writes the quest once", async () => {
    const d = draftDoc();
    QuestDraft.findById.mockResolvedValue(d);

    const res = await commitQuestDraft({}, { draftId: "draft1" }, ctx);

    expect(res.success).toBe(true);
    expect(res.shard.id).toBe("s99");
    expect(writeQuest).toHaveBeenCalledOnce();
    expect(d.committedShardId).toBe("s99");
  });

  it("is idempotent — a second commit returns the same quest", async () => {
    // A double-tap on a slow connection must not produce two quests.
    QuestDraft.findById.mockResolvedValue(
      draftDoc({ committedShardId: { toString: () => "s99" } })
    );

    const res = await commitQuestDraft({}, { draftId: "draft1" }, ctx);

    expect(res.success).toBe(true);
    expect(res.shard.id).toBe("s99");
    expect(writeQuest).not.toHaveBeenCalled();
  });

  it("refuses someone else's draft", async () => {
    QuestDraft.findById.mockResolvedValue(draftDoc({ userId: { toString: () => "someone-else" } }));

    const res = await commitQuestDraft({}, { draftId: "draft1" }, ctx);

    expect(res.success).toBe(false);
    expect(writeQuest).not.toHaveBeenCalled();
  });

  it("tells the user plainly when the draft has expired", async () => {
    QuestDraft.findById.mockResolvedValue(null);

    const res = await commitQuestDraft({}, { draftId: "gone" }, ctx);

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/expired/i);
  });

  it("enforces the free cap at commit, with the plan already on screen", async () => {
    QuestDraft.findById.mockResolvedValue(draftDoc());
    countActiveShards.mockResolvedValue(3);

    const res = await commitQuestDraft({}, { draftId: "draft1" }, ctx);

    expect(res.needsUpgrade).toBe(true);
    expect(writeQuest).not.toHaveBeenCalled();
  });

  it("refuses to create a quest with no phases", async () => {
    QuestDraft.findById.mockResolvedValue(
      draftDoc({ plan: { mainQuest: { title: "x" }, miniQuests: [] } })
    );

    const res = await commitQuestDraft({}, { draftId: "draft1" }, ctx);

    expect(res.success).toBe(false);
    expect(writeQuest).not.toHaveBeenCalled();
  });
});
