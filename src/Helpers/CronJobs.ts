import cron from 'node-cron';
import MiniGoal from '../models/MiniGoal.js';
import Shard from '../models/Shard.js';
import { logError } from './Helpers.js';
import { createNotification } from '../schema/resolvers/Notifications.js';

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
