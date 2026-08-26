import { describe, it, expect } from "vitest";

// Mock the data layer so importing the resolver module doesn't reach for Mongo.
import { vi } from "vitest";
vi.mock("../../models/SocialShare.js", () => ({ default: {} }));
vi.mock("../../Helpers/Telemetry.js", () => ({ logEvent: vi.fn() }));

import { taggedUrl, renderCard } from "./Share.js";

/**
 * The share loop's link, which is the only thing that makes the loop countable.
 *
 * Every completion card used to carry a bare site URL, so a visit one earned was
 * indistinguishable from someone typing the domain in. These assertions exist
 * because the failure mode is silent: a malformed query string still renders,
 * still opens the site, and still reports nothing.
 */
describe("taggedUrl — attribution on the share link", () => {
  it("carries source, medium and campaign", () => {
    const url = new URL(taggedUrl("share_card"));

    expect(url.searchParams.get("utm_source")).toBe("share_card");
    expect(url.searchParams.get("utm_medium")).toBe("social");
    expect(url.searchParams.get("utm_campaign")).toBe("share_loop");
  });

  it("points at the site, not at a path that doesn't exist", () => {
    const url = new URL(taggedUrl("share_card"));

    expect(url.origin).toBe("https://shard.zevbii.com");
    expect(url.pathname).toBe("/");
  });

  it("never doubles the separator when SITE_URL has a trailing slash", () => {
    // Railway's SITE_URL is set by hand, so a trailing slash is a question of
    // when rather than if, and `https://x.com//?utm...` is a different page to
    // Next than `https://x.com/?utm...`.
    const url = taggedUrl("share_card", "share_loop", "https://shard.zevbii.com/");

    expect(url.startsWith("https://shard.zevbii.com/?")).toBe(true);
    expect(url).not.toContain("//?");
  });

  it("takes a campaign override", () => {
    const url = new URL(taggedUrl("invite", "referral"));
    expect(url.searchParams.get("utm_campaign")).toBe("referral");
  });
});

describe("renderCard — the share text actually carries the tagged link", () => {
  const completed = {
    type: "shard_completed",
    metadata: { shardTitle: "Learn to draw", daysTaken: 34, onTime: true },
  };

  it("appends the tagged URL to a completion share", () => {
    const { shareText } = renderCard(completed);

    expect(shareText).toContain("utm_source=share_card");
    expect(shareText).toContain("Learn to draw");
  });

  it("appends it to the fallback card types too", () => {
    const { shareText } = renderCard({ type: "achievement", content: "10 day streak" });

    expect(shareText).toContain("utm_source=share_card");
  });

  it("still leads with the outcome, not the mechanics", () => {
    // XP means nothing to the stranger a share is aimed at, and leading with it
    // is what makes gamified-app shares read as spam.
    const { headline, shareText } = renderCard(completed);

    expect(headline).toBe("Finished Learn to draw");
    expect(shareText).not.toMatch(/\bXP\b/);
  });
});
