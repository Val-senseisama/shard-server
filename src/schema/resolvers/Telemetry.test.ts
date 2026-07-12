import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the data layer so the resolver runs without Mongo.
vi.mock("../../models/AnalyticsEvent.js", () => ({
  default: { create: vi.fn(async () => ({})), aggregate: vi.fn() },
}));
vi.mock("../../models/User.js", () => ({ User: { findById: vi.fn() } }));

import AnalyticsEvent from "../../models/AnalyticsEvent.js";
import { User } from "../../models/User.js";
import TelemetryResolvers from "./Telemetry.js";

const asUser = (doc: any) => ({ lean: () => Promise.resolve(doc) }) as any;
beforeEach(() => vi.clearAllMocks());

describe("trackEvent — client telemetry sink", () => {
  it("writes an authed event with the user's tier", async () => {
    vi.mocked(User.findById).mockReturnValue(asUser({ subscriptionTier: "free" }));
    const res: any = await TelemetryResolvers.Mutation.trackEvent(
      {}, { input: { name: "paywall_impression", source: "ai_credits", platform: "ios" } }, { id: "u1" }
    );
    expect(res.success).toBe(true);
    expect(AnalyticsEvent.create).toHaveBeenCalledTimes(1);
    const doc = vi.mocked(AnalyticsEvent.create).mock.calls[0][0] as any;
    expect(doc.name).toBe("paywall_impression");
    expect(doc.source).toBe("ai_credits");
    expect(doc.userId).toBe("u1");
    expect(doc.tier).toBe("free");
  });

  it("accepts an anonymous event (no auth) tagged tier 'anon' and never looks up a user", async () => {
    const res: any = await TelemetryResolvers.Mutation.trackEvent(
      {}, { input: { name: "paywall_impression", source: "generic", anonId: "device-42" } }, {}
    );
    expect(res.success).toBe(true);
    expect(User.findById).not.toHaveBeenCalled();
    const doc = vi.mocked(AnalyticsEvent.create).mock.calls[0][0] as any;
    expect(doc.tier).toBe("anon");
    expect(doc.anonId).toBe("device-42");
    expect(doc.userId).toBeUndefined();
  });

  it("never throws to the caller even if the write fails", async () => {
    vi.mocked(User.findById).mockReturnValue(asUser({ subscriptionTier: "pro" }));
    vi.mocked(AnalyticsEvent.create).mockRejectedValueOnce(new Error("db down"));
    const res: any = await TelemetryResolvers.Mutation.trackEvent(
      {}, { input: { name: "upgrade_tap" } }, { id: "u1" }
    );
    expect(res.success).toBe(true);
  });
});

describe("getFunnelStats — admin-only funnel rollup", () => {
  it("blocks a non-admin", async () => {
    await expect(
      TelemetryResolvers.Query.getFunnelStats({}, {}, { id: "u1", role: "user" })
    ).rejects.toThrow();
  });

  it("computes funnel counts and conversion rates from events", async () => {
    // byName aggregation, then bySource aggregation
    vi.mocked(AnalyticsEvent.aggregate)
      .mockResolvedValueOnce([
        { _id: "signup", count: 10 },
        { _id: "ai_quest_created", count: 6 },
        { _id: "trial_started", count: 8 },
        { _id: "referral_completed", count: 3 },
        { _id: "paywall_impression", count: 20 },
        { _id: "upgrade_tap", count: 5 },
        { _id: "purchase_completed", count: 2 },
        { _id: "subscription_activated", count: 2 },
      ] as any)
      .mockResolvedValueOnce([
        { _id: "ai_credits", count: 14 },
        { _id: "shard_limit", count: 6 },
      ] as any);

    const res: any = await TelemetryResolvers.Query.getFunnelStats({}, { days: 7 }, { id: "admin1", role: "admin" });
    expect(res.success).toBe(true);
    expect(res.days).toBe(7);
    expect(res.signups).toBe(10);
    expect(res.activations).toBe(6);
    expect(res.trialsStarted).toBe(8);
    expect(res.referralsCompleted).toBe(3);
    expect(res.activationRate).toBe(0.6); // 6/10
    expect(res.trialConversionRate).toBe(0.25); // 2 subs / 8 trials
    expect(res.impressionToTapRate).toBe(0.25); // 5/20
    expect(res.tapToPurchaseRate).toBe(0.4); // 2/5
    expect(res.impressionToPurchaseRate).toBe(0.1); // 2/20
    expect(res.impressionsBySource).toEqual([
      { source: "ai_credits", count: 14 },
      { source: "shard_limit", count: 6 },
    ]);
  });

  it("returns zeroed rates when there are no events (no divide-by-zero)", async () => {
    vi.mocked(AnalyticsEvent.aggregate).mockResolvedValueOnce([] as any).mockResolvedValueOnce([] as any);
    const res: any = await TelemetryResolvers.Query.getFunnelStats({}, {}, { id: "admin1", role: "admin" });
    expect(res.activationRate).toBe(0);
    expect(res.impressionToPurchaseRate).toBe(0);
    expect(res.impressionsBySource).toEqual([]);
  });
});
