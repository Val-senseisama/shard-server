import { ThrowError } from "../../Helpers/Helpers.js";
import AnalyticsEvent from "../../models/AnalyticsEvent.js";
import { User } from "../../models/User.js";
import { logEvent } from "../../Helpers/Telemetry.js";
import { activationCohort, ACTIVATION_WINDOW_DAYS } from "../../Helpers/Activation.js";

const rate = (num: number, den: number) => (den > 0 ? Number((num / den).toFixed(4)) : 0);

export default {
  Query: {
    /**
     * Admin-only revenue-funnel rollup over the last `days`.
     */
    async getFunnelStats(_: any, { days = 30 }: { days?: number }, context: any) {
      if (!context.id) ThrowError("Please login to continue.");
      if (context.role !== "admin") ThrowError("Admin access required.");

      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const [byName, bySource, activation] = await Promise.all([
        AnalyticsEvent.aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: "$name", count: { $sum: 1 } } },
        ]),
        AnalyticsEvent.aggregate([
          { $match: { name: "paywall_impression", createdAt: { $gte: since } } },
          { $group: { _id: { $ifNull: ["$source", "unknown"] }, count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        // Cohort-based, not an event ratio — see Helpers/Activation.ts.
        activationCohort(days),
      ]);

      const c: Record<string, number> = {};
      for (const row of byName) c[row._id] = row.count;

      const signups = c["signup"] || 0;
      // Quests CREATED. Kept because it isolates "did the AI produce something
      // plausible" from "did the plan get followed" (see activation below).
      const activations = c["ai_quest_created"] || 0;
      const firstQuestsCompleted = c["first_quest_completed"] || 0;
      const sharesCompleted = c["share_completed"] || 0;
      const trialsStarted = c["trial_started"] || 0;
      const referralsCompleted = c["referral_completed"] || 0;
      const paywallImpressions = c["paywall_impression"] || 0;
      const upgradeTaps = c["upgrade_tap"] || 0;
      const purchasesCompleted = c["purchase_completed"] || 0;
      const subscriptionsActivated = c["subscription_activated"] || 0;

      return {
        success: true,
        days,
        signups,
        activations,
        trialsStarted,
        referralsCompleted,
        paywallImpressions,
        upgradeTaps,
        purchasesCompleted,
        subscriptionsActivated,
        // Event-count ratios across the funnel (0..1).
        activationRate: rate(activations, signups),
        trialConversionRate: rate(subscriptionsActivated, trialsStarted),
        impressionToTapRate: rate(upgradeTaps, paywallImpressions),
        tapToPurchaseRate: rate(purchasesCompleted, upgradeTaps),
        impressionToPurchaseRate: rate(purchasesCompleted, paywallImpressions),
        impressionsBySource: bySource.map((r) => ({ source: r._id, count: r.count })),

        // ── The headline: did the plan get followed? ──
        activationWindowDays: ACTIVATION_WINDOW_DAYS,
        cohortSize: activation.cohortSize,
        activatedInWindow: activation.activatedInWindow,
        activatedEver: activation.activated,
        weekOneActivationRate: activation.weekOneActivationRate,
        medianDaysToActivate: activation.medianDaysToActivate,

        firstQuestsCompleted,
        sharesCompleted,
        // Of the people who finished a quest, how many shared the card? This is
        // the growth loop's only real measurement.
        shareRate: rate(sharesCompleted, firstQuestsCompleted),
      };
    },
  },

  Mutation: {
    /**
     * Client telemetry sink. Auth is optional (pre-signup events carry only anonId).
     * Never throws — a failed track must not surface to the user.
     */
    async trackEvent(
      _: any,
      { input }: { input: { name: string; source?: string; props?: any; platform?: string; anonId?: string } },
      context: any
    ) {
      try {
        if (!input?.name) return { success: false, message: "name is required" };

        let tier = "anon";
        if (context.id) {
          const user = await User.findById(context.id, "subscriptionTier").lean();
          tier = (user as any)?.subscriptionTier || "free";
        }

        await logEvent({
          name: input.name,
          userId: context.id || undefined,
          anonId: input.anonId,
          source: input.source,
          props: input.props,
          tier,
          platform: input.platform,
        });

        return { success: true, message: "ok" };
      } catch {
        // Best-effort: never fail the caller.
        return { success: true, message: "ok" };
      }
    },
  },
};
