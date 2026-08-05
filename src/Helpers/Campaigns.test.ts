import { describe, it, expect, vi } from "vitest";

vi.mock("../models/User.js", () => ({ User: { findById: vi.fn() } }));
vi.mock("../models/Shard.js", () => ({ default: { find: vi.fn() } }));
vi.mock("../models/MiniGoal.js", () => ({ default: { find: vi.fn() } }));
vi.mock("./Notify.js", () => ({ notify: vi.fn(async () => ({ recorded: true })) }));

import { CAMPAIGNS, type CampaignContext } from "./Campaigns.js";
import { REPAIR_WINDOW_DAYS } from "./Streak.js";

const DAY = 86_400_000;

const ctx = (over: Partial<CampaignContext> = {}): CampaignContext => ({
  userId: "u1",
  timezone: "UTC",
  dayKey: "2026-07-27",
  createdAt: new Date(Date.now() - 30 * DAY),
  lastActive: new Date(),
  daysSinceSignup: 30,
  daysSinceActive: 0,
  openShardCount: 2,
  tasksDueToday: 0,
  tasksOverdue: 0,
  streak: {
    current: 4,
    longest: 9,
    state: "active",
    lastDayKey: "2026-07-27",
    freezesAvailable: 1,
    atRiskToday: false,
  },
  previousStreak: 0,
  ...over,
});

/** The first campaign that matches — that's what the runner would send. */
const winner = (c: CampaignContext) => CAMPAIGNS.find((x) => x.match(c))?.id ?? null;

describe("campaign selection", () => {
  it("prioritises a freshly broken streak over everything else", () => {
    const c = ctx({
      streak: { ...ctx().streak, current: 0 },
      previousStreak: 12,
      streakBrokenAt: new Date(),
      tasksDueToday: 5,
      tasksOverdue: 3,
    });
    expect(winner(c)).toBe("streak_broken");
  });

  it("ignores a break that is past the repair window", () => {
    const c = ctx({
      streak: { ...ctx().streak, current: 0 },
      previousStreak: 12,
      streakBrokenAt: new Date(Date.now() - (REPAIR_WINDOW_DAYS + 2) * DAY),
    });
    expect(winner(c)).not.toBe("streak_broken");
  });

  it("ignores a trivial broken streak — a 1-day streak isn't a loss worth a push", () => {
    const c = ctx({
      streak: { ...ctx().streak, current: 0 },
      previousStreak: 1,
      streakBrokenAt: new Date(),
    });
    expect(winner(c)).not.toBe("streak_broken");
  });

  /**
   * The gap that mattered most: users who signed up and never created a shard
   * were selected by nothing at all, because every nudge keyed off an existing
   * active shard.
   */
  it("reaches a user who signed up and created nothing", () => {
    for (const day of [1, 3, 7]) {
      const c = ctx({ openShardCount: 0, daysSinceSignup: day, daysSinceActive: day });
      expect(winner(c)).toBe("activation");
    }
  });

  it("does not nag activation on off-schedule days", () => {
    const c = ctx({ openShardCount: 0, daysSinceSignup: 4, daysSinceActive: 4 });
    expect(winner(c)).toBeNull();
  });

  it("stops activation once the user has a shard", () => {
    const c = ctx({ openShardCount: 1, daysSinceSignup: 3, daysSinceActive: 3 });
    expect(winner(c)).not.toBe("activation");
  });

  it("wins back dormant users at 7, 14 and 30 days", () => {
    for (const day of [7, 14, 30]) {
      expect(winner(ctx({ daysSinceActive: day }))).toBe("dormant_winback");
    }
  });

  it("asks for a decision on overdue work before offering today's list", () => {
    expect(winner(ctx({ tasksOverdue: 2, tasksDueToday: 4 }))).toBe("tasks_missed");
  });

  it("sends the digest when there is work scheduled today", () => {
    expect(winner(ctx({ tasksDueToday: 3 }))).toBe("daily_digest");
  });

  /**
   * The user the old daily-reminder cron skipped entirely: it only fired when a
   * task already existed for today, so someone with an empty schedule — the one
   * most at risk of drifting away — heard nothing.
   */
  it("reaches a user with shards but an empty schedule", () => {
    const c = ctx({ tasksDueToday: 0, tasksOverdue: 0, daysSinceActive: 3 });
    expect(winner(c)).toBe("empty_schedule");
  });

  it("stays quiet for an active user with a clear day and nothing stale", () => {
    const c = ctx({ daysSinceActive: 0, focusShard: { id: "s1", title: "Ship", staleDays: 0 } });
    expect(winner(c)).toBeNull();
  });

  it("nudges a stalling quest only while the user is still around", () => {
    const stale = { id: "s1", title: "Write the book", staleDays: 9 };
    expect(winner(ctx({ daysSinceActive: 1, focusShard: stale }))).toBe("inactivity_nudge");
    // Long gone: the dormant ladder owns this user, not the per-quest nudge.
    expect(winner(ctx({ daysSinceActive: 14, focusShard: stale }))).toBe("dormant_winback");
  });
});

