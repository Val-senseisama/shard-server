import { describe, it, expect, vi } from "vitest";

vi.mock("../models/User.js", () => ({
  User: { findById: vi.fn(), findByIdAndUpdate: vi.fn(async () => ({})), find: vi.fn() },
}));

import {
  evaluateRollover,
  daysBetweenKeys,
  dayKeyOffsetFromKey,
  snapshotOf,
  hasComebackBonus,
  xpMultiplierFor,
  FREEZE_GRACE_DAYS,
  COMEBACK_MULTIPLIER,
} from "./Streak.js";
import { dateKeyInZone } from "./Timezone.js";

const user = (over: Partial<any> = {}) => ({
  _id: { toString: () => "u1" },
  currentStreak: 5,
  longestStreak: 9,
  previousStreak: 0,
  streakFreezeTokens: 0,
  ...over,
});

describe("day keys", () => {
  it("counts whole days between keys", () => {
    expect(daysBetweenKeys("2026-07-27", "2026-07-28")).toBe(1);
    expect(daysBetweenKeys("2026-07-27", "2026-07-27")).toBe(0);
    expect(daysBetweenKeys("2026-07-25", "2026-07-28")).toBe(3);
  });

  it("crosses month and year boundaries", () => {
    expect(daysBetweenKeys("2026-07-31", "2026-08-01")).toBe(1);
    expect(daysBetweenKeys("2026-12-31", "2027-01-01")).toBe(1);
  });

  it("shifts keys without drifting", () => {
    expect(dayKeyOffsetFromKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(dayKeyOffsetFromKey("2026-01-01", -1)).toBe("2025-12-31");
  });

  /**
   * The bug this whole engine exists to prevent: a 9pm completion in UTC-8 is
   * already tomorrow in UTC, so a server-local day boundary credited it to the
   * wrong day and broke streaks that shouldn't have broken.
   */
  it("assigns a late-evening completion to the user's day, not UTC's", () => {
    const ninePmPacific = new Date("2026-07-27T04:00:00Z"); // 21:00 on the 26th in LA
    expect(dateKeyInZone(ninePmPacific, "America/Los_Angeles")).toBe("2026-07-26");
    expect(dateKeyInZone(ninePmPacific, "UTC")).toBe("2026-07-27");
  });
});

describe("evaluateRollover", () => {
  it("leaves a streak alone when today is already secured", () => {
    expect(evaluateRollover(user({ lastStreakDayKey: "2026-07-27" }), "2026-07-27")).toBeNull();
  });

  it("leaves a streak alone when yesterday was secured and today is young", () => {
    expect(evaluateRollover(user({ lastStreakDayKey: "2026-07-26" }), "2026-07-27")).toBeNull();
  });

  it("breaks a streak after a fully missed day with no freezes", () => {
    const outcome = evaluateRollover(user({ lastStreakDayKey: "2026-07-25" }), "2026-07-27");
    expect(outcome).toEqual({
      userId: "u1",
      lostStreak: 5,
      frozen: false,
      freezesRemaining: 0,
    });
  });

  it("spends a freeze instead of breaking, when one is available", () => {
    const outcome = evaluateRollover(
      user({ lastStreakDayKey: "2026-07-25", streakFreezeTokens: 2 }),
      "2026-07-27"
    );
    expect(outcome).toMatchObject({ frozen: true, lostStreak: 5, freezesRemaining: 1 });
  });

  it("will not let a freeze bridge a gap longer than the grace period", () => {
    const tooLong = dayKeyOffsetFromKey("2026-07-27", -(FREEZE_GRACE_DAYS + 3));
    const outcome = evaluateRollover(
      user({ lastStreakDayKey: tooLong, streakFreezeTokens: 3 }),
      "2026-07-27"
    );
    expect(outcome).toMatchObject({ frozen: false });
  });

  it("ignores users with no streak to lose", () => {
    expect(evaluateRollover(user({ currentStreak: 0, lastStreakDayKey: "2026-01-01" }), "2026-07-27")).toBeNull();
  });

  it("ignores users who have never recorded a day", () => {
    expect(evaluateRollover(user({ lastStreakDayKey: undefined }), "2026-07-27")).toBeNull();
  });
});

describe("snapshotOf", () => {
  const today = dateKeyInZone(new Date(), "UTC");
  const yesterday = dayKeyOffsetFromKey(today, -1);

  it("is active when today is secured", () => {
    expect(snapshotOf(user({ timezone: "UTC", lastStreakDayKey: today })).state).toBe("active");
  });

  it("is at_risk when yesterday was secured but today isn't", () => {
    const snap = snapshotOf(user({ timezone: "UTC", lastStreakDayKey: yesterday }));
    expect(snap.state).toBe("at_risk");
    expect(snap.atRiskToday).toBe(true);
  });

  it("reports broken only once a streak has actually been lost", () => {
    expect(
      snapshotOf(user({ timezone: "UTC", currentStreak: 0, previousStreak: 12 })).state
    ).toBe("broken");
    // A brand new user has no streak, but hasn't broken one either.
    expect(
      snapshotOf(user({ timezone: "UTC", currentStreak: 0, previousStreak: 0 })).state
    ).toBe("none");
  });
});

describe("comeback bonus", () => {
  it("applies while live and not after", () => {
    const live = { comebackBonusUntil: new Date(Date.now() + 60_000) };
    const past = { comebackBonusUntil: new Date(Date.now() - 60_000) };
    expect(hasComebackBonus(live)).toBe(true);
    expect(hasComebackBonus(past)).toBe(false);
    expect(xpMultiplierFor(live)).toBe(COMEBACK_MULTIPLIER);
    expect(xpMultiplierFor(past)).toBe(1);
    expect(xpMultiplierFor({})).toBe(1);
  });
});

/**
 * Regression tests for the freeze-economics bug found in the 2026-07-27 audit:
 * an earlier version advanced the day marker on every freeze, which re-armed the
 * grace window each night and burned a user's whole freeze stock while they were
 * away — leaving none for the day they actually returned.
 */
describe("freeze economics", () => {
  const absent = (over: Partial<any> = {}) =>
    user({ currentStreak: 12, streakFreezeTokens: 3, lastStreakDayKey: "2026-07-01", ...over });

  it("spends exactly one freeze across a multi-day absence", () => {
    let u: any = absent();
    let froze = 0;
    let broke = false;

    for (let d = 2; d <= 8; d++) {
      const today = `2026-07-0${d}`;
      const o = evaluateRollover(u, today);
      if (!o) continue;
      if (o.frozen) {
        froze++;
        u = { ...u, streakFreezeTokens: o.freezesRemaining, freezeCoveredThrough: o.coversDayKey };
      } else {
        broke = true;
        break;
      }
    }

    expect(froze).toBe(1);
    expect(broke).toBe(true);
    // Two of three freezes survive for the user's actual return.
    expect(u.streakFreezeTokens).toBe(2);
  });

  it("does not re-charge a gap the rollover already bridged", () => {
    const bridged = absent({ freezeCoveredThrough: "2026-07-02", streakFreezeTokens: 2 });
    expect(evaluateRollover(bridged, "2026-07-03")).toBeNull();
  });

  it("refuses to stack freezes on consecutive misses", () => {
    // Jul 2 was already covered by a freeze; Jul 3 missed too → break, don't freeze.
    const stacked = absent({ freezeCoveredThrough: "2026-07-02", streakFreezeTokens: 2 });
    expect(evaluateRollover(stacked, "2026-07-04")).toMatchObject({ frozen: false });
  });

  it("reports a frozen streak as frozen, not active", () => {
    const today = dateKeyInZone(new Date(), "UTC");
    const snap = snapshotOf(
      user({
        timezone: "UTC",
        currentStreak: 12,
        lastStreakDayKey: dayKeyOffsetFromKey(today, -2),
        freezeCoveredThrough: dayKeyOffsetFromKey(today, -1),
        streakFreezeTokens: 2,
      })
    );
    expect(snap.state).toBe("frozen");
  });
});
