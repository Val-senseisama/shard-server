import { Queue, Worker, Job } from 'bullmq';
import { connection } from './Queue.js';
import MiniGoal from '../models/MiniGoal.js';
import Shard from '../models/Shard.js';
import { User } from '../models/User.js';
import { logError } from './Helpers.js';
import { createNotification } from '../schema/resolvers/Notifications.js';
import { sendNotificationToUser, sendNotificationToTokens } from './FirebaseMessaging.js';
import Notification from '../models/Notifications.js';
import NotificationPreference from '../models/NotificationPreferences.js';
import { sendEmailToUser } from './ResendEmail.js';
import SideQuest from '../models/SideQuest.js';
import {
  canMakeCoachAICall,
  incrementCoachAICounter,
  generateInactivityNudge,
  generateSimplifiedTasks,
  generateStretchGoal,
  generateReflectionMission,
  COACH_TEMPLATES,
} from './AIHelper.js';

const shardQueue = new Queue('shard-jobs', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 50 },
  },
});

const SCHEDULED_JOBS = [
  { name: 'overdue-task-reschedule',  pattern: '0 3 * * *'   },
  { name: 'deleted-task-purge',       pattern: '0 4 * * *'   },
  { name: 'daily-task-reminders',     pattern: '30 7 * * *'  },
  { name: 'deadline-reminders',       pattern: '0 8 * * *'   },
  { name: 'overdue-alerts',           pattern: '0 9 * * *'   },
  { name: 'inactivity-nudger',        pattern: '0 10 * * *'  },
  { name: 'streak-event-detector',    pattern: '0 11 * * *'  },
  { name: 'notification-dispatcher',  pattern: '*/5 * * * *' },
];

export async function initScheduledJobs() {
  // BullMQ requires noeviction — set it once on startup (Railway Redis supports CONFIG SET)
  await connection.config('SET', 'maxmemory-policy', 'noeviction').catch(() => {});

  for (const { name, pattern } of SCHEDULED_JOBS) {
    await shardQueue.add(name, {}, { repeat: { pattern } });
  }
  console.log('✅ [Scheduler] Repeatable jobs registered');
}

