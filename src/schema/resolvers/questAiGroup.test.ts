import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for routing the AI Quest Coach through the quest group chat, and for
 * scoping a question to a single mini-goal or task.
 *
 * The behaviour that matters:
 *   - a collaborative quest posts into the SHARED chat so participants see it
 *   - a solo quest (no group chat) still gets a private coach thread
 *   - the Pro gate applies to the ASKER, not to readers
 *   - a scoped question sends the model that task, not the whole quest
 *   - a mini-goal id from another quest is rejected, not silently widened
 */

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
vi.mock("./Shard.js", () => ({ default: { Mutation: {} } }));

const emitted: any[] = [];
vi.mock("./Chat.js", () => ({
  getSocketIO: () => ({
    to: (room: string) => ({
      emit: (event: string, payload: any) => emitted.push({ room, event, payload }),
    }),
  }),
}));

import Shard from "../../models/Shard.js";
import MiniGoal from "../../models/MiniGoal.js";
import { User } from "../../models/User.js";
import Chat, { Message } from "../../models/Chat.js";
import { chatAboutShard } from "../../Helpers/AIHelper.js";
import QuestAI from "./QuestAI.js";

const OWNER = "owner1";
const PARTNER = "partner1";
const GROUP_CHAT = "gc1";

const chain = (v: any): any => {
  const q: any = { lean: () => Promise.resolve(v) };
  q.select = () => q;
  q.sort = () => q;
  q.limit = () => q;
  return q;
};

const shardDoc = (over: any = {}) => ({
  _id: "s1",
  title: "Run a marathon",
  description: "d",
  progress: { completion: 20 },
  owner: OWNER,
  participants: [{ user: PARTNER, role: "accountability_partner" }],
  ...over,
});

const miniGoals = [
  {
    _id: { toString: () => "mg1" },
    title: "Base building",
    completed: false,
    tasks: [
      { title: "Run 5k", completed: false, dueDate: new Date("2026-08-20") },
      { title: "Run 10k", completed: true },
      { title: "deleted one", deleted: true },
    ],
  },
  {
    _id: { toString: () => "mg2" },
    title: "Speed work",
    completed: false,
    tasks: [{ title: "Intervals", completed: false }],
  },
];

beforeEach(() => {
  emitted.length = 0;
  vi.clearAllMocks();
  vi.mocked(User.findById).mockReturnValue(chain({ subscriptionTier: "pro", username: "val" }));
  vi.mocked(MiniGoal.find).mockReturnValue(chain(miniGoals));
  vi.mocked(Message.find).mockReturnValue(chain([]));
  vi.mocked(Message.countDocuments).mockResolvedValue(0 as any);
  vi.mocked(Message.create).mockImplementation(
    async (doc: any) => ({ ...doc, _id: { toString: () => "m-new" }, createdAt: new Date() }) as any
  );
  vi.mocked(chatAboutShard).mockResolvedValue({ reply: "Try a slower base pace.", proposal: null });
});

