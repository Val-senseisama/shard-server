import { describe, it, expect, vi } from "vitest";

// countActiveShards touches the Shard model; stub it so the helper is unit-testable.
vi.mock("../models/Shard.js", () => ({
  default: { countDocuments: vi.fn(async () => 0) },
}));

import { isEntitled, tierOf, upgradeError, FREE_ACTIVE_SHARD_CAP, FREE_MONTHLY_CREDITS } from "./Entitlements.js";

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
});

describe("upgradeError", () => {
  it("returns the uniform paywall shape", () => {
    expect(upgradeError("nope")).toEqual({ success: false, message: "nope", needsUpgrade: true });
  });
});

describe("constants", () => {
  it("match the agreed free-tier limits", () => {
    expect(FREE_ACTIVE_SHARD_CAP).toBe(3);
    expect(FREE_MONTHLY_CREDITS).toBe(100);
  });
});