describe("campaign copy", () => {
  it("quotes the streak that was actually lost", () => {
    const c = ctx({
      streak: { ...ctx().streak, current: 0 },
      previousStreak: 23,
      streakBrokenAt: new Date(),
    });
    const campaign = CAMPAIGNS.find((x) => x.id === "streak_broken")!;
    const msg = campaign.build(c)!;
    expect(msg.body).toContain("23 days");
    expect(msg.title).toContain("23-day");
  });

  it("dedupes a break once per break, not once per day", () => {
    const brokenAt = new Date("2026-07-26T01:00:00Z");
    const c = ctx({
      streak: { ...ctx().streak, current: 0 },
      previousStreak: 5,
      streakBrokenAt: brokenAt,
    });
    const msg = CAMPAIGNS.find((x) => x.id === "streak_broken")!.build(c)!;
    expect(msg.dedupeKey).toBe("break:2026-07-26");
  });

  it("mentions the streak in the digest when there is one to protect", () => {
    const withStreak = CAMPAIGNS.find((x) => x.id === "daily_digest")!.build(
      ctx({ tasksDueToday: 2 })
    )!;
    expect(withStreak.body).toContain("4-day streak");

    const noStreak = CAMPAIGNS.find((x) => x.id === "daily_digest")!.build(
      ctx({ tasksDueToday: 2, streak: { ...ctx().streak, current: 0 } })
    )!;
    expect(noStreak.body).not.toContain("streak");
  });

  it("pluralises overdue copy correctly", () => {
    const one = CAMPAIGNS.find((x) => x.id === "tasks_missed")!.build(ctx({ tasksOverdue: 1 }))!;
    expect(one.title).toBe("1 task slipped");
    expect(one.body).toContain("is past due");

    const many = CAMPAIGNS.find((x) => x.id === "tasks_missed")!.build(ctx({ tasksOverdue: 3 }))!;
    expect(many.title).toBe("3 tasks slipped");
    expect(many.body).toContain("are past due");
  });

  it("gives every campaign a deep link to act on", () => {
    for (const campaign of CAMPAIGNS) {
      // Build with a context permissive enough for each to produce a message.
      const c = ctx({
        openShardCount: 0,
        daysSinceSignup: 1,
        daysSinceActive: 7,
        tasksDueToday: 1,
        tasksOverdue: 1,
        previousStreak: 5,
        streakBrokenAt: new Date(),
        streak: { ...ctx().streak, current: 0 },
        focusShard: { id: "s1", title: "Ship", staleDays: 9 },
      });
      const msg = campaign.build(c);
      if (!msg) continue;
      expect(msg.data?.screen, `${campaign.id} has no deep link`).toBeTruthy();
    }
  });
});