describe("coach routing", () => {
  it("posts into the quest group chat when the quest has one", async () => {
    vi.mocked(Shard.findById).mockReturnValue(chain(shardDoc({ chatId: GROUP_CHAT })));
    vi.mocked(Chat.findById).mockResolvedValue({ _id: { toString: () => GROUP_CHAT } } as any);

    const res: any = await QuestAI.Mutation.chatWithQuestAI(
      {}, { shardId: "s1", message: "how do I pace this?" }, { id: OWNER }
    );

    expect(res.success).toBe(true);
    expect(res.chatId).toBe(GROUP_CHAT);
    // No private coach thread should be created for a collaborative quest.
    expect(Chat.create).not.toHaveBeenCalled();
    expect(Chat.findOne).not.toHaveBeenCalled();
  });

  it("broadcasts the question and the reply so participants see them live", async () => {
    vi.mocked(Shard.findById).mockReturnValue(chain(shardDoc({ chatId: GROUP_CHAT })));
    vi.mocked(Chat.findById).mockResolvedValue({ _id: { toString: () => GROUP_CHAT } } as any);

    await QuestAI.Mutation.chatWithQuestAI(
      {}, { shardId: "s1", message: "how do I pace this?" }, { id: OWNER }
    );

    const types = emitted.map((e) => e.payload.type);
    expect(types).toContain("text");
    expect(types).toContain("ai_reply");
    for (const e of emitted) {
      expect(e.room).toBe(`chat:${GROUP_CHAT}`);
      expect(e.event).toBe("message:new");
    }
  });

  it("falls back to a private thread for a solo quest with no group chat", async () => {
    vi.mocked(Shard.findById).mockReturnValue(chain(shardDoc({ chatId: undefined, participants: [] })));
    vi.mocked(Chat.findOne).mockResolvedValue(null as any);
    vi.mocked(Chat.create).mockResolvedValue({ _id: { toString: () => "ai1" } } as any);

    const res: any = await QuestAI.Mutation.chatWithQuestAI(
      {}, { shardId: "s1", message: "help" }, { id: OWNER }
    );

    expect(res.success).toBe(true);
    expect(Chat.create).toHaveBeenCalledWith(expect.objectContaining({ type: "ai" }));
  });

  it("lets an accountability partner ask, since access is quest membership", async () => {
    vi.mocked(Shard.findById).mockReturnValue(chain(shardDoc({ chatId: GROUP_CHAT })));
    vi.mocked(Chat.findById).mockResolvedValue({ _id: { toString: () => GROUP_CHAT } } as any);

    const res: any = await QuestAI.Mutation.chatWithQuestAI(
      {}, { shardId: "s1", message: "is he on track?" }, { id: PARTNER }
    );

    expect(res.success).toBe(true);
  });

  it("still gates on the asker's own subscription", async () => {
    vi.mocked(Shard.findById).mockReturnValue(chain(shardDoc({ chatId: GROUP_CHAT })));
    vi.mocked(User.findById).mockReturnValue(chain({ subscriptionTier: "free" }));

    const res: any = await QuestAI.Mutation.chatWithQuestAI(
      {}, { shardId: "s1", message: "help" }, { id: PARTNER }
    );

    expect(res.needsUpgrade).toBe(true);
    expect(chatAboutShard).not.toHaveBeenCalled();
  });
});

describe("task scoping", () => {
  beforeEach(() => {
    vi.mocked(Shard.findById).mockReturnValue(chain(shardDoc({ chatId: GROUP_CHAT })));
    vi.mocked(Chat.findById).mockResolvedValue({ _id: { toString: () => GROUP_CHAT } } as any);
  });

  it("sends the model the specific task, not the whole quest", async () => {
    await QuestAI.Mutation.chatWithQuestAI(
      {}, { shardId: "s1", message: "why is this hard?", miniGoalId: "mg1", taskIndex: 0 }, { id: OWNER }
    );

    const [, contextArg] = vi.mocked(chatAboutShard).mock.calls[0];
    expect(contextArg).toContain("THE USER IS ASKING ABOUT THIS TASK");
    expect(contextArg).toContain("Run 5k");
    // A different mini-goal's work is not the subject and shouldn't crowd it out.
    expect(contextArg).not.toContain("Intervals");
  });

  it("includes sibling tasks so advice knows what is already done", async () => {
    await QuestAI.Mutation.chatWithQuestAI(
      {}, { shardId: "s1", message: "next step?", miniGoalId: "mg1", taskIndex: 0 }, { id: OWNER }
    );

    const [, contextArg] = vi.mocked(chatAboutShard).mock.calls[0];
    expect(contextArg).toContain("Run 10k");
    // Soft-deleted work is not context.
    expect(contextArg).not.toContain("deleted one");
  });

  it("scopes to a mini-goal when no task index is given", async () => {
    await QuestAI.Mutation.chatWithQuestAI(
      {}, { shardId: "s1", message: "how's this phase?", miniGoalId: "mg2" }, { id: OWNER }
    );

    const [, contextArg] = vi.mocked(chatAboutShard).mock.calls[0];
    expect(contextArg).toContain("THE USER IS ASKING ABOUT THIS MINI-GOAL");
    expect(contextArg).toContain("Intervals");
  });

  it("uses whole-quest context when nothing is scoped", async () => {
    await QuestAI.Mutation.chatWithQuestAI(
      {}, { shardId: "s1", message: "general help" }, { id: OWNER }
    );

    const [, contextArg] = vi.mocked(chatAboutShard).mock.calls[0];
    expect(contextArg).toContain("Base building");
    expect(contextArg).toContain("Speed work");
  });

  it("rejects a mini-goal id that belongs to another quest instead of widening", async () => {
    const res: any = await QuestAI.Mutation.chatWithQuestAI(
      {}, { shardId: "s1", message: "hi", miniGoalId: "someone-elses-mg" }, { id: OWNER }
    );

    expect(res.success).toBe(false);
    // Silently falling back to whole-quest context would let a bad id probe for
    // which mini-goals exist by watching the answer change.
    expect(chatAboutShard).not.toHaveBeenCalled();
  });
});
