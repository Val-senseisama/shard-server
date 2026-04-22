import cron from 'node-cron';
import MiniGoal from '../models/MiniGoal.js';
import Shard from '../models/Shard.js';
import { User } from '../models/User.js';
import { logError } from './Helpers.js';
import { createNotification } from '../schema/resolvers/Notifications.js';
import { sendNotificationToUser, sendNotificationToTokens } from './FirebaseMessaging.js';
import Notification from '../models/Notifications.js';
import NotificationPreference from '../models/NotificationPreferences.js';
import { sendEmailToUser } from './ResendEmail.js';

/**
 * Daily cron job to send deadline reminders for mini-goals due tomorrow
 * Runs at 8 AM every day
 */
export function startDeadlineReminders() {
  cron.schedule('0 8 * * *', async () => {
    console.log('🔔 [Cron] Running deadline reminder job...');

    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);

      const dayAfterTomorrow = new Date(tomorrow);
      dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

      // Find mini-goals due tomorrow that are not completed
      const miniGoals = await MiniGoal.find({
        completed: false,
        dueDate: { $gte: tomorrow, $lt: dayAfterTomorrow },
      }).lean();

      console.log(`📋 [Cron] Found ${miniGoals.length} mini-goals due tomorrow`);

      for (const miniGoal of miniGoals) {
        const [shardErr, shard] = await (async () => {
          try {
            const s = await Shard.findById(miniGoal.shardId).select('owner participants status title').lean();
            return [null, s];
          } catch (e) { return [e, null]; }
        })();

        if (shardErr || !shard || shard.status === 'completed') continue;

        // Collect owner + all participants as unique set
        const userIds = new Set<string>([shard.owner.toString()]);
        shard.participants?.forEach((p: any) => userIds.add(p.user.toString()));

        for (const userId of userIds) {
          await createNotification(
            userId,
            `"${miniGoal.title}" is due tomorrow`,
            'quest_deadline',
            {
              shardId: shard._id.toString(),
              miniGoalId: miniGoal._id.toString(),
            }
          );
        }
      }

      console.log('✅ [Cron] Deadline reminders sent');
    } catch (error) {
      console.error('❌ [Cron] Deadline reminder error:', error);
      logError('cron:deadlineReminders', error);
    }
  });

  console.log('✅ [Cron] Deadline reminder job started (runs at 8 AM daily)');
}

/**
 * Daily cron job to notify users of overdue mini-goals (once per day)
 * Runs at 9 AM every day
 */
export function startOverdueAlerts() {
  cron.schedule('0 9 * * *', async () => {
    console.log('⚠️  [Cron] Running overdue alert job...');

    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Find mini-goals overdue and not yet alerted today
      const miniGoals = await MiniGoal.find({
        completed: false,
        dueDate: { $lt: today },
        $or: [
          { overdueNotifiedAt: { $exists: false } },
          { overdueNotifiedAt: { $lt: today } },
        ],
      }).lean();

      console.log(`📋 [Cron] Found ${miniGoals.length} overdue mini-goals`);

      for (const miniGoal of miniGoals) {
        const [shardErr, shard] = await (async () => {
          try {
            const s = await Shard.findById(miniGoal.shardId).select('owner participants status title').lean();
            return [null, s];
          } catch (e) { return [e, null]; }
        })();

        if (shardErr || !shard || shard.status === 'completed') continue;

        const userIds = new Set<string>([shard.owner.toString()]);
        shard.participants?.forEach((p: any) => userIds.add(p.user.toString()));

        for (const userId of userIds) {
          await createNotification(
            userId,
            `"${miniGoal.title}" is overdue — don't give up!`,
            'quest_deadline',
            {
              shardId: shard._id.toString(),
              miniGoalId: miniGoal._id.toString(),
            }
          );
        }

        // Mark as notified today
        await MiniGoal.findByIdAndUpdate(miniGoal._id, { overdueNotifiedAt: new Date() });
      }

      console.log('✅ [Cron] Overdue alerts sent');
    } catch (error) {
      console.error('❌ [Cron] Overdue alert error:', error);
      logError('cron:overdueAlerts', error);
    }
  });

  console.log('✅ [Cron] Overdue alert job started (runs at 9 AM daily)');
}

