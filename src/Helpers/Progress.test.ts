import { describe, it, expect, vi } from "vitest";

vi.mock("../models/MiniGoal.js", () => ({ default: { find: vi.fn() } }));
vi.mock("../models/Shard.js", () => ({ default: { findByIdAndUpdate: vi.fn() } }));

import {
  taskXPValue,
  miniGoalProgress,
  allTasksComplete,
  earlyCompletionBonus,
  cadencePeriodKey,
  previousCadencePeriodKey,
  isoWeekKey,
  shardCompletionXP,
  DEFAULT_TASK_XP,
  EARLY_BONUS_MAX_DAYS,
  EARLY_BONUS_XP_PER_DAY,
} from "./Progress.js";

describe("taskXPValue", () => {
  it("uses the task's own reward", () => {
    expect(taskXPValue({ xpReward: 75 })).toBe(75);
  });

  it("falls back for missing or nonsense values", () => {
    expect(taskXPValue(undefined)).toBe(DEFAULT_TASK_XP);
    expect(taskXPValue({})).toBe(DEFAULT_TASK_XP);
    expect(taskXPValue({ xpReward: 0 })).toBe(DEFAULT_TASK_XP);
    expect(taskXPValue({ xpReward: -5 })).toBe(DEFAULT_TASK_XP);
    expect(taskXPValue({ xpReward: NaN })).toBe(DEFAULT_TASK_XP);
  });

  it("clamps so a bad AI response can't mint XP", () => {
    expect(taskXPValue({ xpReward: 999_999 })).toBe(500);
    expect(taskXPValue({ xpReward: 1 })).toBe(5);
  });
});

describe("miniGoalProgress", () => {
  it("weights by effort rather than counting tasks", () => {
    // Finishing the one big task is most of the work, even though it's 1 of 2.
    const tasks = [
      { xpReward: 100, completed: true },
      { xpReward: 20, completed: false },
    ];
    expect(miniGoalProgress(tasks)).toBe(83);
  });

  it("is 0 with no tasks and 100 when all are done", () => {
    expect(miniGoalProgress([])).toBe(0);
    expect(miniGoalProgress([{ completed: true }, { completed: true }])).toBe(100);
  });

  it("ignores soft-deleted tasks entirely", () => {
    const tasks = [
      { xpReward: 20, completed: true },
      { xpReward: 20, completed: false, deleted: true },
    ];
    // The deleted one shouldn't hold progress back at 50%.
    expect(miniGoalProgress(tasks)).toBe(100);
  });

  it("treats an all-deleted mini-goal as empty rather than complete", () => {
    expect(miniGoalProgress([{ deleted: true, completed: false }])).toBe(0);
    expect(allTasksComplete([{ deleted: true, completed: false }])).toBe(false);
  });
});

describe("earlyCompletionBonus", () => {
  it("pays per day early", () => {
    const due = new Date("2026-07-30T12:00:00Z");
    const done = new Date("2026-07-27T12:00:00Z");
    const bonus = earlyCompletionBonus(due, done, "UTC");
    expect(bonus).toMatchObject({ isEarly: true, daysEarly: 3, bonusXP: 3 * EARLY_BONUS_XP_PER_DAY });
  });

  it("pays nothing on time or late", () => {
    const due = new Date("2026-07-27T12:00:00Z");
    expect(earlyCompletionBonus(due, new Date("2026-07-27T09:00:00Z"), "UTC").isEarly).toBe(false);
    expect(earlyCompletionBonus(due, new Date("2026-07-29T09:00:00Z"), "UTC").isEarly).toBe(false);
  });

  it("caps the bonus so a distant due date isn't a jackpot", () => {
    const due = new Date("2027-07-27T12:00:00Z");
    const bonus = earlyCompletionBonus(due, new Date("2026-07-27T12:00:00Z"), "UTC");
    expect(bonus.bonusXP).toBe(EARLY_BONUS_MAX_DAYS * EARLY_BONUS_XP_PER_DAY);
  });

  it("has no bonus without a due date", () => {
    expect(earlyCompletionBonus(undefined, new Date(), "UTC").isEarly).toBe(false);
  });
});

