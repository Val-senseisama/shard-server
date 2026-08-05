/**
 * Lifecycle campaigns, expressed as data.
 *
 * The gap this fills: every nudge the server sent was tied to an *active shard*.
 * `inactivity-nudger` selected `Shard.find({ status: 'active' })` and messaged
 * the owner — so a user who signed up and never created a shard, or who let
 * everything lapse, received nothing at all, ever. That's the largest and most
 * recoverable drop-off cohort in the product and it had zero touches.
 *
 * Each campaign is a row: who it selects, what it says, how often it may repeat.
 * The runner walks them once per user per local morning. Adding a campaign is a
 * row here, not a new cron handler — which is the only way this stays tuneable.
 *
 * Budget still applies: all of these are `retention` priority, so at most one
 * lands per user per day (see DAILY_BUDGET in Notify.ts). Order matters —
 * earlier campaigns win the day's slot.
 */

import { User } from "../models/User.js";
import Shard from "../models/Shard.js";
import MiniGoal from "../models/MiniGoal.js";
import { notify, type NotifyKind } from "./Notify.js";
import { dateKeyInZone } from "./Timezone.js";
import { logError } from "./Helpers.js";
import { snapshotOf, REPAIR_WINDOW_DAYS } from "./Streak.js";

const DAY = 86_400_000;

export interface CampaignContext {
  userId: string;
  timezone?: string;
  /** `YYYY-MM-DD` in the user's zone. */
  dayKey: string;
  createdAt: Date;
  lastActive?: Date;
  daysSinceSignup: number;
  daysSinceActive: number;
  /** Shards the user owns that aren't finished. */
  openShardCount: number;
  /** Live, incomplete tasks due today in the user's zone. */
  tasksDueToday: number;
  /** Live, incomplete tasks whose due date has passed. */
  tasksOverdue: number;
  streak: ReturnType<typeof snapshotOf>;
  previousStreak: number;
  streakBrokenAt?: Date;
  /** Most recently touched open shard, for message copy and deep links. */
  focusShard?: { id: string; title: string; staleDays: number };
}

export interface CampaignMessage {
  kind: NotifyKind;
  title: string;
  body: string;
  data?: Record<string, string>;
  /** Overrides the default per-local-day dedupe. */
  dedupeKey?: string;
}

export interface Campaign {
  id: string;
  /** Cheap predicate over the prepared context. Pure — easy to unit test. */
  match: (ctx: CampaignContext) => boolean;
  /** The message to send, or null to skip after all. */
  build: (ctx: CampaignContext) => CampaignMessage | null;
}

/**
 * Ordered by expected value. The first match wins the day's retention slot, so
 * the most time-sensitive and most personal messages come first: a streak that
 * can still be saved beats a generic "you have tasks today".
 */
