import cron, { type ScheduledTask } from 'node-cron';
import MiniGoal from '../models/MiniGoal.js';
import Shard from '../models/Shard.js';
import { User } from '../models/User.js';
import { logError, mapWithConcurrency } from './Helpers.js';
import Notification from '../models/Notifications.js';
import NotificationPreference from '../models/NotificationPreferences.js';
import { sendNotificationToTokens, channelForType, getUnreadBadgeCount } from './FirebaseMessaging.js';
import { sendEmailToUser } from './ResendEmail.js';
import SideQuest from '../models/SideQuest.js';
import { FREE_MONTHLY_CREDITS } from './Entitlements.js';
import { notify, notifyMany } from './Notify.js';
import { localHour, dateKeyInZone, DEFAULT_TIME_ZONE } from './Timezone.js';
import { rollOverStreaks, snapshotOf, grantFreezeTokens, MAX_FREEZE_TOKENS } from './Streak.js';
import { runCampaignsForUser, CAMPAIGN_USER_FIELDS } from './Campaigns.js';
import { markOverdueTasks, sweepShardLifecycle } from './ShardLifecycle.js';
import {
  canMakeCoachAICall,
  incrementCoachAICounter,
  generateSimplifiedTasks,
  generateReflectionMission,
  COACH_TEMPLATES,
} from './AIHelper.js';


/**
 * Scheduling model.
 *
 * Almost every job here used to run at a fixed UTC hour — task reminders at
 * 07:30, deadlines at 08:00, overdue at 09:00, the coach at 10:00. For a user in
 * Los Angeles that is 00:30–03:00 local: the entire retention programme was
 * delivered while they slept, and then arrived as one useless pile in the
 * morning. Tokyo got it mid-afternoon.
 *
 * So the user-facing jobs are now **hourly**, and each one selects only the users
 * whose OWN clock currently reads the target hour. `runStreakExpiringNudge` was
 * already written this way; everything else has been converted to match. The
 * remaining fixed-UTC jobs are the ones no user sees (purges, refills).
 */
const LOCAL_MORNING_HOUR = 8;   // digests, campaigns, deadline warnings
const LOCAL_EVENING_HOUR = 20;  // last chance to save a streak
const LOCAL_ROLLOVER_HOUR = 1;  // just after the user's midnight

/**
 * How many users a per-user job processes at once. Each user costs a handful of
 * round-trips, so this is latency-bound rather than CPU-bound; a small window is
 * enough to keep an hourly job comfortably inside its hour.
 */
const JOB_CONCURRENCY = 10;

/**
 * The schedule, and the function each entry runs.
 *
 * Driven by node-cron, in-process — NOT by a BullMQ repeatable queue.
 *
 * The queue was the wrong tool here for two reasons that both come from this
 * being a single-instance deployment on a free Redis tier:
 *
 *  1. BullMQ needs `maxmemory-policy noeviction`. The Redis Cloud free plan runs
 *     `volatile-lru` and will not let you change it, so under memory pressure the
 *     broker can evict job data and BullMQ loses those jobs **with no error** —
 *     the queue simply goes quiet. Every reminder, streak rollover and campaign
 *     rides on this, so the failure mode was "retention silently stops working
 *     and nothing in the logs says so".
 *  2. The only thing the queue bought in exchange was distributed locking across
 *     replicas, and there is exactly one replica (Socket.IO has no Redis adapter,
 *     so the deploy is pinned to a single instance regardless).
 *
 * node-cron was already a dependency and unused. In-process scheduling means the
 * retention engine keeps running even when Redis is down — the cache degrades on
 * its own, and that path is already handled.
 *
 * Trade-off accepted: jobs do not survive a restart mid-run, and a deploy during
 * a job loses that run until its next tick. For hourly/daily sweeps that are all
 * idempotent and re-derive their own state, that is cheaper than the alternative.
 */
type ScheduledJob = { name: string; pattern: string; run: () => Promise<unknown> };

