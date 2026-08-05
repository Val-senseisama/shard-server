import { catchError, logError, ThrowError } from "../../Helpers/Helpers.js";
import SocialShare from "../../models/SocialShare.js";
import { logEvent } from "../../Helpers/Telemetry.js";

/**
 * Share cards — the product's only outward-facing growth loop.
 *
 * `completeShard` writes a card when someone finishes a quest; this exposes it so
 * the app can render it and hand it to the OS share sheet. Until now the card was
 * written and never read: the most flattering, most legible moment in the whole
 * product produced nothing anyone outside the app could see.
 *
 * The copy is generated server-side so that what gets posted stays consistent
 * across platforms and can be tuned without shipping an app build.
 */

const APP_URL = process.env.SITE_URL || "https://shard.app";

interface CardMeta {
  shardTitle?: string;
  completion?: number;
  xpEarned?: number;
  daysTaken?: number;
  onTime?: boolean;
}

/**
 * The headline and the share text.
 *
 * Deliberately about the *outcome*, not the mechanics. "I finished Learn to Draw
 * in 34 days" is legible to a stranger and flattering to post; "I earned 500 XP
 * and hit level 7" means nothing to anyone who doesn't already use the app, which
 * is exactly the audience a share is for.
 */
function renderCard(share: any): {
  headline: string;
  subline: string | null;
  shareText: string;
} {
  const meta: CardMeta = share.metadata ?? {};
  const title = meta.shardTitle || "a quest";
  const days = meta.daysTaken;

  if (share.type === "shard_completed") {
    const headline = `Finished ${title}`;
    const subline = days
      ? `${days} day${days === 1 ? "" : "s"}${meta.onTime ? " · on time" : ""}`
      : meta.onTime
        ? "On time"
        : null;

    const timing = days ? ` in ${days} day${days === 1 ? "" : "s"}` : "";
    const shareText = `I finished "${title}"${timing}. Planned it in Shard — tell it a goal, it gives you the plan.\n\n${APP_URL}`;

    return { headline, subline, shareText };
  }

  // Other card types (achievement, streak milestone) reuse the stored copy.
  return {
    headline: share.content || "Progress on Shard",
    subline: null,
    shareText: `${share.content || "Making progress on my goals"}\n\n${APP_URL}`,
  };
}

export default {
  Query: {
    async getShareCard(_, { shareId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, share] = await catchError(SocialShare.findById(shareId).lean());
      if (error || !share) {
        return { success: false, message: "Share card not found." };
      }

      // A card is personal — it names your goal and your pace.
      if ((share as any).userId.toString() !== context.id) {
        return { success: false, message: "This card isn't yours." };
      }

      const meta: CardMeta = (share as any).metadata ?? {};
      const rendered = renderCard(share);

      return {
        success: true,
        card: {
          id: (share as any)._id.toString(),
          type: (share as any).type,
          headline: rendered.headline,
          subline: rendered.subline,
          shareText: rendered.shareText,
          questTitle: meta.shardTitle ?? null,
          completion: meta.completion ?? null,
          xpEarned: meta.xpEarned ?? null,
          daysTaken: meta.daysTaken ?? null,
          onTime: meta.onTime ?? null,
          createdAt: (share as any).createdAt,
        },
      };
    },
  },

  Mutation: {
    /**
     * Record that the card actually went out. This is the only measurement of
     * whether the loop works, so it's worth a round-trip: share rate per
     * completion is the number that tells you if the artifact is good enough.
     */
    async recordShare(_, { shareId, platform }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const allowed = ["twitter", "facebook", "linkedin", "reddit", "custom"];
      const target = allowed.includes(platform) ? platform : "custom";

      const [error, share] = await catchError(
        SocialShare.findOneAndUpdate(
          { _id: shareId, userId: context.id },
          { $set: { platform: target, sharedAt: new Date() } },
          { new: true }
        )
      );

      if (error || !share) {
        logError("recordShare", error);
        return { success: false, message: "Could not record the share." };
      }

      logEvent({
        name: "share_completed",
        userId: context.id,
        props: { platform: target, type: (share as any).type },
      });

      return { success: true, message: "Thanks for sharing." };
    },
  },
};