export async function enqueueReflectionMission(data: {
  userId: string;
  shardId: string;
  shardTitle: string;
  completionRate: number;
}) {
  await shardQueue.add('reflection-mission', data);
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker('shard-jobs', async (job: Job) => {
  switch (job.name) {
    case 'overdue-task-reschedule':  return runOverdueTaskReschedule();
    case 'deleted-task-purge':       return runDeletedTaskPurge();
    case 'daily-task-reminders':     return runDailyTaskReminders();
    case 'deadline-reminders':       return runDeadlineReminders();
    case 'overdue-alerts':           return runOverdueAlerts();
    case 'inactivity-nudger':        return runInactivityNudger();
    case 'streak-event-detector':    return runStreakEventDetector();
    case 'notification-dispatcher':  return runNotificationDispatcher();
    case 'reflection-mission':       return runReflectionMission(job.data);
  }
}, { connection });

worker.on('failed', (job, err) => {
  logError(`ScheduledJobFailed:${job?.name}`, err);
});

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function runDeadlineReminders() {
  console.log('🔔 [Scheduler] Running deadline reminders...');
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const dayAfterTomorrow = new Date(tomorrow);
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

  const miniGoals = await MiniGoal.find({
    completed: false,
    dueDate: { $gte: tomorrow, $lt: dayAfterTomorrow },
  }).lean();

  for (const miniGoal of miniGoals) {
    const shard = await Shard.findById(miniGoal.shardId)
      .select('owner participants status title').lean();
    if (!shard || shard.status === 'completed') continue;

    const userIds = new Set<string>([shard.owner.toString()]);
    (shard.participants as any[])?.forEach((p: any) => userIds.add(p.user.toString()));

    for (const userId of userIds) {
      await createNotification(userId, `"${miniGoal.title}" is due tomorrow`, 'quest_deadline', {
        shardId: shard._id.toString(),
        miniGoalId: miniGoal._id.toString(),
      });
    }
  }
  console.log(`✅ [Scheduler] Deadline reminders sent (${miniGoals.length} mini-goals)`);
}

async function runOverdueAlerts() {
  console.log('⚠️  [Scheduler] Running overdue alerts...');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const miniGoals = await MiniGoal.find({
    completed: false,
    dueDate: { $lt: today },
    $or: [
      { overdueNotifiedAt: { $exists: false } },
      { overdueNotifiedAt: { $lt: today } },
    ],
  }).lean();

  for (const miniGoal of miniGoals) {
    const shard = await Shard.findById(miniGoal.shardId)
      .select('owner participants status title').lean();
    if (!shard || shard.status === 'completed') continue;

    const userIds = new Set<string>([shard.owner.toString()]);
    (shard.participants as any[])?.forEach((p: any) => userIds.add(p.user.toString()));

    for (const userId of userIds) {
      await createNotification(userId, `"${miniGoal.title}" is overdue — don't give up!`, 'quest_deadline', {
        shardId: shard._id.toString(),
        miniGoalId: miniGoal._id.toString(),
      });
    }

    await MiniGoal.findByIdAndUpdate(miniGoal._id, { overdueNotifiedAt: new Date() });
  }
  console.log('✅ [Scheduler] Overdue alerts sent');
}

async function runOverdueTaskReschedule() {
  console.log('🕐 [Scheduler] Running overdue task reschedule...');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const miniGoals = await MiniGoal.find({
    completed: false,
    'tasks.completed': false,
    'tasks.deleted': false,
    'tasks.dueDate': { $lt: today },
  });

  let rescheduledCount = 0;

  for (const miniGoal of miniGoals) {
    let updated = false;
    for (const task of miniGoal.tasks) {
      if (task.completed || task.deleted || !task.dueDate) continue;
      const taskDate = new Date(task.dueDate);
      taskDate.setHours(0, 0, 0, 0);
      if (taskDate < today) {
        if (!task.rescheduled) task.originalDueDate = task.dueDate;
        task.dueDate = new Date(today);
        task.rescheduled = true;
        updated = true;
        rescheduledCount++;
      }
    }
    if (updated) await miniGoal.save();
  }
  console.log(`✅ [Scheduler] Rescheduled ${rescheduledCount} overdue tasks`);
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

async function runDailyTaskReminders() {
  console.log('📋 [Scheduler] Running daily task reminders...');
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  const miniGoals = await MiniGoal.find({
    completed: false,
    'tasks.completed': false,
    'tasks.deleted': { $ne: true },
    'tasks.dueDate': { $gte: todayStart, $lt: todayEnd },
  }).lean();

  if (miniGoals.length === 0) {
    console.log('📋 [Scheduler] No tasks due today');
    return;
  }

  const shardIds = [...new Set(miniGoals.map((mg: any) => mg.shardId.toString()))];
  const shards = await Shard.find({
    _id: { $in: shardIds },
    status: { $in: ['active', 'paused'] },
  }).select('owner participants title').lean();

  const userTaskCounts = new Map<string, { count: number; shardTitles: Set<string> }>();

  for (const shard of shards) {
    const shardMiniGoals = miniGoals.filter((mg: any) => mg.shardId.toString() === shard._id.toString());
    let taskCount = 0;

    for (const mg of shardMiniGoals) {
      taskCount += (mg.tasks as any[]).filter((t: any) => {
        if (t.completed || t.deleted || !t.dueDate) return false;
        const d = new Date(t.dueDate);
        return d >= todayStart && d < todayEnd;
      }).length;
    }

    if (taskCount === 0) continue;

    const userIds = new Set<string>([shard.owner.toString()]);
    (shard.participants as any[])?.forEach((p: any) => userIds.add(p.user.toString()));

    for (const userId of userIds) {
      if (!userTaskCounts.has(userId)) {
        userTaskCounts.set(userId, { count: 0, shardTitles: new Set() });
      }
      const entry = userTaskCounts.get(userId)!;
      entry.count += taskCount;
      entry.shardTitles.add(shard.title);
    }
  }

  for (const [userId, { count, shardTitles }] of userTaskCounts) {
    const titles = [...shardTitles];
    const shardHint = titles.length === 1 ? `in ${titles[0]}` : `across ${titles.length} quests`;

    await sendNotificationToUser(
      userId,
      {
        title: `${count} task${count > 1 ? 's' : ''} today`,
        body: `You have ${count} task${count > 1 ? 's' : ''} scheduled ${shardHint}. Let's go!`,
        data: { screen: '/schedule' },
      },
      'questDeadlines'
    );

    await createNotification(
      userId,
      `You have ${count} task${count > 1 ? 's' : ''} scheduled today ${shardHint}.`,
      'task_reminder',
      {}
    );
  }
  console.log(`✅ [Scheduler] Daily task reminders sent to ${userTaskCounts.size} users`);
}

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

      if (prefs && !prefs.pushEnabled) {
        await Notification.findByIdAndUpdate(notif._id, { dispatched: true });
        continue;
      }

      const typeKey = notif.type as keyof typeof prefs;
      if (prefs && typeKey && prefs[typeKey] === false) {
        await Notification.findByIdAndUpdate(notif._id, { dispatched: true });
        continue;
      }

      const user = await User.findById(userId).select('pushTokens').lean();
      const tokens = ((user as any)?.pushTokens ?? []).map((t: any) => t.token).filter(Boolean);

      if (tokens.length > 0) {
        await sendNotificationToTokens(tokens, {
          title: 'Shard',
          body: notif.message,
          data: { ...(notif.shardId ? { shardId: notif.shardId.toString() } : {}) },
        });
      }

      sendEmailToUser(userId, notif.type || 'general', { message: notif.message }).catch(() => {});
      await Notification.findByIdAndUpdate(notif._id, { dispatched: true });
    } catch (err) {
      logError('scheduler:dispatchNotification', err);
    }
  }
}

