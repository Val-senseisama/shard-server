import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Covers createPublicSupportRequest — the mutation behind the public support
 * form on shard.zevbii.com. It shipped as a comment describing work to be done while
 * the landing site was already posting to it, so every submission failed. These
 * tests exist so that cannot silently happen again.
 */

const create = vi.fn(async (doc: any) => ({ _id: "flag1", ...doc }));
const countDocuments = vi.fn(async () => 0);

vi.mock("../../models/SupportFlag.js", () => ({
  default: {
    create: (...a: any[]) => create(...a),
    countDocuments: (...a: any[]) => countDocuments(...a),
  },
}));
vi.mock("../../Helpers/Cache.js", () => ({ cache: vi.fn(), cacheInvalidate: vi.fn() }));
vi.mock("../../Helpers/Authz.js", () => ({ assertAdmin: vi.fn(), isAdmin: vi.fn() }));

const { default: SupportResolvers } = await import("./Support.js");
const run = (input: any) =>
  SupportResolvers.Mutation.createPublicSupportRequest(null, { input });

const valid = {
  name: "Ada",
  email: "Ada@Example.com ",
  issueType: "bug",
  title: "Cannot log in",
  description: "The login button does nothing on Android 14.",
};

beforeEach(() => {
  create.mockClear();
  countDocuments.mockClear();
  countDocuments.mockResolvedValue(0);
});

describe("createPublicSupportRequest", () => {
  it("creates a guest ticket with no userId", async () => {
    const res = await run(valid);
    expect(res.success).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    const doc = create.mock.calls[0][0];
    expect(doc.userId).toBeUndefined();
    expect(doc.guestName).toBe("Ada");
    expect(doc.status).toBe("open");
  });

  it("normalises the email so guests can be replied to and deduped", async () => {
    await run(valid);
    expect(create.mock.calls[0][0].guestEmail).toBe("ada@example.com");
  });

  it("works without a context argument at all (it is unauthenticated)", async () => {
    await expect(run(valid)).resolves.toMatchObject({ success: true });
  });

  it("rejects a missing field", async () => {
    const res = await run({ ...valid, description: "   " });
    expect(res.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a malformed email", async () => {
    expect((await run({ ...valid, email: "nope" })).success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an over-long description rather than truncating it", async () => {
    const res = await run({ ...valid, description: "x".repeat(2001) });
    expect(res.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an issueType outside the schema enum", async () => {
    // Would otherwise reach Mongoose and throw a validation error at write time.
    const res = await run({ ...valid, issueType: "urgent_pls" });
    expect(res.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("falls back to low priority when given an unknown priority", async () => {
    await run({ ...valid, priority: "catastrophic" });
    expect(create.mock.calls[0][0].priority).toBe("low");
  });

  it("honours a valid priority", async () => {
    await run({ ...valid, priority: "high" });
    expect(create.mock.calls[0][0].priority).toBe("high");
  });

  it("throttles once an address has already filed several tickets", async () => {
    countDocuments.mockResolvedValue(5);
    const res = await run(valid);
    expect(res.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("still accepts the ticket if the throttle lookup itself fails", async () => {
    // A dedupe query failing must not become an outage on the support channel.
    countDocuments.mockRejectedValue(new Error("mongo down"));
    const res = await run(valid);
    expect(res.success).toBe(true);
    expect(create).toHaveBeenCalledOnce();
  });

  it("reports failure without throwing when the write fails", async () => {
    create.mockRejectedValueOnce(new Error("write failed"));
    const res = await run(valid);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/try again/i);
  });
});