/**
 * Daily cron job to auto-reschedule overdue tasks
 * Runs at 3 AM every day
 */
export function startOverdueTaskReschedule() {
  // Run at 3 AM daily
  cron.schedule('0 3 * * *', async () => {
    console.log('🕐 [Cron] Running overdue task reschedule job...');
    
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Start of today
      
      // Find all mini-goals with overdue tasks
      const miniGoals = await MiniGoal.find({
        completed: false,
        'tasks.completed': false,
        'tasks.deleted': false,
        'tasks.dueDate': { $lt: today }
      });
      
      let rescheduledCount = 0;
      
      for (const miniGoal of miniGoals) {
        let updated = false;
        
        for (const task of miniGoal.tasks) {
          // Skip completed, deleted, or tasks without due dates
          if (task.completed || task.deleted || !task.dueDate) continue;
          
          const taskDate = new Date(task.dueDate);
          taskDate.setHours(0, 0, 0, 0);
          
          // If overdue
          if (taskDate < today) {
            // Save original due date if not already rescheduled
            if (!task.rescheduled) {
              task.originalDueDate = task.dueDate;
            }
            
            // Reschedule to today
            task.dueDate = new Date(today);
            task.rescheduled = true;
            updated = true;
            rescheduledCount++;
            
            console.log(`  📅 Rescheduled: "${task.title}" to today`);
          }
        }
        
        if (updated) {
          await miniGoal.save();
        }
      }
      
      console.log(`✅ [Cron] Rescheduled ${rescheduledCount} overdue tasks`);
    } catch (error) {
      console.error('❌ [Cron] Overdue task reschedule error:', error);
      logError('cron:overdueReschedule', error);
    }
  });
  
  console.log('✅ [Cron] Overdue task reschedule job started (runs at 3 AM daily)');
}

/**
 * Daily cron job to purge soft-deleted tasks after 30 days
 * Runs at 4 AM every day
 */
export function startDeletedTaskPurge() {
  // Run at 4 AM daily
  cron.schedule('0 4 * * *', async () => {
    console.log('🗑️  [Cron] Running deleted task purge job...');
    
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      // Find all mini-goals with tasks deleted more than 30 days ago
      const miniGoals = await MiniGoal.find({
        'tasks.deleted': true,
        'tasks.deletedAt': { $lt: thirtyDaysAgo }
      });
      
      let purgedCount = 0;
      
      for (const miniGoal of miniGoals) {
        const before = miniGoal.tasks.length;
        
        // Filter out old deleted tasks
        miniGoal.tasks = miniGoal.tasks.filter(task => {
          if (!task.deleted) return true; // Keep non-deleted
          if (!task.deletedAt) return true; // Keep if no deletion date
          
          const deletionDate = new Date(task.deletedAt);
          return deletionDate >= thirtyDaysAgo; // Keep if deleted < 30 days ago
        });
        
        const removed = before - miniGoal.tasks.length;
        
        if (removed > 0) {
          await miniGoal.save();
          purgedCount += removed;
          console.log(`  🗑️  Purged ${removed} tasks from mini-goal: ${miniGoal.title}`);
        }
      }
      
      console.log(`✅ [Cron] Purged ${purgedCount} old deleted tasks`);
    } catch (error) {
      console.error('❌ [Cron] Deleted task purge error:', error);
      logError('cron:deletedPurge', error);
    }
  });
  
  console.log('✅ [Cron] Deleted task purge job started (runs at 4 AM daily)');
}

/**
 * Daily task reminder — sends push notification to each user
 * with tasks scheduled for today.
 * Runs at 7:30 AM every day.
 */