export const CAMPAIGNS: Campaign[] = [
  // ── 1. Streak just broke. The highest-leverage message in the product, and
  //       until the rollover job existed it could never fire: nothing set
  //       currentStreak to 0, so the "broken" audience was always empty.
  {
    id: "streak_broken",
    match: (ctx) =>
      ctx.streak.current === 0 &&
      ctx.previousStreak >= 3 &&
      !!ctx.streakBrokenAt &&
      Date.now() - ctx.streakBrokenAt.getTime() <= REPAIR_WINDOW_DAYS * DAY,
    build: (ctx) => ({
      kind: "streak_broken",
      title: `Your ${ctx.previousStreak}-day streak ended`,
      body: `You built ${ctx.previousStreak} days in a row. Repair it within ${REPAIR_WINDOW_DAYS} days or start fresh today — one task is all it takes.`,
      data: { screen: "/schedule", streakRepair: "1" },
      // One per break, not one per day of the break.
      dedupeKey: `break:${ctx.streakBrokenAt!.toISOString().slice(0, 10)}`,
    }),
  },

  // ── 2. Never activated: signed up, never created a shard. D1/D3/D7.
  {
    id: "activation",
    match: (ctx) =>
      ctx.openShardCount === 0 &&
      [1, 3, 7].includes(ctx.daysSinceSignup),
    build: (ctx) => {
      const copy: Record<number, { title: string; body: string }> = {
        1: {
          title: "Pick one goal",
          body: "You're one quest away from starting. Name something you want to get done and Shard will break it into steps.",
        },
        3: {
          title: "Still thinking it over?",
          body: "Most people start with something small — a book, a workout habit, a side project. Tell Shard the goal and it does the planning.",
        },
        7: {
          title: "Your first quest is waiting",
          body: "A week in and no quest yet. Two minutes now and you'll have a plan with dates on it.",
        },
      };
      const c = copy[ctx.daysSinceSignup];
      if (!c) return null;
      return {
        kind: "activation_nudge",
        title: c.title,
        body: c.body,
        data: { screen: "/new-shard" },
        dedupeKey: `activation:d${ctx.daysSinceSignup}`,
      };
    },
  },

  // ── 3. Dormant: has shards but hasn't opened the app. 7/14/30 days.
  {
    id: "dormant_winback",
    match: (ctx) => ctx.openShardCount > 0 && [7, 14, 30].includes(ctx.daysSinceActive),
    build: (ctx) => {
      const title = ctx.focusShard?.title;
      const copy: Record<number, string> = {
        7: title
          ? `"${title}" hasn't moved in a week. Pick the smallest task on it and close that one.`
          : "Your quests haven't moved in a week. Pick the smallest task and close that one.",
        14: title
          ? `Two weeks since you touched "${title}". Want to simplify it, or park it and start something else?`
          : "Two weeks away. Want to simplify what's open, or park it and start something else?",
        30: title
          ? `It's been a month. "${title}" is still here whenever you want it — or start something new.`
          : "It's been a month. Your quests are still here whenever you want them.",
      };
      const body = copy[ctx.daysSinceActive];
      if (!body) return null;
      return {
        kind: "dormant_winback",
        title: "Still with us?",
        body,
        data: ctx.focusShard
          ? { screen: "/Home", shardId: ctx.focusShard.id }
          : { screen: "/Home" },
        dedupeKey: `dormant:d${ctx.daysSinceActive}`,
      };
    },
  },

  // ── 4. Overdue work needing a decision. Replaces the silent nightly
  //       reschedule, which hid the problem and made due dates meaningless.
  {
    id: "tasks_missed",
    match: (ctx) => ctx.tasksOverdue > 0,
    build: (ctx) => ({
      kind: "tasks_missed",
      title: `${ctx.tasksOverdue} task${ctx.tasksOverdue > 1 ? "s" : ""} slipped`,
      body: `${ctx.tasksOverdue} task${ctx.tasksOverdue > 1 ? "s are" : " is"} past due. Move ${ctx.tasksOverdue > 1 ? "them" : "it"} to today, or drop ${ctx.tasksOverdue > 1 ? "them" : "it"} — either is better than carrying it.`,
      data: { screen: "/schedule" },
    }),
  },

  // ── 5. Work scheduled today. The bundled morning digest.
  {
    id: "daily_digest",
    match: (ctx) => ctx.tasksDueToday > 0,
    build: (ctx) => ({
      kind: "daily_digest",
      title: `${ctx.tasksDueToday} task${ctx.tasksDueToday > 1 ? "s" : ""} today`,
      body:
        ctx.streak.current > 0
          ? `${ctx.tasksDueToday} scheduled today. Finish one to keep your ${ctx.streak.current}-day streak.`
          : `${ctx.tasksDueToday} task${ctx.tasksDueToday > 1 ? "s" : ""} scheduled today. Start with the smallest one.`,
      data: { screen: "/schedule" },
    }),
  },

  // ── 6. Has shards but nothing scheduled — the at-risk user the old
  //       daily-task-reminder job skipped entirely, because it only fired when
  //       a task already existed for today.
  {
    id: "empty_schedule",
    match: (ctx) =>
      ctx.openShardCount > 0 &&
      ctx.tasksDueToday === 0 &&
      ctx.tasksOverdue === 0 &&
      ctx.daysSinceActive >= 2,
    build: (ctx) => ({
      kind: "empty_schedule",
      title: "Nothing on today",
      body: ctx.focusShard
        ? `Your schedule is clear. Want to pull the next step from "${ctx.focusShard.title}" into today?`
        : "Your schedule is clear. Pull one small step into today and keep the momentum.",
      data: ctx.focusShard
        ? { screen: "/schedule", shardId: ctx.focusShard.id }
        : { screen: "/schedule" },
    }),
  },

  // ── 7. A shard has gone quiet while the user is still active. Lowest
  //       priority because it's the least time-critical.
  {
    id: "inactivity_nudge",
    match: (ctx) => !!ctx.focusShard && ctx.focusShard.staleDays >= 5 && ctx.daysSinceActive <= 2,
    build: (ctx) => ({
      kind: "inactivity_nudge",
      title: "One quest is stalling",
      body: `"${ctx.focusShard!.title}" hasn't moved in ${ctx.focusShard!.staleDays} days. Break the next step into something you can finish in ten minutes.`,
      data: { screen: "/Home", shardId: ctx.focusShard!.id },
      // At most one nudge per shard per week.
      dedupeKey: `stale:${ctx.focusShard!.id}:${Math.floor(Date.now() / (7 * DAY))}`,
    }),
  },
];

