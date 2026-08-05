import { describe, it, expect, vi } from "vitest";

vi.mock("../models/Shard.js", () => ({ default: { find: vi.fn(), findByIdAndUpdate: vi.fn() } }));
vi.mock("../models/MiniGoal.js", () => ({ default: { find: vi.fn() } }));
vi.mock("./Progress.js", () => ({ recomputeShardProgress: vi.fn() }));

import {
  nextStatus,
  rescheduleTaskFields,
  AT_RISK_AFTER_DAYS,
  STALLED_AFTER_DAYS,
} from "./ShardLifecycle.js";

const DAY = 86_400_000;
const NOW = new Date("2026-07-27T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const shard = (over: Partial<any> = {}) => ({
  status: "active",
  progress: { completion: 40 },
  lastActivityAt: daysAgo(0),
  createdAt: daysAgo(30),
  timeline: {},
  ...over,
});

describe("nextStatus", () => {
  it("keeps a recently active shard active", () => {
    expect(nextStatus(shard({ lastActivityAt: daysAgo(1) }), NOW)).toBe("active");
  });

  it("flags a shard at risk after the idle threshold", () => {
    expect(nextStatus(shard({ lastActivityAt: daysAgo(AT_RISK_AFTER_DAYS) }), NOW)).toBe("at_risk");
  });

  it("flags a long-idle shard as stalled", () => {
    expect(nextStatus(shard({ lastActivityAt: daysAgo(STALLED_AFTER_DAYS) }), NOW)).toBe("stalled");
  });

  it("revives a stalled shard once activity resumes", () => {
    expect(nextStatus(shard({ status: "stalled", lastActivityAt: daysAgo(0) }), NOW)).toBe("active");
  });

  it("auto-completes at 100%, which nothing used to do", () => {
    expect(nextStatus(shard({ progress: { completion: 100 } }), NOW)).toBe("completed");
  });

  it("prefers completion over expiry when both apply", () => {
    const s = shard({ progress: { completion: 100 }, timeline: { endDate: daysAgo(3) } });
    expect(nextStatus(s, NOW)).toBe("completed");
  });

  it("expires an unfinished shard past its end date — the enum value nothing ever wrote", () => {
    expect(nextStatus(shard({ timeline: { endDate: daysAgo(1) } }), NOW)).toBe("expired");
  });

  it("does not expire a shard whose end date is still ahead", () => {
    const future = new Date(NOW.getTime() + 5 * DAY);
    expect(nextStatus(shard({ timeline: { endDate: future } }), NOW)).toBe("active");
  });

  it("never moves terminal or user-chosen states", () => {
    for (const status of ["completed", "expired", "abandoned", "paused"]) {
      expect(nextStatus(shard({ status, lastActivityAt: daysAgo(60) }), NOW)).toBeNull();
    }
  });

  it("falls back to createdAt when a shard has never recorded activity", () => {
    const s = shard({ lastActivityAt: null, createdAt: daysAgo(STALLED_AFTER_DAYS + 1) });
    expect(nextStatus(s, NOW)).toBe("stalled");
  });
});

describe("rescheduleTaskFields", () => {
  it("moves the date and clears the overdue flag", () => {
    const target = new Date("2026-08-01T00:00:00Z");
    const fields = rescheduleTaskFields(target, new Date("2026-07-20T00:00:00Z"));
    expect(fields).toMatchObject({ dueDate: target, rescheduled: true, overdue: false });
    expect(fields.overdueSince).toBeUndefined();
  });

  it("preserves the original due date for reporting", () => {
    const original = new Date("2026-07-20T00:00:00Z");
    expect(rescheduleTaskFields(new Date(), original).originalDueDate).toBe(original);
  });
});
