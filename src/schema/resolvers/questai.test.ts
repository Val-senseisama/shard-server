import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../models/Shard.js", () => ({ default: { findById: vi.fn() } }));
vi.mock("../../models/MiniGoal.js", () => ({ default: { find: vi.fn() } }));
vi.mock("../../models/User.js", () => ({ User: { findById: vi.fn() } }));
vi.mock("../../models/Chat.js", () => ({
  default: { findOne: vi.fn(), findById: vi.fn(), create: vi.fn() },
  Message: { find: vi.fn(), create: vi.fn(), findById: vi.fn(), countDocuments: vi.fn(async () => 0) },
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
import QuestAI, { COACH_DAILY_MESSAGE_CAP } from "./QuestAI.js";

const ctx = (id = "owner1") => ({ id });
// Chainable stub: callers mix .lean() and .select().lean().
const leanOf = (v: any): any => {
  const q: any = { lean: () => Promise.resolve(v) };
  q.select = () => q;
  q.sort = () => q;
  return q;
};
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

describe("chatWithQuestAI — daily cost ceiling", () => {
  // Pro means unlimited quests, not unlimited inference: this path runs the 70B
  // model per message, so the tail has to be bounded.
  beforeEach(() => {
    vi.mocked(User.findById).mockReturnValue(leanOf({ subscriptionTier: "pro" }) as any);
    vi.mocked(Chat.findOne).mockResolvedValue({ _id: { toString: () => "c1" } } as any);
    vi.mocked(chatAboutShard).mockResolvedValue({ reply: "ok", proposal: null });
  });

  it("blocks a Pro user past the cap and never calls the model", async () => {
    vi.mocked(Message.countDocuments).mockResolvedValue(COACH_DAILY_MESSAGE_CAP as any);

    const res: any = await QuestAI.Mutation.chatWithQuestAI({}, { shardId: "s1", message: "hi" }, ctx());

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/limit/i);
    expect(chatAboutShard).not.toHaveBeenCalled();
    expect(Message.create).not.toHaveBeenCalled();
  });

  it("lets a Pro user through one message below the cap", async () => {
    vi.mocked(Message.countDocuments).mockResolvedValue((COACH_DAILY_MESSAGE_CAP - 1) as any);

    const res: any = await QuestAI.Mutation.chatWithQuestAI({}, { shardId: "s1", message: "hi" }, ctx());

    expect(res.success).toBe(true);
    expect(chatAboutShard).toHaveBeenCalledTimes(1);
  });

  it("counts generated replies, not messages typed — that is what costs money", async () => {
    vi.mocked(Message.countDocuments).mockResolvedValue(0 as any);

    await QuestAI.Mutation.chatWithQuestAI({}, { shardId: "s1", message: "hi" }, ctx());

    const query = vi.mocked(Message.countDocuments).mock.calls[0][0] as any;
    expect(query.type).toBe("ai_reply");
    expect(query.sender).toBe("owner1");
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
  // sender = who asked the question that produced this proposal
  const makeDoc = (sender = "owner1") => ({
    type: "ai_proposal",
    chatId: "c1",
    sender: { toString: () => sender },
    aiProposal: { status: "pending", actions: [] },
    save: vi.fn(async () => {}),
  });

  it("lets whoever asked dismiss their own proposal", async () => {
    const doc = makeDoc("owner1");
    vi.mocked(Message.findById).mockResolvedValue(doc as any);
    vi.mocked(Chat.findById).mockReturnValue(leanOf({ participants: ["owner1"], shardId: "s1" }) as any);
    const res: any = await QuestAI.Mutation.dismissQuestAISuggestion({}, { messageId: "m1" }, ctx("owner1"));
    expect(res.success).toBe(true);
    expect(doc.aiProposal.status).toBe("dismissed");
  });

  it("lets the quest owner dismiss a proposal someone else asked for", async () => {
    const doc = makeDoc("collab1");
    vi.mocked(Message.findById).mockResolvedValue(doc as any);
    vi.mocked(Chat.findById).mockReturnValue(leanOf({ participants: ["owner1", "collab1"], shardId: "s1" }) as any);
    vi.mocked(Shard.findById).mockReturnValue(leanOf({ owner: { toString: () => "owner1" } }) as any);

    const res: any = await QuestAI.Mutation.dismissQuestAISuggestion({}, { messageId: "m1" }, ctx("owner1"));

    expect(res.success).toBe(true);
    expect(doc.aiProposal.status).toBe("dismissed");
  });

  // Now that proposals land in the shared quest chat, plain membership is not
  // enough — a collaborator could otherwise bin a plan change the owner is still
  // weighing, and the card afterwards just reads "dismissed".
  it("rejects a collaborator who neither owns the quest nor asked", async () => {
    const doc = makeDoc("owner1");
    vi.mocked(Message.findById).mockResolvedValue(doc as any);
    vi.mocked(Chat.findById).mockReturnValue(leanOf({ participants: ["owner1", "collab1"], shardId: "s1" }) as any);
    vi.mocked(Shard.findById).mockReturnValue(leanOf({ owner: { toString: () => "owner1" } }) as any);

    const res: any = await QuestAI.Mutation.dismissQuestAISuggestion({}, { messageId: "m1" }, ctx("collab1"));

    expect(res.success).toBe(false);
    expect(doc.aiProposal.status).toBe("pending");
    expect(doc.save).not.toHaveBeenCalled();
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
