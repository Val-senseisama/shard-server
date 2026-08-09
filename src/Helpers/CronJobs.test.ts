import { describe, it, expect, vi } from "vitest";

// CronJobs registers node-cron schedules at init (not at module load), so nothing
// needs stubbing to import the pure filter. The BullMQ/Redis stubs that used to
// live here went away with the queue — see Helpers/Queue.ts for why.
vi.mock("node-cron", () => ({
  default: { schedule: vi.fn(() => ({ stop: vi.fn() })) },
}));

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
