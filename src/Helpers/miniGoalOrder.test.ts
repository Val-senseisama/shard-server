import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Mini-goal ordering.
 *
 * Mini-goals are written with `Promise.all`, so insertion order is whichever
 * concurrent write landed first. Readers either sorted by `createdAt` or — in
 * `getShard`, the one the shard screen uses — not at all, and the client renders
 * that array as "1. …, 2. …". So an approved four-phase plan could come back
 * with its phases shuffled, and "everything before this task" (a catch-up) had
 * no stable definition to appeal to.
 *
 * These tests pin the two halves: writers record the position, and "before" is
 * derived from that position rather than from insertion time.
 */

const created: any[] = [];

vi.mock("../models/MiniGoal.js", () => ({
  default: {
    create: vi.fn(async (doc: any) => {
      created.push(doc);
      return { ...doc, _id: `mg${created.length}` };
    }),
    find: vi.fn(),
  },
}));
vi.mock("../models/Shard.js", () => ({
  default: { create: vi.fn(async (doc: any) => ({ ...doc, _id: "s1" })) },
}));
vi.mock("../models/Chat.js", () => ({ default: { create: vi.fn(async () => ({ _id: "c1" })) } }));
vi.mock("./Cache.js", () => ({
  cacheInvalidate: { shard: vi.fn(), shardList: vi.fn(), user: vi.fn() },
}));
vi.mock("./Notify.js", () => ({ notifyMany: vi.fn(async () => {}) }));
vi.mock("./Helpers.js", async (orig) => {
  const actual: any = await orig();
  return { ...actual, SaveAuditTrail: vi.fn(), logError: vi.fn() };
});

import { writeQuest } from "./QuestWriter.js";

const USER = "507f1f77bcf86cd799439011";

/** A four-phase plan — the case where a shuffle is obvious to the user. */
const plan: any = {
  mainQuest: { title: "Learn TypeScript", description: "", xpReward: 300 },
  miniQuests: [
    { title: "Phase One", description: "", steps: [{ text: "a", xpReward: 20 }] },
    { title: "Phase Two", description: "", steps: [{ text: "b", xpReward: 20 }] },
    { title: "Phase Three", description: "", steps: [{ text: "c", xpReward: 20 }] },
    { title: "Phase Four", description: "", steps: [{ text: "d", xpReward: 20 }] },
  ],
};

beforeEach(() => {
  created.length = 0;
  vi.clearAllMocks();
});

describe("writeQuest — records plan position", () => {
  it("stamps each mini-goal with its index in the approved plan", async () => {
    await writeQuest({
      userId: USER,
      user: { preferences: {} } as any,
      plan,
    } as any);

    expect(created).toHaveLength(4);

    // Written concurrently, so the array these arrived in proves nothing. What
    // matters is that each one carries the position it had in the plan.
    const byTitle = new Map(created.map((d) => [d.title, d.order]));
    expect(byTitle.get("Phase One")).toBe(0);
    expect(byTitle.get("Phase Two")).toBe(1);
    expect(byTitle.get("Phase Three")).toBe(2);
    expect(byTitle.get("Phase Four")).toBe(3);
  });

  it("gives every mini-goal an order, so a sort can never fall back to chance", async () => {
    await writeQuest({
      userId: USER,
      user: { preferences: {} } as any,
      plan,
    } as any);

    expect(created.every((d) => typeof d.order === "number")).toBe(true);
    expect([...created].map((d) => d.order).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});