/**
 * Assemble the context one campaign evaluation needs.
 *
 * One pass over the user's shards and mini-goals, so the runner costs a bounded
 * number of queries per user rather than one per campaign.
 */
export async function buildContext(user: any): Promise<CampaignContext> {
  const userId = user._id.toString();
  const timezone = user.timezone as string | undefined;
  const dayKey = dateKeyInZone(new Date(), timezone);
  const now = Date.now();

  const createdAt = user.createdAt ? new Date(user.createdAt) : new Date();
  const lastActive = user.lastActive ? new Date(user.lastActive) : undefined;

  const shards = await Shard.find({
    owner: userId,
    status: { $in: ["active", "paused", "at_risk", "stalled"] },
  })
    .select("_id title lastActivityAt")
    .sort({ lastActivityAt: -1 })
    .lean();

  let focusShard: CampaignContext["focusShard"];
  if (shards.length > 0) {
    const s: any = shards[0];
    const last = s.lastActivityAt ? new Date(s.lastActivityAt).getTime() : createdAt.getTime();
    focusShard = {
      id: s._id.toString(),
      title: s.title,
      staleDays: Math.floor((now - last) / DAY),
    };
  }

  // Task counts, bucketed against the USER's day — not the server's.
  let tasksDueToday = 0;
  let tasksOverdue = 0;
  if (shards.length > 0) {
    const miniGoals = await MiniGoal.find({
      shardId: { $in: shards.map((s: any) => s._id) },
      completed: false,
    })
      .select("tasks")
      .lean();

    for (const mg of miniGoals as any[]) {
      for (const t of mg.tasks ?? []) {
        if (t.completed || t.deleted || !t.dueDate) continue;
        const key = dateKeyInZone(new Date(t.dueDate), timezone);
        if (key === dayKey) tasksDueToday++;
        else if (key < dayKey) tasksOverdue++;
      }
    }
  }

  return {
    userId,
    timezone,
    dayKey,
    createdAt,
    lastActive,
    daysSinceSignup: Math.floor((now - createdAt.getTime()) / DAY),
    daysSinceActive: lastActive
      ? Math.floor((now - lastActive.getTime()) / DAY)
      : Math.floor((now - createdAt.getTime()) / DAY),
    openShardCount: shards.length,
    tasksDueToday,
    tasksOverdue,
    streak: snapshotOf(user),
    previousStreak: user.previousStreak ?? 0,
    streakBrokenAt: user.streakBrokenAt ? new Date(user.streakBrokenAt) : undefined,
    focusShard,
  };
}

/** Fields `buildContext` and the campaigns read. */
export const CAMPAIGN_USER_FIELDS =
  "timezone createdAt lastActive currentStreak longestStreak previousStreak lastStreakDayKey streakFreezeTokens streakBrokenAt subscriptionTier trialStartedAt trialEndsAt firstQuestCompletedAt";

/**
 * Evaluate the campaign list for one user and send at most one message.
 * Returns the campaign id that fired, or null.
 */
export async function runCampaignsForUser(user: any): Promise<string | null> {
  try {
    const ctx = await buildContext(user);

    for (const campaign of CAMPAIGNS) {
      if (!campaign.match(ctx)) continue;
      const message = campaign.build(ctx);
      if (!message) continue;

      const result = await notify({
        userId: ctx.userId,
        kind: message.kind,
        title: message.title,
        body: message.body,
        data: message.data,
        dedupeKey: message.dedupeKey,
        emailData: { shardTitle: ctx.focusShard?.title },
      });

      // Suppressed by budget or dedupe: the user has already had their message
      // today, so stop rather than walking down to a weaker campaign.
      if (result.reason === "budget") return null;
      if (result.recorded) return campaign.id;
      // Deduped or preference-blocked: try the next campaign down.
    }
  } catch (error) {
    logError("runCampaignsForUser", error);
  }
  return null;
}
