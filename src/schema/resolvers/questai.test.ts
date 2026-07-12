import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../models/Shard.js", () => ({ default: { findById: vi.fn() } }));
vi.mock("../../models/MiniGoal.js", () => ({ default: { find: vi.fn() } }));
vi.mock("../../models/User.js", () => ({ User: { findById: vi.fn() } }));
vi.mock("../../models/Chat.js", () => ({
  default: { findOne: vi.fn(), findById: vi.fn(), create: vi.fn() },
  Message: { find: vi.fn(), create: vi.fn(), findById: vi.fn() },
}));
vi.mock("../../Helpers/AIHelper.js", () => ({ chatAboutShard: vi.fn() }));
vi.mock("../../Helpers/ContentModerator.js", () => ({ moderate: vi.fn(() => ({ allowed: true })) }));
vi.mock("../../Helpers/Cache.js", () => ({ cacheInvalidate: { shard: vi.fn(async () => {}) } }));
vi.mock("./Shard.js", () => ({
  default: { Mutation: { addTask: vi.fn(async () => ({ success: true })), updateTask: vi.fn(), deleteTask: vi.fn(), addMiniGoal: vi.fn(), updateMiniGoal: vi.fn(), updateShard: vi.fn() } },
}));

import Shard from "../../models/Shard.js";
import MiniGoal from "../../models/MiniGoal.js";
import { User } from "../../models/User.js";
import Chat, { Message } from "../../models/Chat.js";
import { chatAboutShard } from "../../Helpers/AIHelper.js";
import ShardResolvers from "./Shard.js";
import QuestAI from "./QuestAI.js";

const ctx = (id = "owner1") => ({ id });
const leanOf = (v: any) => ({ lean: () => Promise.resolve(v) });
const shardDoc = (owner = "owner1") => ({ _id: "s1", title: "Ship it", description: "d", progress: { completion: 10 }, owner, participants: [] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Shard.findById).mockReturnValue(leanOf(shardDoc()) as any);
  vi.mocked(MiniGoal.find).mockReturnValue({ sort: () => leanOf([]) } as any);
  vi.mocked(Message.find).mockReturnValue({ sort: () => ({ limit: () => leanOf([]) }) } as any);
  vi.mocked(Message.create).mockResolvedValue({ _id: { toString: () => "m1" }, type: "ai_proposal", content: "x", createdAt: new Date(), aiProposal: { status: "pending", summary: "s", actions: [] } } as any);
});

describe("chatWithQuestAI — Pro gate", () => {
  it("blocks a free user and never calls the AI", async () => {
    vi.mocked(User.findById).mockReturnValue(leanOf({ subscriptionTier: "free" }) as any);
    const res: any = await QuestAI.Mutation.chatWithQuestAI({}, { shardId: "s1", message: "help" }, ctx());
    expect(res.needsUpgrade).toBe(true);
    expect(chatAboutShard).not.toHaveBeenCalled();
  });

  it("lets a Pro user chat (explain, no proposal)", async () => {
    vi.mocked(User.findById).mockReturnValue(leanOf({ subscriptionTier: "pro" }) as any);
    vi.mocked(Chat.findOne).mockResolvedValue(null as any);
    vi.mocked(Chat.create).mockResolvedValue({ _id: { toString: () => "c1" } } as any);
    vi.mocked(chatAboutShard).mockResolvedValue({ reply: "Here's how...", proposal: null });
    const res: any = await QuestAI.Mutation.chatWithQuestAI({}, { shardId: "s1", message: "explain goal 1" }, ctx());
    expect(res.success).toBe(true);
    expect(res.reply).toBe("Here's how...");
    expect(res.proposal).toBeNull();
    // user message + ai_reply persisted (no proposal message)
    expect(Message.create).toHaveBeenCalledTimes(2);
  });
});

describe("applyQuestAISuggestion — fans out to existing resolvers", () => {
  const makeProposalDoc = (owner = "owner1") => {
    const doc: any = {
      type: "ai_proposal",
      chatId: "c1",
      aiProposal: { status: "pending", actions: [{ op: "addTask", miniGoalId: { toString: () => "mg1" }, payload: { title: "New task" } }] },
      save: vi.fn(async () => {}),
    };
    return doc;
  };

  it("applies actions for the owner and marks the proposal applied", async () => {
    const doc = makeProposalDoc();
    vi.mocked(Message.findById).mockResolvedValue(doc as any);
    vi.mocked(Chat.findById).mockReturnValue(leanOf({ shardId: "s1" }) as any);
    vi.mocked(Shard.findById).mockReturnValue(leanOf(shardDoc("owner1")) as any);
    const res: any = await QuestAI.Mutation.applyQuestAISuggestion({}, { messageId: "m1" }, ctx("owner1"));
    expect(res.success).toBe(true);
    expect(res.applied).toContain("addTask");
    expect(ShardResolvers.Mutation.addTask).toHaveBeenCalledTimes(1);
    expect(doc.aiProposal.status).toBe("applied");
    expect(doc.save).toHaveBeenCalled();
  });

  it("rejects a non-owner and applies nothing", async () => {
    const doc = makeProposalDoc();
    vi.mocked(Message.findById).mockResolvedValue(doc as any);
    vi.mocked(Chat.findById).mockReturnValue(leanOf({ shardId: "s1" }) as any);
    vi.mocked(Shard.findById).mockReturnValue(leanOf(shardDoc("someoneElse")) as any);
    const res: any = await QuestAI.Mutation.applyQuestAISuggestion({}, { messageId: "m1" }, ctx("owner1"));
    expect(res.success).toBe(false);
    expect(ShardResolvers.Mutation.addTask).not.toHaveBeenCalled();
  });
});

describe("dismissQuestAISuggestion — authorization (IDOR guard)", () => {
  const makeDoc = () => ({ type: "ai_proposal", chatId: "c1", aiProposal: { status: "pending", actions: [] }, save: vi.fn(async () => {}) });

  it("lets a chat participant dismiss their proposal", async () => {
    const doc = makeDoc();
    vi.mocked(Message.findById).mockResolvedValue(doc as any);
    vi.mocked(Chat.findById).mockReturnValue(leanOf({ participants: ["owner1"] }) as any);
    const res: any = await QuestAI.Mutation.dismissQuestAISuggestion({}, { messageId: "m1" }, ctx("owner1"));
    expect(res.success).toBe(true);
    expect(doc.aiProposal.status).toBe("dismissed");
  });

  it("rejects a user who is not a participant and leaves status unchanged", async () => {
    const doc = makeDoc();
    vi.mocked(Message.findById).mockResolvedValue(doc as any);
    vi.mocked(Chat.findById).mockReturnValue(leanOf({ participants: ["owner1"] }) as any);
    const res: any = await QuestAI.Mutation.dismissQuestAISuggestion({}, { messageId: "m1" }, ctx("intruder"));
    expect(res.success).toBe(false);
    expect(doc.aiProposal.status).toBe("pending");
    expect(doc.save).not.toHaveBeenCalled();
  });
});
