import { describe, it, expect, vi } from "vitest";

// CronJobs boots BullMQ + Redis at module load — stub the infra so importing the
// pure filter doesn't open any connection.
vi.mock("bullmq", () => ({
  Queue: class { add() {} },
  Worker: class { on() {} },
  Job: class {},
}));
vi.mock("./Queue.js", () => ({ connection: {} }));

import { trialEndingReminderFilter } from "./CronJobs.js";

describe("trialEndingReminderFilter", () => {
  it("targets only free, un-reminded users whose trial ends within the horizon", () => {
    const now = new Date("2026-07-12T12:00:00Z");
    const f: any = trialEndingReminderFilter(now, 36);
    expect(f.subscriptionTier).toBe("free");
    expect(f.trialReminderSent).toEqual({ $ne: true });
    expect(f.trialEndsAt.$gt).toEqual(now);
    // upper bound = now + 36h
    expect(f.trialEndsAt.$lte).toEqual(new Date(now.getTime() + 36 * 60 * 60 * 1000));
  });

  it("excludes already-expired trials (lower bound is now)", () => {
    const now = new Date();
    const f: any = trialEndingReminderFilter(now);
    // A trial that ended in the past is < now, so it fails the $gt:now bound.
    const expired = new Date(now.getTime() - 60 * 60 * 1000);
    expect(expired.getTime() > f.trialEndsAt.$gt.getTime()).toBe(false);
  });
});
