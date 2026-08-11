import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the data layer so the controller runs without Mongo.
vi.mock("../models/User.js", () => ({
  User: { findById: vi.fn(), findByIdAndUpdate: vi.fn(async () => ({})) },
}));
vi.mock("../models/SubscriptionHistory.js", () => ({
  default: { findOne: vi.fn(), create: vi.fn(async () => ({})) },
}));
vi.mock("../Helpers/Helpers.js", () => ({ logError: vi.fn() }));
vi.mock("../Helpers/Telemetry.js", () => ({ logEvent: vi.fn() }));
vi.mock("../Helpers/Cache.js", () => ({
  cacheInvalidate: { user: vi.fn(async () => {}) },
}));
// mongoose is deliberately NOT mocked: USER_ID below is a real ObjectId hex
// string, so isValidObjectId passes on its own, and stubbing the module breaks
// the Schema constructor that the transitively-imported models need.

import { User } from "../models/User.js";
import SubscriptionHistory from "../models/SubscriptionHistory.js";
import { handleRevenueCatWebhook } from "./WebhookController.js";

const SECRET = "test-secret";
const USER_ID = "69bd13d6dcc95d9e9e41de01";
const TXN = "GPA.3341-5287-3399-77756";

function req(type: string, extra: Record<string, any> = {}) {
  return {
    headers: { authorization: `Bearer ${SECRET}` },
    body: {
      event: {
        type,
        app_user_id: USER_ID,
        transaction_id: TXN,
        entitlement_ids: ["Thinkertech Pro"],
        ...extra,
      },
    },
  } as any;
}

/**
 * A findOne that matches on whatever fields the query actually contains, the
 * way Mongo does.
 *
 * This matters more than it looks. A mock that only inspects `q.action` would
 * return null for the OLD, broken query (`{ paymentId }` with no action) and
 * every test here would pass against the bug it exists to catch. Matching all
 * provided fields means the buggy query finds the PURCHASE row and is correctly
 * reported as a duplicate — which is what makes these tests fail without the fix.
 */
function seedHistory(rows: Record<string, any>[]) {
  (SubscriptionHistory.findOne as any).mockImplementation(
    async (q: Record<string, any>) =>
      rows.find((row) => Object.entries(q).every(([k, v]) => row[k] === v)) ?? null
  );
}

function res() {
  const r: any = { statusCode: 0, body: "" };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.send = (b: string) => { r.body = b; return r; };
  return r;
}

describe("RevenueCat webhook idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.REVENUE_CAT_STORE_KEY = SECRET;
    (User.findById as any).mockResolvedValue({ subscriptionTier: "pro" });
  });

  it("rejects a genuine redelivery of the same event", async () => {
    // Same transaction, same action — already recorded.
    seedHistory([{ paymentId: TXN, action: "RENEWAL" }]);

    const r = res();
    await handleRevenueCatWebhook(req("RENEWAL"), r);

    expect(r.body).toContain("Duplicate");
    expect(SubscriptionHistory.create).not.toHaveBeenCalled();
  });

  it("processes EXPIRATION even though it reuses the purchase's transaction_id", async () => {
    // This is the regression. RevenueCat sends EXPIRATION carrying the SAME
    // transaction_id as the PURCHASE/RENEWAL it ends. Keying idempotency on
    // transaction_id alone classified it as a duplicate and dropped it, so the
    // user was never downgraded and kept Pro forever after cancelling.
    //
    // findOne must therefore be scoped by action: a PURCHASE row exists, an
    // EXPIRY row does not.
    seedHistory([{ paymentId: TXN, action: "PURCHASE" }]);

    const r = res();
    await handleRevenueCatWebhook(req("EXPIRATION"), r);

    expect(r.body).not.toContain("Duplicate");
    expect(SubscriptionHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: "EXPIRY", tier: "free" })
    );

    // The whole point: they actually lose Pro.
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ subscriptionTier: "free" })
    );
  });

  it("records CANCELLATION without revoking access early", async () => {
    // Cancelling stops the next renewal; it does not end the paid period. The
    // user must keep Pro until EXPIRATION arrives.
    seedHistory([{ paymentId: TXN, action: "PURCHASE" }]);

    const r = res();
    await handleRevenueCatWebhook(req("CANCELLATION"), r);

    expect(SubscriptionHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CANCELLATION", tier: "pro" })
    );
    const update = (User.findByIdAndUpdate as any).mock.calls[0]?.[1] ?? {};
    expect(update.subscriptionTier).toBeUndefined();
  });

  it("moves the renewal date on a RENEWAL for an already-Pro user", async () => {
    // The tier is unchanged here, so a write gated on a tier change would leave
    // subscriptionExpiresAt frozen at whatever the first purchase set.
    seedHistory([]);
    const expiresAt = Date.now() + 30 * 60 * 1000;

    await handleRevenueCatWebhook(
      req("RENEWAL", { expiration_at_ms: expiresAt }),
      res()
    );

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ subscriptionExpiresAt: new Date(expiresAt) })
    );
  });
});
