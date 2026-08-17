/**
 * The notification bus — the one way anything reaches a user.
 *
 * Before this, a notification meant calling two or three unrelated things by
 * hand at ~30 sites: `createNotification` for the in-app row,
 * `sendNotificationToUser` or `enqueuePushNotification` for the push, and
 * sometimes `sendEmailToUser`. Nothing owned the total, so:
 *   - a user with four stale shards could take ten pushes inside one hour, then
 *     nothing for a week
 *   - the same milestone could fire every day until the user acted
 *   - per-type preferences were mapped correctly in one place and not another
 *   - nothing was measurable, so no nudge could be evaluated or tuned
 *
 * Everything now goes through `notify()`, which owns prefs, quiet hours,
 * priority, the daily budget, per-period dedupe, and telemetry.
 */

import Notification from "../models/Notifications.js";
import NotificationPreference from "../models/NotificationPreferences.js";
import { User } from "../models/User.js";
import { logError } from "./Helpers.js";
import { logEvent } from "./Telemetry.js";
import { cacheInvalidate } from "./Cache.js";
import { sendNotificationToTokens, channelForType, getUnreadBadgeCount } from "./FirebaseMessaging.js";
import { sendEmailToUser } from "./ResendEmail.js";
import { dateKeyInZone, currentTimeInZone, isWithinWindow } from "./Timezone.js";
import type { RecordActivityResult } from "./Streak.js";

/**
 * Every kind of message the product can send, and how it behaves.
 *
 * `prefKey` maps to NotificationPreferences. `priority` decides whether the
 * daily budget applies. `type` is the persisted notification type — it is also
 * what the client filters on and what picks the email template.
 */
export type NotifyKind =
  // ── transactional: always delivered, never budgeted ──
  | "friend_request"
  | "friend_accepted"
  | "message"
  | "shard_invite"
  | "task_assigned"
  | "trial_ending"
  // ── celebratory: earned, delivered promptly, lightly budgeted ──
  | "achievement"
  | "level_up"
  | "streak_milestone"
  | "streak_freeze_used"
  | "shard_completed"
  // ── retention: we chose to send these, so they're strictly budgeted ──
  | "daily_digest"
  | "task_reminder"
  | "quest_deadline"
  | "quest_overdue"
  | "tasks_missed"
  | "streak_at_risk"
  | "streak_broken"
  | "inactivity_nudge"
  | "activation_nudge"
  | "dormant_winback"
  | "empty_schedule"
  | "friend_overtook"
  | "partner_progress"
  | "course_drift"
  | "shard_update";

export type Priority = "transactional" | "celebratory" | "retention";

type PrefKey =
  | "friendRequests"
  | "messages"
  | "shardInvites"
  | "shardUpdates"
  | "questDeadlines"
  | "achievements";

interface KindSpec {
  priority: Priority;
  prefKey?: PrefKey;
  /** Persisted `Notification.type`; defaults to the kind itself. */
  type?: string;
}

const KINDS: Record<NotifyKind, KindSpec> = {
  friend_request:      { priority: "transactional", prefKey: "friendRequests" },
  friend_accepted:     { priority: "transactional", prefKey: "friendRequests" },
  message:             { priority: "transactional", prefKey: "messages" },
  shard_invite:        { priority: "transactional", prefKey: "shardInvites" },
  task_assigned:       { priority: "transactional", prefKey: "shardUpdates" },
  trial_ending:        { priority: "transactional" },

  achievement:         { priority: "celebratory", prefKey: "achievements" },
  level_up:            { priority: "celebratory", prefKey: "achievements" },
  streak_milestone:    { priority: "celebratory", prefKey: "achievements" },
  streak_freeze_used:  { priority: "celebratory", prefKey: "achievements" },
  shard_completed:     { priority: "celebratory", prefKey: "achievements" },

  daily_digest:        { priority: "retention", prefKey: "questDeadlines" },
  task_reminder:       { priority: "retention", prefKey: "questDeadlines" },
  quest_deadline:      { priority: "retention", prefKey: "questDeadlines" },
  quest_overdue:       { priority: "retention", prefKey: "questDeadlines" },
  tasks_missed:        { priority: "retention", prefKey: "questDeadlines" },
  streak_at_risk:      { priority: "retention", prefKey: "questDeadlines" },
  streak_broken:       { priority: "retention", prefKey: "questDeadlines" },
  inactivity_nudge:    { priority: "retention", prefKey: "questDeadlines" },
  activation_nudge:    { priority: "retention", prefKey: "questDeadlines" },
  dormant_winback:     { priority: "retention", prefKey: "questDeadlines" },
  empty_schedule:      { priority: "retention", prefKey: "questDeadlines" },
  friend_overtook:     { priority: "retention", prefKey: "shardUpdates" },
  partner_progress:    { priority: "retention", prefKey: "shardUpdates" },
  course_drift:        { priority: "retention", prefKey: "questDeadlines" },
  shard_update:        { priority: "retention", prefKey: "shardUpdates" },
};