export function startDailyTaskReminders() {
  cron.schedule('30 7 * * *', async () => {
    console.log('📋 [Cron] Running daily task reminder job...');

    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(todayStart);
      todayEnd.setDate(todayEnd.getDate() + 1);

      // Find all mini-goals with tasks due today that are incomplete
      const miniGoals = await MiniGoal.find({
        completed: false,
        'tasks.completed': false,
        'tasks.deleted': { $ne: true },
        'tasks.dueDate': { $gte: todayStart, $lt: todayEnd },
      }).lean();

      if (miniGoals.length === 0) {
        console.log('📋 [Cron] No tasks due today');
        return;
      }

      // Group tasks by shard to find users
      const shardIds = [...new Set(miniGoals.map(mg => mg.shardId.toString()))];

      const shards = await Shard.find({
        _id: { $in: shardIds },
        status: { $in: ['active', 'paused'] },
      }).select('owner participants title').lean();

      // Build per-user task counts
      const userTaskCounts = new Map<string, { count: number; shardTitles: Set<string> }>();

      for (const shard of shards) {
        const shardMiniGoals = miniGoals.filter(mg => mg.shardId.toString() === shard._id.toString());
        let taskCount = 0;

        for (const mg of shardMiniGoals) {
          taskCount += mg.tasks.filter((t: any) => {
            if (t.completed || t.deleted || !t.dueDate) return false;
            const d = new Date(t.dueDate);
            return d >= todayStart && d < todayEnd;
          }).length;
        }

        if (taskCount === 0) continue;

        // Collect all users on this shard
        const userIds = new Set<string>([shard.owner.toString()]);
        shard.participants?.forEach((p: any) => userIds.add(p.user.toString()));

        for (const userId of userIds) {
          if (!userTaskCounts.has(userId)) {
            userTaskCounts.set(userId, { count: 0, shardTitles: new Set() });
          }
          const entry = userTaskCounts.get(userId)!;
          entry.count += taskCount;
          entry.shardTitles.add(shard.title);
        }
      }

      console.log(`📋 [Cron] Sending daily reminders to ${userTaskCounts.size} users`);

      // Send push notification to each user
      for (const [userId, { count, shardTitles }] of userTaskCounts) {
        const titles = [...shardTitles];
        const shardHint = titles.length === 1
          ? `in ${titles[0]}`
          : `across ${titles.length} quests`;

        await sendNotificationToUser(
          userId,
          {
            title: `${count} task${count > 1 ? 's' : ''} today`,
            body: `You have ${count} task${count > 1 ? 's' : ''} scheduled ${shardHint}. Let's go!`,
            data: { screen: '/schedule' },
          },
          'questDeadlines'
        );

        // Also create in-app notification
        await createNotification(
          userId,
          `You have ${count} task${count > 1 ? 's' : ''} scheduled today ${shardHint}.`,
          'task_reminder',
          {}
        );
      }

      console.log('✅ [Cron] Daily task reminders sent');
    } catch (error) {
      console.error('❌ [Cron] Daily task reminder error:', error);
      logError('cron:dailyTaskReminders', error);
    }
  });

  console.log('✅ [Cron] Daily task reminder job started (runs at 7:30 AM daily)');
}

/**
 * Dispatches notifications that were deferred due to quiet hours.
 * Runs every 5 minutes. Finds notifications where:
 *   - dispatched = false
 *   - triggerAt <= now
 * For each it sends a FCM push + email, then marks dispatched = true.
 */
export function startScheduledNotificationDispatcher() {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const now = new Date();

      const pending = await Notification.find({
        dispatched: false,
        triggerAt: { $lte: now },
      })
        .limit(200)
        .lean();

      if (pending.length === 0) return;

      console.log(`🔔 [Cron] Dispatching ${pending.length} deferred notification(s)`);

      for (const notif of pending) {
        const userId = notif.userId.toString();

        try {
          // Check pushEnabled + type pref — but NOT quiet hours (we already waited)
          const prefs = await NotificationPreference.findOne({ userId }).lean();
          if (prefs && !prefs.pushEnabled) {
            // Push disabled — mark dispatched so we don't retry, but skip push
            await Notification.findByIdAndUpdate(notif._id, { dispatched: true });
            continue;
          }

          // Type-level preference check
          const typeKey = notif.type as keyof typeof prefs;
          if (prefs && typeKey && prefs[typeKey] === false) {
            await Notification.findByIdAndUpdate(notif._id, { dispatched: true });
            continue;
          }

          // Fetch push tokens and send FCM
          const user = await User.findById(userId).select('pushTokens').lean();
          const tokens = (user?.pushTokens ?? []).map((t: any) => t.token).filter(Boolean);

          if (tokens.length > 0) {
            await sendNotificationToTokens(tokens, {
              title: 'Shard',
              body: notif.message,
              data: {
                ...(notif.shardId ? { shardId: notif.shardId.toString() } : {}),
              },
            });
          }

          // Send email (sendEmailToUser does its own emailEnabled + type + quiet-hours check)
          sendEmailToUser(userId, notif.type || 'general', { message: notif.message }).catch(() => {});

          await Notification.findByIdAndUpdate(notif._id, { dispatched: true });
        } catch (err) {
          logError('cron:dispatchNotification', err);
        }
      }
    } catch (error) {
      logError('cron:scheduledNotificationDispatcher', error);
    }
  });

  console.log('✅ [Cron] Scheduled notification dispatcher started (runs every 5 minutes)');
}