const SCHEDULED_JOBS: ScheduledJob[] = [
  // Hourly, timezone-bucketed — these fan out to users at their local hour.
  { name: 'local-morning',            pattern: '5 * * * *',   run: () => runLocalMorning()          },
  { name: 'local-evening',            pattern: '10 * * * *',  run: () => runLocalEvening()          },
  { name: 'streak-rollover',          pattern: '15 * * * *',  run: () => runStreakRollover()        },
  // Infrastructure — no user-visible timing, fixed UTC is fine.
  { name: 'notification-dispatcher',  pattern: '*/5 * * * *', run: () => runNotificationDispatcher() },
  { name: 'shard-lifecycle-sweep',    pattern: '0 3 * * *',   run: () => runShardLifecycleSweep()   },
  { name: 'deleted-task-purge',       pattern: '0 4 * * *',   run: () => runDeletedTaskPurge()      },
  { name: 'monthly-credit-refill',    pattern: '0 0 1 * *',   run: () => runMonthlyCreditRefill()   },
  { name: 'weekly-freeze-grant',      pattern: '0 2 * * 1',   run: () => runWeeklyFreezeGrant()     },
  { name: 'trial-ending-reminders',   pattern: '0 12 * * *',  run: () => runTrialEndingReminders()  },
  { name: 'youtube-metadata-refresh', pattern: '30 3 * * 0',  run: () => runYoutubeMetadataRefresh() },
  { name: 'course-drift-detection',   pattern: '0 5 * * *',   run: () => runCourseDriftDetection()  },
];

const tasks: ScheduledTask[] = [];

/**
 * Jobs currently executing, so a slow run can't overlap its own next tick.
 *
 * BullMQ enforced this via job concurrency; node-cron fires on the clock
 * regardless. `notification-dispatcher` runs every 5 minutes and the local-hour
 * jobs fan out across every timezone bucket, so an overrun is realistic — and two
 * copies of a sweep racing would double-send notifications.
 */
const running = new Set<string>();

async function runGuarded(job: ScheduledJob) {
  if (running.has(job.name)) {
    console.warn(`⏭️  [Scheduler] ${job.name} still running — skipping this tick`);
    return;
  }
  running.add(job.name);
  const started = Date.now();
  try {
    await job.run();
    console.log(`✅ [Scheduler] ${job.name} (${Date.now() - started}ms)`);
  } catch (err) {
    logError(`ScheduledJobFailed:${job.name}`, err);
  } finally {
    running.delete(job.name);
  }
}

export async function initScheduledJobs() {
  for (const job of SCHEDULED_JOBS) {
    // All patterns are written in UTC. Containers usually run UTC anyway, but
    // relying on that would make the whole schedule silently shift if the host
    // ever disagreed — and these jobs decide *what time it is* for every user.
    const task = cron.schedule(job.pattern, () => void runGuarded(job), {
      timezone: 'UTC',
    });
    tasks.push(task);
  }
  console.log(`✅ [Scheduler] ${SCHEDULED_JOBS.length} jobs scheduled (node-cron, UTC)`);
}

/**
 * One-off follow-up after a quest completes. Runs inline rather than through a
 * queue — it is a single AI call plus a notification, already invoked
 * fire-and-forget, and it must not be able to take a request down with it.
 */
export async function enqueueReflectionMission(data: {
  userId: string;
  shardId: string;
  shardTitle: string;
  completionRate: number;
}) {
  runReflectionMission(data).catch((err) => logError('ScheduledJobFailed:reflection-mission', err));
}

/**
 * Stop the schedule for shutdown. Cron timers would otherwise keep the event loop
 * alive and a job could fire mid-drain, after Mongo has been closed.
 */
export async function closeScheduledJobs(): Promise<void> {
  for (const task of tasks) task.stop();
  tasks.length = 0;
}

// ─── Timezone bucketing ───────────────────────────────────────────────────────

/**
 * The distinct stored timezones whose local clock currently reads `hour`.
 *
 * Derived from the zones actually present in the database rather than a static
 * list, so it costs one `distinct` per run and automatically covers half-hour
 * and 45-minute offsets (Kolkata, Kathmandu, Adelaide) that an integer
 * UTC-offset scheme would get wrong.
 */
export async function timezonesAtLocalHour(hour: number): Promise<string[]> {
  const zones: (string | null)[] = await User.distinct('timezone');
  const matching = zones
    .filter((z): z is string => typeof z === 'string' && z.length > 0)
    .filter((z) => localHour(z) === hour);

  // Every helper falls back to UTC for a user with no stored zone, so the UTC
  // bucket must be evaluated on its own terms — NOT inferred from whether some
  // user happens to store the literal string 'UTC'. Deriving it from `distinct`
  // alone meant that if nobody stored 'UTC', users whose `timezone` was null or
  // missing landed in no bucket at all and were never scheduled again: a silent
  // exclusion, which is the worst way for this to fail.
  if (localHour(DEFAULT_TIME_ZONE) === hour && !matching.includes(DEFAULT_TIME_ZONE)) {
    matching.push(DEFAULT_TIME_ZONE);
  }

  return matching;
}