/**
 * Daily caps, per user, per local day.
 *
 * The retention cap is deliberately 1. A person who gets one well-timed nudge a
 * day keeps notifications enabled; a person who gets six turns them off, and a
 * user with notifications off is far harder to bring back than one we nudged
 * less. Transactional traffic is uncapped because the user's counterparty is
 * waiting on it.
 */
export const DAILY_BUDGET: Record<Priority, number> = {
  transactional: Infinity,
  celebratory: 3,
  retention: 1,
};

export interface NotifyInput {
  userId: string;
  kind: NotifyKind;
  /** Push title. Falls back to "Shard". */
  title?: string;
  /** Push body and in-app message. */
  body: string;
  /** Deep-link data. `screen` and/or `shardId` are what the client routes on. */
  data?: Record<string, string>;
  shardId?: string;
  miniGoalId?: string;
  /**
   * Dedupe scope. Two notifies with the same (user, kind, dedupeKey) collapse to
   * one. Defaults to the user's local day, which is almost always what you want
   * — it's what stops a milestone re-firing every day until the user acts.
   * Pass `null` to opt out.
   */
  dedupeKey?: string | null;
  /** Extra fields for the email template (shardTitle, actorName, …). */
  emailData?: Record<string, any>;
  /** Skip the push, still record in-app (e.g. low-value bulk updates). */
  inAppOnly?: boolean;
  /**
   * Tray grouping key. Pushes sharing one replace each other on the device
   * rather than stacking — see `sendNotificationToTokens`. Use it wherever a
   * newer push makes an older one redundant (chat, per-shard updates).
   */
  collapseKey?: string;
}

export interface NotifyResult {
  delivered: boolean;
  reason?: "prefs_off" | "type_off" | "quiet_hours" | "budget" | "duplicate" | "no_tokens" | "error";
  /** True when the in-app row was written even though the push wasn't sent. */
  recorded: boolean;
}

/** Cheap in-process guard so a fan-out loop can't spam the same row. */
const recentSends = new Map<string, number>();
const RECENT_TTL_MS = 60_000;

function seenRecently(key: string): boolean {
  const now = Date.now();
  // Opportunistic sweep — this map is small and short-lived.
  if (recentSends.size > 5000) {
    for (const [k, at] of recentSends) if (now - at > RECENT_TTL_MS) recentSends.delete(k);
  }
  const at = recentSends.get(key);
  if (at && now - at < RECENT_TTL_MS) return true;
  recentSends.set(key, now);
  return false;
}

/**
 * Send one notification, subject to preferences, quiet hours, budget and dedupe.
 *
 * Never throws: a failed notification must not fail the action that triggered it.
 */
