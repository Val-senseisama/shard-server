import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the node-cron scheduler that replaced the BullMQ repeatable queue.
 *
 * The queue was removed because BullMQ needs `maxmemory-policy noeviction` and
 * the Redis Cloud free plan runs `volatile-lru` — meaning it could silently drop
 * scheduled jobs, and every retention touchpoint rides on them. See the comment
 * on SCHEDULED_JOBS in CronJobs.ts.
 *
 * Two properties matter here and neither existed before:
 *   1. every pattern is a valid cron expression (a typo used to be a silent no-op)
 *   2. a slow job cannot overlap its own next tick (BullMQ enforced this; node-cron
 *      fires on the clock regardless, and two copies of a sweep would double-send)
 */

const scheduled: { pattern: string; fn: () => void; options: any }[] = [];

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((pattern: string, fn: () => void, options: any) => {
      scheduled.push({ pattern, fn, options });
      return { stop: vi.fn() };
    }),
  },
}));

import cron from "node-cron";
import { initScheduledJobs, closeScheduledJobs } from "./CronJobs.js";

// Matches standard 5-field cron, including */n, ranges and lists.
const FIELD = String.raw`(\*|\d+)(-\d+)?(\/\d+)?(,(\d+)(-\d+)?(\/\d+)?)*`;
const CRON_5 = new RegExp(`^${FIELD}( ${FIELD}){4}$`);

beforeEach(() => {
  scheduled.length = 0;
  vi.clearAllMocks();
});

describe("initScheduledJobs", () => {
  it("registers every job with a valid 5-field cron pattern", async () => {
    await initScheduledJobs();

    expect(scheduled.length).toBeGreaterThan(0);
    for (const { pattern } of scheduled) {
      expect(pattern, `invalid cron pattern: "${pattern}"`).toMatch(CRON_5);
    }
  });

  it("pins every job to UTC", async () => {
    await initScheduledJobs();

    // The patterns are written in UTC. Inheriting the host timezone would shift
    // the entire schedule silently — and these jobs decide what time it is for
    // every user.
    for (const { options } of scheduled) {
      expect(options?.timezone).toBe("UTC");
    }
  });

  it("schedules the hourly timezone-bucketed jobs, not fixed daily UTC ones", async () => {
    await initScheduledJobs();

    const patterns = scheduled.map((s) => s.pattern);
    // local-morning / local-evening / streak-rollover must run EVERY hour so each
    // one can select the users whose own clock currently reads the target hour.
    expect(patterns).toContain("5 * * * *");
    expect(patterns).toContain("10 * * * *");
    expect(patterns).toContain("15 * * * *");
  });

  it("stops every task on shutdown so cron timers can't outlive the drain", async () => {
    await initScheduledJobs();
    const stops = vi.mocked(cron.schedule).mock.results.map((r: any) => r.value.stop);

    await closeScheduledJobs();

    for (const stop of stops) expect(stop).toHaveBeenCalled();
  });

  it("is idempotent across restarts — closing then re-initialising re-registers cleanly", async () => {
    await initScheduledJobs();
    const first = scheduled.length;

    await closeScheduledJobs();
    scheduled.length = 0;
    await initScheduledJobs();

    expect(scheduled.length).toBe(first);
  });
});