describe("habit cadence keys", () => {
  it("gates daily habits per day", () => {
    const at = new Date("2026-07-27T15:00:00Z");
    expect(cadencePeriodKey("daily", "UTC", at)).toBe("2026-07-27");
    expect(previousCadencePeriodKey("daily", "UTC", at)).toBe("2026-07-26");
  });

  it("gates weekly habits per ISO week", () => {
    const monday = new Date("2026-07-27T15:00:00Z");
    const sunday = new Date("2026-08-02T15:00:00Z"); // same ISO week
    expect(cadencePeriodKey("weekly", "UTC", monday)).toBe(
      cadencePeriodKey("weekly", "UTC", sunday)
    );
    expect(previousCadencePeriodKey("weekly", "UTC", monday)).not.toBe(
      cadencePeriodKey("weekly", "UTC", monday)
    );
  });

  it("treats an unset or custom cadence as daily, so it still can't double-count", () => {
    const at = new Date("2026-07-27T15:00:00Z");
    expect(cadencePeriodKey(undefined, "UTC", at)).toBe("2026-07-27");
    expect(cadencePeriodKey("custom", "UTC", at)).toBe("2026-07-27");
  });

  it("puts a year-boundary week in the right ISO year", () => {
    // 2026-12-31 is a Thursday, so it belongs to week 53 of 2026.
    expect(isoWeekKey("2026-12-31")).toBe("2026-W53");
    // 2027-01-01 is a Friday of that same ISO week.
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
  });

  it("keys by the user's clock, so a late-night check-in isn't tomorrow's", () => {
    const at = new Date("2026-07-28T04:00:00Z"); // 21:00 on the 27th in LA
    expect(cadencePeriodKey("daily", "America/Los_Angeles", at)).toBe("2026-07-27");
  });
});

describe("shardCompletionXP", () => {
  it("pays the shard's declared reward", () => {
    const payout = shardCompletionXP([{ type: "xp", value: 400 }], { onTime: false, completion: 100 });
    expect(payout).toMatchObject({ base: 400, onTimeBonus: 0, total: 400 });
  });

  it("adds a bonus for finishing on time", () => {
    const payout = shardCompletionXP([{ type: "xp", value: 400 }], { onTime: true, completion: 100 });
    expect(payout).toMatchObject({ base: 400, onTimeBonus: 100, total: 500 });
  });

  /**
   * Regression (2026-07-27 audit): the payout ignored `completion`, so
   * `completeShard` was an XP printer — create a quest, finish it at 0%, collect
   * the full reward, repeat.
   */
  it("pays nothing for a quest with no work done", () => {
    expect(shardCompletionXP([{ type: "xp", value: 400 }], { onTime: true, completion: 0 }).total).toBe(0);
  });

  it("scales with how much was actually completed", () => {
    const at = (c: number) =>
      shardCompletionXP([{ type: "xp", value: 400 }], { onTime: true, completion: c }).total;
    expect(at(50)).toBe(250);
    expect(at(25)).toBeLessThan(at(50));
    expect(at(50)).toBeLessThan(at(100));
  });

  it("clamps a completion outside 0-100", () => {
    expect(shardCompletionXP([{ type: "xp", value: 400 }], { onTime: false, completion: 150 }).total).toBe(400);
    expect(shardCompletionXP([{ type: "xp", value: 400 }], { onTime: false, completion: -20 }).total).toBe(0);
  });

  it("falls back when the reward is missing or unusable", () => {
    expect(shardCompletionXP(undefined, { onTime: false, completion: 100 }).base).toBe(200);
    expect(shardCompletionXP([], { onTime: false, completion: 100 }).base).toBe(200);
    expect(
      shardCompletionXP([{ type: "badge", value: "gold" }], { onTime: false, completion: 100 }).base
    ).toBe(200);
    expect(
      shardCompletionXP([{ type: "xp", value: "nonsense" }], { onTime: false, completion: 100 }).base
    ).toBe(200);
  });

  it("clamps an absurd declared reward", () => {
    expect(
      shardCompletionXP([{ type: "xp", value: 10_000_000 }], { onTime: false, completion: 100 }).base
    ).toBe(2000);
  });
});