/**
 * AI Coach: Inactivity Nudger
 * Runs at 10 AM daily - nudges owners of shards idle for 3+ days.
 * Rate-limited to 1 nudge/shard/7 days. AI only for Pro users within daily cap.
 */
export function startInactivityNudger() {
  cron.schedule('0 10 * * *', async () => {
    console.log('🤖 [Cron] Running AI inactivity nudger...');
    try {
      const {
        canMakeCoachAICall, incrementCoachAICounter,
        generateInactivityNudge, COACH_TEMPLATES
      } = await import('./AIHelper.js');

      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const staleShards = await Shard.find({
        status: 'active',
        $and: [
          { $or: [{ lastActivityAt: { $lt: threeDaysAgo } }, { lastActivityAt: { $exists: false } }] },
          { $or: [{ lastNudgedAt: { $lt: sevenDaysAgo } }, { lastNudgedAt: { $exists: false } }] },
        ],
      }).select('owner title lastActivityAt').lean();

      console.log(`🤖 [Cron] Found ${staleShards.length} stale shards`);

      for (const shard of staleShards) {
        const ownerId = shard.owner.toString();
        const staleDays = shard.lastActivityAt
          ? Math.floor((Date.now() - new Date(shard.lastActivityAt).getTime()) / 86400000)
          : 3;

        const owner = await User.findById(ownerId).select('subscriptionTier').lean();
        const isPro = (owner as any)?.subscriptionTier === 'pro';

        const nudge = (isPro && canMakeCoachAICall())
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
      console.log('✅ [Cron] Inactivity nudger done');
    } catch (error) {
      logError('cron:inactivityNudger', error);
    }
  });
  console.log('✅ [Cron] Inactivity nudger started (runs 10 AM daily)');
}

/**
 * AI Coach: Streak Event Detector
 * Runs at 11 AM daily.
 * - Streak BREAK (previousStreak > 2, currentStreak === 0): simplify tasks
 * - Streak MILESTONE (currentStreak % 7 === 0): suggest stretch goal
 */
export function startStreakEventDetector() {
  cron.schedule('0 11 * * *', async () => {
    console.log('🤖 [Cron] Running streak event detector...');
    try {
      const {
        canMakeCoachAICall, incrementCoachAICounter,
        generateSimplifiedTasks, generateStretchGoal, COACH_TEMPLATES
      } = await import('./AIHelper.js');
      const MiniGoal = (await import('../models/MiniGoal.js')).default;

      // ── Streak break ───
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
          ? (mg.tasks as any[]).filter(t => !t.completed && !t.deleted).map(t => t.title)
          : [];

        let message: string;
        if (isPro && incompleteTasks.length > 0 && canMakeCoachAICall()) {
          const simplified = await generateSimplifiedTasks(shard.title, incompleteTasks);
          incrementCoachAICounter();
          if (simplified.length > 0 && mg) {
            let si = 0;
            const updatedTasks = (mg.tasks as any[]).map(t =>
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

      // ── Streak milestone ───
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

        const suggestion = (isPro && canMakeCoachAICall())
          ? (incrementCoachAICounter(), await generateStretchGoal(shard.title, streak))
          : COACH_TEMPLATES.milestone(streak);

        const body = `${suggestion} Add it to "${shard.title}" now! 🚀`;
        await sendNotificationToUser(userId, { title: `🔥 ${streak}-Day Streak!`, body, data: { shardId: shard._id.toString() } }, 'questDeadlines');
        await createNotification(userId, body, 'quest_deadline', { shardId: shard._id.toString() });
      }

      console.log('✅ [Cron] Streak event detector done');
    } catch (error) {
      logError('cron:streakEventDetector', error);
    }
  });
  console.log('✅ [Cron] Streak event detector started (runs 11 AM daily)');
}

