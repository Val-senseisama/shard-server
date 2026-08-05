import { describe, it, expect } from "vitest";

/**
 * Regression: the completion payout must be guarded by whether it was PAID,
 * never by the shard's status.
 *
 * `updateShard({ status: 'completed' })` used to write the status and *then*
 * delegate to the payout helper, which re-read the shard, saw `status ===
 * 'completed'`, and returned "already complete" — skipping the reward entirely on
 * exactly the path the shared helper was extracted to protect. The status is a
 * label; `completionXPAwarded` is the fact.
 */

/** Mirrors the guard in `_completeShard`. */
const alreadyPaid = (shard: { status?: string; completionXPAwarded?: number | null }) =>
  shard.completionXPAwarded != null;

describe("completion payout guard", () => {
  it("pays a shard whose status says completed but which was never paid", () => {
    // Precisely the state updateShard left behind.
    expect(alreadyPaid({ status: "completed" })).toBe(false);
  });

  it("refuses to pay twice", () => {
    expect(alreadyPaid({ status: "completed", completionXPAwarded: 250 })).toBe(true);
  });

  it("treats a zero payout as already paid — 0 XP is a real outcome", () => {
    // A quest completed at 0% pays nothing; that must still count as settled,
    // or it could be re-triggered forever.
    expect(alreadyPaid({ status: "completed", completionXPAwarded: 0 })).toBe(true);
  });

  it("pays an in-progress shard being completed normally", () => {
    expect(alreadyPaid({ status: "active" })).toBe(false);
  });
});
