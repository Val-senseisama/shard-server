import { describe, it, expect, vi } from "vitest";

// countActiveShards touches the Shard model; stub it so the helper is unit-testable.
vi.mock("../models/Shard.js", () => ({
  default: { countDocuments: vi.fn(async () => 0) },
}));

import { isEntitled, isInTrial, tierOf, upgradeError, eventMatchesEntitlement, ENTITLEMENT_ID, FREE_ACTIVE_SHARD_CAP, FREE_MONTHLY_CREDITS, TRIAL_DURATION_DAYS } from "./Entitlements.js";

const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const past = new Date(Date.now() - 24 * 60 * 60 * 1000);

describe("isEntitled", () => {
  it("treats pro and enterprise as entitled", () => {
    expect(isEntitled("pro")).toBe(true);
    expect(isEntitled("enterprise")).toBe(true);
  });
  it("treats free / unknown / nullish as not entitled", () => {
    expect(isEntitled("free")).toBe(false);
    expect(isEntitled(undefined)).toBe(false);
    expect(isEntitled(null)).toBe(false);
    expect(isEntitled("premium")).toBe(false);
  });
});

describe("tierOf", () => {
  it("maps pro/enterprise subscription to pro", () => {
    expect(tierOf({ subscriptionTier: "pro" })).toBe("pro");
    expect(tierOf({ subscriptionTier: "enterprise" })).toBe("pro");
  });
  it("maps free/none to free", () => {
    expect(tierOf({ subscriptionTier: "free" })).toBe("free");
    expect(tierOf({})).toBe("free");
    expect(tierOf(null)).toBe("free");
  });
  it("gives admins pro access regardless of subscription", () => {
    expect(tierOf({ subscriptionTier: "free", role: "admin" })).toBe("pro");
  });
  it("treats an unexpired trial as pro", () => {
    expect(tierOf({ subscriptionTier: "free", trialEndsAt: future })).toBe("pro");
  });
  it("reverts to free once the trial has expired", () => {
    expect(tierOf({ subscriptionTier: "free", trialEndsAt: past })).toBe("free");
  });
  it("keeps a paid user pro even if a stale trialEndsAt lingers", () => {
    expect(tierOf({ subscriptionTier: "pro", trialEndsAt: past })).toBe("pro");
  });
});

describe("isInTrial", () => {
  it("is true only for a non-paid user with a future trialEndsAt", () => {
    expect(isInTrial({ subscriptionTier: "free", trialEndsAt: future })).toBe(true);
  });
  it("is false when expired, absent, or already paid", () => {
    expect(isInTrial({ subscriptionTier: "free", trialEndsAt: past })).toBe(false);
    expect(isInTrial({ subscriptionTier: "free" })).toBe(false);
    expect(isInTrial({ subscriptionTier: "pro", trialEndsAt: future })).toBe(false);
    expect(isInTrial(null)).toBe(false);
  });
});

describe("eventMatchesEntitlement (webhook guard)", () => {
  it("accepts an event carrying our entitlement id", () => {
    expect(eventMatchesEntitlement([ENTITLEMENT_ID], null)).toBe(true);
    expect(eventMatchesEntitlement(null, ENTITLEMENT_ID)).toBe(true);
  });
  it("rejects an event that carries only a different entitlement", () => {
    expect(eventMatchesEntitlement(["some_other_pro"], null)).toBe(false);
    expect(eventMatchesEntitlement(null, "wrong_id")).toBe(false);
  });
  it("does not block when the event has no entitlement info (backward compat)", () => {
    expect(eventMatchesEntitlement(null, null)).toBe(true);
    expect(eventMatchesEntitlement([], undefined)).toBe(true);
  });
});

describe("upgradeError", () => {
  it("returns the uniform paywall shape", () => {
    expect(upgradeError("nope")).toEqual({ success: false, message: "nope", needsUpgrade: true });
  });
});

describe("constants", () => {
  it("match the agreed free-tier limits", () => {
    expect(FREE_ACTIVE_SHARD_CAP).toBe(3);
    expect(FREE_MONTHLY_CREDITS).toBe(15);
    expect(TRIAL_DURATION_DAYS).toBe(7);
  });
});