async function runInactivityNudger() {
  console.log('🤖 [Scheduler] Running inactivity nudger...');
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const staleShards = await Shard.find({
    status: 'active',
    $and: [
      { $or: [{ lastActivityAt: { $lt: threeDaysAgo } }, { lastActivityAt: { $exists: false } }] },
      { $or: [{ lastNudgedAt: { $lt: sevenDaysAgo } }, { lastNudgedAt: { $exists: false } }] },
    ],
  }).select('owner title lastActivityAt').lean();

  for (const shard of staleShards) {
    const ownerId = shard.owner.toString();
    const staleDays = shard.lastActivityAt
      ? Math.floor((Date.now() - new Date(shard.lastActivityAt).getTime()) / 86400000)
      : 3;

    const owner = await User.findById(ownerId).select('subscriptionTier').lean();
    const isPro = (owner as any)?.subscriptionTier === 'pro';

    const nudge = isPro && canMakeCoachAICall()
      ? (incrementCoachAICounter(), await generateInactivityNudge(shard.title, staleDays))
      : COACH_TEMPLATES.inactivity(shard.title);

    await sendNotificationToUser(
      ownerId,
      { title: '🤖 Quest Coach', body: nudge, data: { shardId: shard._id.toString() } },
      'questDeadlines'
    );
    await createNotification(ownerId, nudge, 'quest_deadline', { shardId: shard._id.toString() });
    await Shard.findByIdAndUpdate(shard._id, { lastNudgedAt: new Date() });
  }
  console.log('✅ [Scheduler] Inactivity nudger done');
}

async function runStreakEventDetector() {
  console.log('🤖 [Scheduler] Running streak event detector...');

  // ── Streak break ──
  const brokenUsers = await User.find({ currentStreak: 0, previousStreak: { $gt: 2 } })
    .select('_id subscriptionTier').lean();

  for (const u of brokenUsers) {
    const userId = u._id.toString();
    const isPro = (u as any).subscriptionTier === 'pro';
    const shard = await Shard.findOne({ owner: u._id, status: 'active' })
      .sort({ lastActivityAt: -1 }).select('_id title').lean();
    if (!shard) continue;

    const mg = await MiniGoal.findOne({ shardId: shard._id, completed: false }).lean();
    const incompleteTasks = mg
      ? (mg.tasks as any[]).filter((t: any) => !t.completed && !t.deleted).map((t: any) => t.title)
      : [];

    let message: string;
    if (isPro && incompleteTasks.length > 0 && canMakeCoachAICall()) {
      const simplified = await generateSimplifiedTasks(shard.title, incompleteTasks);
      incrementCoachAICounter();
      if (simplified.length > 0 && mg) {
        let si = 0;
        const updatedTasks = (mg.tasks as any[]).map((t: any) =>
          !t.completed && !t.deleted && si < simplified.length
            ? { ...t, title: simplified[si++] }
            : t
        );
        await MiniGoal.findByIdAndUpdate(mg._id, { tasks: updatedTasks });
      }
      message = `🔄 Your coach simplified tasks in "${shard.title}" to help you restart!`;
    } else {
      message = COACH_TEMPLATES.streakBreak(shard.title);
    }

    await sendNotificationToUser(userId, { title: '🤖 Quest Coach', body: message, data: { shardId: shard._id.toString() } }, 'questDeadlines');
    await createNotification(userId, message, 'quest_deadline', { shardId: shard._id.toString() });
  }

  // ── Streak milestone ──
  const milestoneUsers = await User.find({
    currentStreak: { $gt: 0 },
    $expr: { $eq: [{ $mod: ['$currentStreak', 7] }, 0] },
  }).select('_id subscriptionTier currentStreak').lean();

  for (const u of milestoneUsers) {
    const userId = u._id.toString();
    const streak = (u as any).currentStreak as number;
    const isPro = (u as any).subscriptionTier === 'pro';
    const shard = await Shard.findOne({ owner: u._id, status: 'active' })
      .sort({ lastActivityAt: -1 }).select('_id title').lean();
    if (!shard) continue;

    const suggestion = isPro && canMakeCoachAICall()
      ? (incrementCoachAICounter(), await generateStretchGoal(shard.title, streak))
      : COACH_TEMPLATES.milestone(streak);

    const body = `${suggestion} Add it to "${shard.title}" now! 🚀`;
    await sendNotificationToUser(userId, { title: `🔥 ${streak}-Day Streak!`, body, data: { shardId: shard._id.toString() } }, 'questDeadlines');
    await createNotification(userId, body, 'quest_deadline', { shardId: shard._id.toString() });
  }

  console.log('✅ [Scheduler] Streak event detector done');
}

async function runReflectionMission(data: {
  userId: string;
  shardId: string;
  shardTitle: string;
  completionRate: number;
}) {
  const mission = await generateReflectionMission(data.shardTitle, data.completionRate);
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