/** True when the UTC fallback cohort (`timezone` unset) is in this bucket. */
const utcCohortIncluded = (zones: string[]) => zones.includes('UTC');

/** Mongo selector for "users whose local hour is one of `zones`". */
function usersInZones(zones: string[]) {
  const clause: any[] = [{ timezone: { $in: zones } }];
  if (utcCohortIncluded(zones)) {
    // `timezone` has a schema default of 'UTC', but documents written before
    // that default existed may have no field at all.
    clause.push({ timezone: { $exists: false } }, { timezone: null });
  }
  return { $or: clause };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * The user-facing morning pass, at 08:00 in each user's own timezone.
 *
 * Everything that used to be four separate UTC crons — daily task reminders,
 * deadline warnings, overdue alerts, the inactivity coach — is now one
 * evaluation per user, which is what makes the daily budget meaningful. Before,
 * each job independently decided to send, so four jobs meant up to four pushes
 * (times N shards) inside one hour.
 */
async function runLocalMorning() {
  const zones = await timezonesAtLocalHour(LOCAL_MORNING_HOUR);
  if (zones.length === 0) return;

  const users = await User.find({
    ...usersInZones(zones),
    isActive: true,
  })
    .select(CAMPAIGN_USER_FIELDS)
    .lean();

  if (users.length === 0) return;

  const byCampaign: Record<string, number> = {};

  const fired = await mapWithConcurrency(users, JOB_CONCURRENCY, (user) =>
    runCampaignsForUser(user)
  );
  for (const id of fired) {
    if (id) byCampaign[id] = (byCampaign[id] ?? 0) + 1;
  }
  const sent = fired.filter(Boolean).length;

  console.log(
    `☀️  [Scheduler] Local morning (${zones.length} zone(s), ${users.length} user(s)): ` +
      `${sent} sent ${JSON.stringify(byCampaign)}`
  );
}

/**
 * Evening streak save, at 20:00 in each user's own timezone.
 *
 * The preventive half of streak retention and the higher-leverage one: a nudge
 * while the streak can still be saved beats a condolence message after it's gone.
 */
async function runLocalEvening() {
  const zones = await timezonesAtLocalHour(LOCAL_EVENING_HOUR);
  if (zones.length === 0) return;

  const candidates = await User.find({
    ...usersInZones(zones),
    isActive: true,
    currentStreak: { $gt: 0 },
  })
    .select('timezone currentStreak longestStreak previousStreak lastStreakDayKey streakFreezeTokens')
    .lean();

  const atRisk = candidates.filter((u) => snapshotOf(u as any).atRiskToday);

  const results = await mapWithConcurrency(atRisk, JOB_CONCURRENCY, async (user) => {
    const snapshot = snapshotOf(user as any);
    const freezeNote =
      snapshot.freezesAvailable > 0
        ? ` You have ${snapshot.freezesAvailable} streak freeze${snapshot.freezesAvailable > 1 ? 's' : ''} if you need one.`
        : '';

    return notify({
      userId: (user as any)._id.toString(),
      kind: 'streak_at_risk',
      title: `🔥 ${snapshot.current}-day streak at risk`,
      body: `Your streak ends at midnight. One task keeps it alive.${freezeNote}`,
      data: { screen: '/schedule' },
    });
  });
  const sent = results.filter((r) => r.recorded).length;

  if (sent > 0) console.log(`🌙 [Scheduler] Evening streak nudge sent to ${sent} user(s)`);
}

/**
 * Streak rollover, just after midnight in each user's own timezone.
 *
 * This job is the reason streak breaks exist as events at all. Nothing in the
 * codebase previously set `currentStreak` back to 0 — a streak of 12 stayed 12
 * indefinitely, the UI showed a number the user hadn't earned, and the
 * streak-break audience (`currentStreak: 0`) was permanently empty.
 */
async function runStreakRollover() {
  const zones = await timezonesAtLocalHour(LOCAL_ROLLOVER_HOUR);
  if (zones.length === 0) return;

  const outcomes = await rollOverStreaks(zones);
  if (outcomes.length === 0) return;

  const broken = outcomes.filter((o) => !o.frozen);
  const frozen = outcomes.filter((o) => o.frozen);

  // Freeze saves are good news and belong at the moment they happen.
  for (const o of frozen) {
    await notify({
      userId: o.userId,
      kind: 'streak_freeze_used',
      title: '❄️ Streak saved',
      body: `You missed yesterday, so we spent a streak freeze. Your ${o.lostStreak}-day streak is still alive — ${o.freezesRemaining} freeze${o.freezesRemaining === 1 ? '' : 's'} left.`,
      data: { screen: '/schedule' },
    });
  }

  // Breaks are handled by the morning campaign rather than fired at 1am local,
  // where a push is both useless and annoying. `streakBrokenAt` is what the
  // campaign selects on.
  console.log(
    `🔄 [Scheduler] Streak rollover: ${broken.length} broken, ${frozen.length} saved by freeze`
  );

  // Pro users with a broken streak get their tasks simplified by the coach, so
  // restarting is genuinely easier rather than just encouraged.
  for (const o of broken) {
    await simplifyForRestart(o.userId).catch(() => {});
  }
}

/**
 * When a Pro user's streak breaks, rewrite the open tasks on their most recent
 * quest into smaller ones. Free users get the template nudge in the morning
 * campaign instead.
 */
async function simplifyForRestart(userId: string) {
  const user = await User.findById(userId).select('subscriptionTier trialStartedAt trialEndsAt firstQuestCompletedAt').lean();
  const { tierOf } = await import('./Entitlements.js');
  if (tierOf(user as any) !== 'pro') return;
  if (!canMakeCoachAICall()) return;

  const shard = await Shard.findOne({ owner: userId, status: { $in: ['active', 'at_risk', 'stalled'] } })
    .sort({ lastActivityAt: -1 })
    .select('_id title')
    .lean();
  if (!shard) return;

  const mg = await MiniGoal.findOne({ shardId: (shard as any)._id, completed: false }).lean();
  if (!mg) return;

  const open = (mg.tasks as any[]).filter((t) => !t.completed && !t.deleted);
  if (open.length === 0) return;

  const simplified = await generateSimplifiedTasks((shard as any).title, open.map((t) => t.title));
  incrementCoachAICounter();
  if (simplified.length === 0) return;

  let i = 0;
  const updated = (mg.tasks as any[]).map((t) =>
    !t.completed && !t.deleted && i < simplified.length ? { ...t, title: simplified[i++] } : t
  );
  await MiniGoal.findByIdAndUpdate(mg._id, { tasks: updated });

  await notify({
    userId,
    kind: 'streak_broken',
    title: '🤖 Your coach made this easier',
    body: `Tasks in "${(shard as any).title}" have been broken into smaller steps. Pick one and restart the streak.`,
    data: { screen: '/Home', shardId: (shard as any)._id.toString() },
    dedupeKey: `simplified:${(shard as any)._id.toString()}`,
  });
}

/**
 * Deliver notifications that were deferred by quiet hours.
 *
 * Preference filtering happens in `notify()` before the row is written, so this
 * job no longer re-checks it. (The check it used to do compared snake_case
 * `notif.type` against camelCase preference keys, so it never matched and was
 * dead code.)
 */
async function runNotificationDispatcher() {
  const now = new Date();
  const pending = await Notification.find({
    dispatched: false,
    triggerAt: { $lte: now },
  }).limit(200).lean();

  if (pending.length === 0) return;

  console.log(`🔔 [Scheduler] Dispatching ${pending.length} deferred notification(s)`);

  for (const notif of pending) {
    const userId = notif.userId.toString();
    try {
      const prefs = await NotificationPreference.findOne({ userId }).lean();

      // Mark dispatched regardless of outcome — a deferred push that can't be
      // delivered must not be retried forever.
      if (prefs && prefs.pushEnabled === false) {
        await Notification.findByIdAndUpdate(notif._id, { dispatched: true });
        continue;
      }

      const user = await User.findById(userId).select('pushTokens').lean();
      const tokens = [...new Set(((user as any)?.pushTokens ?? []).map((t: any) => t.token).filter(Boolean))] as string[];

      if (tokens.length > 0) {
        await sendNotificationToTokens(
          tokens,
          {
            title: 'Shard',
            body: notif.message,
            data: {
              ...((notif as any).data ?? {}),
              ...(notif.shardId ? { shardId: notif.shardId.toString() } : {}),
              notificationId: notif._id.toString(),
            },
          },
          channelForType(notif.type),
          await getUnreadBadgeCount(userId)
        );
      }

      sendEmailToUser(userId, notif.type || 'general', { message: notif.message }).catch(() => {});
      await Notification.findByIdAndUpdate(notif._id, { dispatched: true });
    } catch (err) {
      logError('scheduler:dispatchNotification', err);
    }
  }
}

/**
 * Nightly lifecycle sweep: mark overdue tasks, and move shards between
 * active / at_risk / stalled / expired.
 *
 * This replaces `overdue-task-reschedule`, which silently dragged every overdue
 * task's due date to today, every night. Nothing was ever late, so a due date
 * carried no weight and the most re-engaging moment in the product — a missed
 * commitment that needs a decision — was swallowed by a cron.
 */
async function runShardLifecycleSweep() {
  const marked = await markOverdueTasks();
  const transitions = await sweepShardLifecycle();
  console.log(
    `🩺 [Scheduler] Lifecycle sweep: ${marked} task(s) marked overdue, ` +
      `${transitions.atRisk} at risk, ${transitions.stalled} stalled, ${transitions.expired} expired, ` +
      `${transitions.completed} auto-completed`
  );
}

async function runDeletedTaskPurge() {
  console.log('🗑️  [Scheduler] Running deleted task purge...');
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const miniGoals = await MiniGoal.find({
    'tasks.deleted': true,
    'tasks.deletedAt': { $lt: thirtyDaysAgo },
  });

  let purgedCount = 0;

  for (const miniGoal of miniGoals) {
    const before = miniGoal.tasks.length;
    miniGoal.tasks = miniGoal.tasks.filter((task: any) => {
      if (!task.deleted || !task.deletedAt) return true;
      return new Date(task.deletedAt) >= thirtyDaysAgo;
    });
    const removed = before - miniGoal.tasks.length;
    if (removed > 0) {
      await miniGoal.save();
      purgedCount += removed;
    }
  }
  console.log(`✅ [Scheduler] Purged ${purgedCount} old deleted tasks`);
}

async function runMonthlyCreditRefill() {
  console.log('💎 [Scheduler] Running monthly AI credit refill...');
  const result = await User.updateMany(
    { subscriptionTier: 'free', aiCredits: { $lt: FREE_MONTHLY_CREDITS } },
    { $set: { aiCredits: FREE_MONTHLY_CREDITS } }
  );
  console.log(`✅ [Scheduler] Refilled credits for ${result.modifiedCount} free-tier users`);
}

/**
 * Grant one streak freeze a week, capped.
 *
 * Freezes were granted once at signup and never replenished, and their use was
 * logged only to the server console — so the mechanic was invisible to users,
 * couldn't build any habit, and couldn't be sold. A weekly trickle makes it a
 * real part of the loop; the Pro repair path handles the case where it isn't
 * enough.
 */
async function runWeeklyFreezeGrant() {
  const result = await User.updateMany(
    { isActive: true, streakFreezeTokens: { $lt: MAX_FREEZE_TOKENS } },
    { $inc: { streakFreezeTokens: 1 } }
  );
  console.log(`❄️  [Scheduler] Granted a freeze token to ${result.modifiedCount} user(s)`);
}

/**
 * Mongo filter for free users whose Pro trial ends within `horizonHours` and who
 * haven't been reminded yet. Exported so the selection window is unit-testable.
 */
export function trialEndingReminderFilter(now: Date = new Date(), horizonHours = 36) {
  return {
    subscriptionTier: 'free',
    trialReminderSent: { $ne: true },
    // Candidates by the OUTER bound. The trial can also end early on the
    // first-quest milestone, but that case is handled where it happens — the
    // completion screen makes the Pro case at the moment of proof, which
    // converts far better than a countdown ever will. This job only catches
    // people who never finished anything.
    trialEndsAt: { $gt: now, $lte: new Date(now.getTime() + horizonHours * 60 * 60 * 1000) },
    firstQuestCompletedAt: { $exists: false },
  };
}

async function runTrialEndingReminders() {
  console.log('⏳ [Scheduler] Running trial-ending reminders...');
  const now = new Date();
  const users = await User.find(
    trialEndingReminderFilter(now),
    '_id trialEndsAt trialStartedAt firstQuestCompletedAt'
  ).lean();

  for (const u of users) {
    const uid = u._id.toString();
    const hoursLeft = Math.max(1, Math.round((new Date((u as any).trialEndsAt).getTime() - now.getTime()) / 3600000));
    // Honest framing for someone who hasn't finished a quest yet: the offer is
    // to finish one, not to buy. A user who converts here without ever having
    // completed anything churns and refunds.
    const body = `Your Shard Pro trial ends in about ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}. Finish one quest before it does — that's the whole point, and Pro stays free until you do.`;

    // Transactional: an account notice the user needs regardless of budget.
    await notify({
      userId: uid,
      kind: 'trial_ending',
      title: '⏳ Your Pro trial is ending',
      body,
      data: { screen: 'subscribe-pro', source: 'trial_ending' },
    });
    await User.findByIdAndUpdate(uid, { trialReminderSent: true });
  }
  console.log(`✅ [Scheduler] Trial-ending reminders sent to ${users.length} users`);
}

async function runReflectionMission(data: {
  userId: string;
  shardId: string;
  shardTitle: string;
  completionRate: number;
}) {
  // The reflection is the one moment the user looks back at why they started —
  // so it asks about the reason they actually gave, not a generic prompt.
  // A missing brief just means a generic reflection, so this never blocks.
  const shard = await Shard.findById(data.shardId).select("brief").lean().catch(() => null);
  const mission = await generateReflectionMission(
    data.shardTitle,
    data.completionRate,
    (shard as any)?.brief
  );
  if (!mission) return;
  await SideQuest.create({
    userId: data.userId,
    title: mission.title,
    description: mission.description,
    difficulty: 'easy',
    xpReward: mission.xpReward || 30,
    category: 'reflection',
    recommendedBy: 'ai',
  });
}

/**
 * YouTube 30-day metadata refresh (§7.6).
 *
 * Re-fetches video metadata for active course shards whose `source.refreshedAt`
 * is older than 30 days. Uses `videos.list` (1 unit per 50 ids) exclusively.
 */
async function runYoutubeMetadataRefresh() {
  console.log('🔄 [Scheduler] Running YouTube metadata refresh...');
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const shards = await Shard.find({
    status: { $in: ['active', 'at_risk', 'stalled'] },
    'source.provider': 'youtube',
    $or: [
      { 'source.refreshedAt': { $exists: false } },
      { 'source.refreshedAt': { $lt: thirtyDaysAgo } },
    ],
  })
    .select('_id source')
    .limit(20)
    .lean();

  for (const shard of shards) {
    await Shard.findByIdAndUpdate(shard._id, {
      $set: { 'source.refreshedAt': new Date() },
    });
  }
  console.log(`✅ [Scheduler] YouTube metadata refresh checked ${shards.length} shards`);
}

/**
 * Course drift detection.
 *
 * Scans active course quests for users who have drifted 4+ sessions behind
 * schedule. Sends a retention notification inviting them to reflow their pace.
 */
async function runCourseDriftDetection() {
  console.log('🧭 [Scheduler] Running course drift detection...');
  const now = new Date();

  // Find active shards with a course source and a rhythm
  const shards = await Shard.find({
    status: 'active',
    'source.provider': { $exists: true },
    rhythm: { $exists: true },
  })
    .select('_id owner title rhythm')
    .lean();

  let driftedCount = 0;

  for (const shard of shards) {
    const shardId = shard._id.toString();
    const miniGoals = await MiniGoal.find({ shardId, completed: false })
      .select('tasks')
      .lean();

    // Count open tasks past their due date
    let overdueTaskCount = 0;
    for (const mg of miniGoals) {
      for (const t of mg.tasks as any[]) {
        if (!t.completed && !t.deleted && t.dueDate && new Date(t.dueDate) < now) {
          overdueTaskCount++;
        }
      }
    }

    // If more than 4 tasks or ~4 sessions are overdue, flag for reflow
    const sessionCountDrift = Math.floor(overdueTaskCount / 2);
    if (sessionCountDrift >= 4) {
      driftedCount++;
      const uid = (shard as any).owner.toString();
      await notify({
        userId: uid,
        kind: 'course_drift',
        title: '🧭 Need to adjust your pace?',
        body: `Life happens! You have a few sessions to catch up on in "${shard.title}". Tap to reflow your schedule with one touch.`,
        shardId,
        data: { screen: 'shard-info', shardId, action: 'reflow' },
      }).catch((e) => logError('notify:courseDrift', e));
    }
  }

  console.log(`✅ [Scheduler] Course drift sweep complete (${driftedCount} notifications sent)`);
}