export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const spec = KINDS[input.kind];
  if (!spec) {
    logError("notify:unknownKind", new Error(`Unknown notify kind: ${input.kind}`));
    return { delivered: false, reason: "error", recorded: false };
  }

  const type = spec.type ?? input.kind;

  try {
    const user = await User.findById(input.userId)
      .select("timezone pushTokens")
      .lean();
    if (!user) return { delivered: false, reason: "error", recorded: false };

    const timezone = (user as any).timezone as string | undefined;
    const dayKey = dateKeyInZone(new Date(), timezone);
    const dedupeKey = input.dedupeKey === null ? null : (input.dedupeKey ?? dayKey);

    // ── Dedupe ──
    if (dedupeKey !== null) {
      const memKey = `${input.userId}:${input.kind}:${dedupeKey}`;
      if (seenRecently(memKey)) {
        return { delivered: false, reason: "duplicate", recorded: false };
      }
      const existing = await Notification.findOne({
        userId: input.userId,
        type,
        dedupeKey: `${input.kind}:${dedupeKey}`,
      })
        .select("_id")
        .lean();
      if (existing) {
        return { delivered: false, reason: "duplicate", recorded: false };
      }
    }

    const prefs = await NotificationPreference.findOne({ userId: input.userId }).lean();

    // ── Per-type preference ──
    // One mapping, derived from the kind table. The old code had this logic in
    // three places and the cron's copy compared snake_case types against
    // camelCase pref keys, so it never matched anything.
    if (prefs && spec.prefKey && (prefs as any)[spec.prefKey] === false) {
      return { delivered: false, reason: "type_off", recorded: false };
    }

    // ── Budget (local day) ──
    if (spec.priority !== "transactional") {
      const cap = DAILY_BUDGET[spec.priority];
      if (Number.isFinite(cap)) {
        const sentToday = await Notification.countDocuments({
          userId: input.userId,
          priority: spec.priority,
          dayKey,
        });
        if (sentToday >= cap) {
          logEvent({
            name: "notification_suppressed",
            userId: input.userId,
            props: { kind: input.kind, reason: "budget" },
          });
          return { delivered: false, reason: "budget", recorded: false };
        }
      }
    }

    // ── Quiet hours ──
    // Transactional messages ignore quiet hours only insofar as they are still
    // deferred, never dropped: the in-app row is written now and the push fires
    // when the window ends.
    let deferUntil: Date | null = null;
    if (prefs?.quietHoursEnabled && prefs.quietHoursStart && prefs.quietHoursEnd) {
      const nowLocal = currentTimeInZone(timezone);
      if (isWithinWindow(prefs.quietHoursStart, prefs.quietHoursEnd, nowLocal)) {
        deferUntil = nextQuietHoursEnd(prefs.quietHoursEnd, timezone);
      }
    }

    const pushDisabled = prefs ? prefs.pushEnabled === false : false;
    const shouldPushNow = !deferUntil && !pushDisabled && !input.inAppOnly;

    // ── Persist the in-app row ──
    // The (userId, dedupeKey) index is unique, so this insert is also the
    // authoritative dedupe: two jobs racing on the same key means one loses
    // here, and losing is a duplicate rather than an error.
    let row;
    try {
      row = await Notification.create({
        userId: input.userId,
        message: input.body,
        type,
        kind: input.kind,
        priority: spec.priority,
        dayKey,
        dedupeKey: dedupeKey === null ? undefined : `${input.kind}:${dedupeKey}`,
        shardId: input.shardId,
        miniGoalId: input.miniGoalId,
        data: input.data,
        triggerAt: deferUntil ?? new Date(),
        // A deferred row is picked up later by the dispatcher; anything we handle
        // inline here is done with.
        dispatched: !deferUntil,
        read: false,
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        return { delivered: false, reason: "duplicate", recorded: false };
      }
      throw err;
    }

    // The list and badge are cached; without this the user taps a push, opens
    // the app, and doesn't see the thing they were notified about for 15 minutes.
    await cacheInvalidate.notifications(input.userId);

    if (deferUntil) {
      return { delivered: false, reason: "quiet_hours", recorded: true };
    }

    if (pushDisabled || input.inAppOnly) {
      return { delivered: false, reason: "prefs_off", recorded: true };
    }

    // ── Push ──
    const tokens = ((user as any).pushTokens ?? [])
      .map((t: any) => t.token)
      .filter(Boolean);

    let delivered = false;
    if (tokens.length > 0 && shouldPushNow) {
      delivered = await sendNotificationToTokens(
        [...new Set<string>(tokens)],
        {
          title: input.title ?? "Shard",
          body: input.body,
          data: {
            ...(input.data ?? {}),
            ...(input.shardId ? { shardId: input.shardId } : {}),
            kind: input.kind,
            notificationId: row._id.toString(),
          },
        },
        channelForType(type),
        await getUnreadBadgeCount(input.userId),
        input.collapseKey
      );
    }

    // ── Email (opt-in only; templates get real data now) ──
    sendEmailToUser(input.userId, type, {
      message: input.body,
      ...(input.emailData ?? {}),
    }).catch(() => {});

    logEvent({
      name: "notification_sent",
      userId: input.userId,
      props: {
        kind: input.kind,
        priority: spec.priority,
        pushed: delivered,
        hadTokens: tokens.length > 0,
      },
    });

    return {
      delivered,
      reason: tokens.length === 0 ? "no_tokens" : undefined,
      recorded: true,
    };
  } catch (error) {
    logError(`notify:${input.kind}`, error);
    return { delivered: false, reason: "error", recorded: false };
  }
}

