import AnalyticsEvent from "../models/AnalyticsEvent.js";

/**
 * Canonical product-analytics event names (revenue funnel).
 * Keep this list in sync with the client `track()` helper and the admin funnel view.
 */
export type EventName =
  | "signup"
  | "trial_started"
  | "referral_completed"
  | "ai_quest_created"
  | "paywall_impression"
  | "upgrade_tap"
  | "purchase_completed"
  | "purchase_cancelled"
  | "subscription_activated";

interface LogEventArgs {
  name: EventName | string;
  userId?: string;
  anonId?: string;
  source?: string;
  props?: Record<string, unknown>;
  tier?: string;
  platform?: string;
}

/**
 * Fire-and-forget telemetry insert. NEVER throws — analytics must not break the
 * request that emitted it. Not awaited by callers on the hot path.
 */
export async function logEvent(args: LogEventArgs): Promise<void> {
  try {
    await AnalyticsEvent.create({
      userId: args.userId,
      anonId: args.anonId,
      name: args.name,
      source: args.source,
      props: args.props,
      tier: args.tier,
      platform: args.platform,
    });
  } catch {
    // swallow — telemetry is best-effort
  }
}