/**
 * When the user's quiet-hours window next ends, as an absolute instant.
 * Computed against the USER's clock — the previous implementation used the
 * server's, so a deferred push could resurface in the middle of their night.
 */
export function nextQuietHoursEnd(quietHoursEnd: string, timezone?: string): Date {
  const [endHour = 8, endMin = 0] = quietHoursEnd.split(":").map(Number);
  const now = new Date();

  // Walk forward in 15-minute steps until the user's local clock passes the end
  // time. Cheap (max ~96 iterations), and correct across DST and half-hour
  // offsets without pulling in a date library.
  for (let minutes = 0; minutes <= 24 * 60; minutes += 15) {
    const candidate = new Date(now.getTime() + minutes * 60_000);
    const local = currentTimeInZoneAt(candidate, timezone);
    const [h, m] = local.split(":").map(Number);
    if (h > endHour || (h === endHour && m >= endMin)) {
      // Only accept a crossing that is actually in the future.
      if (candidate > now) return candidate;
    }
  }
  return new Date(now.getTime() + 8 * 3600_000);
}

/** "HH:mm" in `timezone` for an arbitrary instant. */
function currentTimeInZoneAt(date: Date, timezone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone || "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
    const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
    return `${hh}:${mm}`;
  } catch {
    return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
  }
}

/**
 * Bundle one message to many users. Used by the fan-out paths (shard updates,
 * partner progress) that previously sent one push per shard per user.
 */
export async function notifyMany(
  userIds: string[],
  input: Omit<NotifyInput, "userId">
): Promise<number> {
  const unique = [...new Set(userIds)];
  const results = await Promise.all(
    unique.map((userId) => notify({ ...input, userId }))
  );
  return results.filter((r) => r.delivered).length;
}

/**
 * Celebrate a streak event at the moment it happens.
 *
 * This replaces the milestone half of the old `streak-event-detector` cron,
 * which ran daily on `currentStreak % 7 === 0`. Because nothing decayed the
 * streak, a user sitting at 7 was told "🔥 7-Day Streak!" every single day until
 * they completed something. Firing from the completion itself is both correct
 * and better timed — the user is holding the phone.
 */
export async function notifyStreakProgress(
  userId: string,
  streak: RecordActivityResult
): Promise<void> {
  if (streak.freezeUsed) {
    await notify({
      userId,
      kind: "streak_freeze_used",
      title: "❄️ Streak saved",
      body: `You missed a day, so we spent a streak freeze. Your ${streak.current}-day streak is intact.`,
      data: { screen: "/schedule" },
    });
  }

  if (streak.milestone) {
    await notify({
      userId,
      kind: "streak_milestone",
      title: `🔥 ${streak.milestone}-day streak`,
      body: streak.isPersonalBest
        ? `${streak.milestone} days — a new personal best. Keep it rolling.`
        : `${streak.milestone} days in a row. That's a habit now.`,
      data: { screen: "/account" },
      // One per milestone value, forever — not one per day.
      dedupeKey: `milestone:${streak.milestone}`,
    });
  }
}
