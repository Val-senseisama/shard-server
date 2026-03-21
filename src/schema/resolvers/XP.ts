import {
  catchError,
  logError,
  SaveAuditTrail,
  ThrowError,
} from "../../Helpers/Helpers.js";
import { User } from "../../models/User.js";
import Achievement from "../../models/Achievement.js";
import Streak from "../../models/Streak.js";
import MiniGoal from "../../models/MiniGoal.js";
import Shard from "../../models/Shard.js";
import { cache, cacheKeys, cacheInvalidate } from "../../Helpers/Cache.js";

/**
 * Calculate XP needed for next level
 */
function xpForNextLevel(currentLevel: number): number {
  return Math.floor(100 * Math.pow(1.5, currentLevel - 1));
}

/**
 * Calculate new level based on XP
 */
function calculateLevel(xp: number): number {
  let level = 1;
  let totalXP = 0;
  let requiredXP = 100;

  while (totalXP + requiredXP <= xp) {
    totalXP += requiredXP;
    level++;
    requiredXP = Math.floor(100 * Math.pow(1.5, level - 1));
  }

  return level;
}

/**
 * Award XP to user and update level
 */
export async function awardXP(userId: string, amount: number, reason: string) {
  const [error, user] = await catchError(
    User.findById(userId).lean()
  );

  if (error || !user) {
    logError("awardXP:userNotFound", error);
    return;
  }

  const newXP = user.xp + amount;
  const newLevel = calculateLevel(newXP);

  await User.findByIdAndUpdate(userId, {
    $inc: { xp: amount },
    $set: { level: newLevel },
  });

  // Invalidate user cache
  await cacheInvalidate.user(userId);

  // Log XP gain
  SaveAuditTrail({
    userId,
    task: "XP Awarded",
    details: `${amount} XP awarded for: ${reason}`,
  });

  // Check for level up
  if (newLevel > user.level) {
    SaveAuditTrail({
      userId,
      task: "Level Up",
      details: `Leveled up to ${newLevel}!`,
    });
  }

  return { newXP, newLevel, leveledUp: newLevel > user.level };
}

/**
 * Check and unlock achievements
 */
export async function checkAchievements(userId: string) {
  // Get user's current stats
  const user = await User.findById(userId).lean();
  if (!user) return [];

  const unlocked: string[] = [];

  // Example achievement checks (extend as needed)
  const achievementsToCheck = await Achievement.find({
    _id: { $nin: user.achievements },
  }).lean();

  for (const achievement of achievementsToCheck) {
    let shouldUnlock = false;

    switch (achievement.category) {
      case "consistency":
        if (user.streaks >= (achievement.requiredValue || 7)) {
          shouldUnlock = true;
        }
        break;
      case "milestone":
        if (user.level >= (achievement.requiredValue || 10)) {
          shouldUnlock = true;
        }
        break;
      // Add more achievement checks
    }

    if (shouldUnlock) {
      await User.findByIdAndUpdate(userId, {
        $push: { achievements: achievement._id.toString(), pendingAchievements: achievement._id.toString() },
      });
      unlocked.push(achievement.title);
    }
  }

  if (unlocked.length > 0) {
    await cacheInvalidate.user(userId);
  }

  return unlocked;
}

/**
 * Update streak
 */
export async function updateStreak(userId: string, type: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [error, streak] = await catchError(
    Streak.findOne({
      userId,
      type,
    }).lean()
  );

  if (error) {
    logError("updateStreak", error);
    return;
  }

  if (!streak) {
    // Create new streak
    await Streak.create({
      userId,
      type,
      currentStreak: 1,
      longestStreak: 1,
      lastActivityDate: today,
      streakStartDate: today,
    });
    return;
  }

  const lastActivity = new Date(streak.lastActivityDate);
  lastActivity.setHours(0, 0, 0, 0);

  const daysSince = Math.floor((today.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24));

  let newStreak = streak.currentStreak;
  let newLongest = streak.longestStreak;
  let newStartDate = streak.streakStartDate;

  if (daysSince === 1) {
    // Continue streak
    newStreak++;
    if (newStreak > newLongest) {
      newLongest = newStreak;
    }
  } else if (daysSince > 1) {
    // Streak broken
    newStreak = 1;
    newStartDate = today;
  }
  // If daysSince === 0, already updated today

  await Streak.findOneAndUpdate(
    { userId, type },
    {
      currentStreak: newStreak,
      longestStreak: newLongest,
      lastActivityDate: today,
      streakStartDate: newStartDate,
    }
  );
}

/**
 * Complete a task and award XP
 */
export async function completeTask(userId: string, shardId: string, miniGoalId: string, taskIndex: number) {
  console.log(`🚀 [completeTask] Starting for user: ${userId}, shard: ${shardId}, miniGoal: ${miniGoalId}, task: ${taskIndex}`);

  // Get mini-goal
  const [error, minigoal] = await catchError(
    MiniGoal.findById(miniGoalId).lean()
  );

  console.log(`🔍 [completeTask] MiniGoal fetch result:`, { error: !!error, found: !!minigoal });

  if (error || !minigoal || minigoal.shardId.toString() !== shardId) {
    return {
      success: false,
      message: "Task not found.",
      xpEarned: 0,
      achievements: [],
    };
  }

  // Verify user permissions
  const [shardError, shard] = await catchError(
    Shard.findById(shardId).lean()
  );

  if (shardError || !shard) {
    return {
      success: false,
      message: "Shard not found.",
      xpEarned: 0,
      achievements: [],
    };
  }

  const isOwner = shard.owner.toString() === userId;
  const isCollaborator = shard.participants.some(
    (p: any) => p.user.toString() === userId && p.role === "collaborator"
  );

  console.log(`👤 [completeTask] Permissions:`, { isOwner, isCollaborator });

  if (!isOwner && !isCollaborator) {
    console.warn(`❌ [completeTask] Permission denied for user ${userId}`);
    return {
      success: false,
      message: "You don't have permission to complete tasks in this shard.",
      xpEarned: 0,
      achievements: [],
    };
  }

  const tasks = minigoal.tasks;
  console.log(`📋 [completeTask] Tasks count: ${tasks?.length}, Target Index: ${taskIndex}`);

  if (taskIndex < 0 || taskIndex >= tasks.length) {
    console.warn(`❌ [completeTask] Invalid task index`);
    return {
      success: false,
      message: "Invalid task.",
      xpEarned: 0,
      achievements: [],
    };
  }

  if (tasks[taskIndex].completed) {
    console.log(`ℹ️ [completeTask] Task already completed`);
    return {
      success: true,
      message: "Task already completed.",
      xpEarned: 0,
      achievements: [],
    };
  }

  // Mark task as complete
  tasks[taskIndex].completed = true;
  
  // Calculate completed tasks
  const completedCount = tasks.filter(t => t.completed).length;
  const progress = Math.floor((completedCount / tasks.length) * 100);

  console.log(`✅ [completeTask] Task marked complete. New progress: ${progress}%`);

  await MiniGoal.findByIdAndUpdate(miniGoalId, {
    tasks,
    progress,
    completed: progress === 100,
  });

  // Update shard overall progress based on all mini-goals
  const [allMgError, allMiniGoals] = await catchError(
    MiniGoal.find({ shardId }).lean()
  );

  if (!allMgError && allMiniGoals && allMiniGoals.length > 0) {
    // Calculate average progress across all mini-goals
    const totalProgress = allMiniGoals.reduce((sum: number, mg: any) => sum + mg.progress, 0);
    const shardProgress = Math.floor(totalProgress / allMiniGoals.length);
    
    console.log(`📊 [completeTask] Updating shard progress to ${shardProgress}%`);
    
    await Shard.findByIdAndUpdate(shardId, {
      "progress.completion": shardProgress,
    });
  }

  // Award XP (20 XP per task)
  const xpResult = await awardXP(userId, 20, `Task in ${minigoal.title}`);
  
  // Update streak
  await updateStreak(userId, "task_completion");

  // Check for achievements
  const achievements = await checkAchievements(userId);

  return {
    success: true,
    message: "Task completed!",
    xpEarned: 20,
    xpResult,
    achievements,
  };
}

export default {
  Mutation: {
    // Complete task and award XP
    async completeTask(_, { shardId, miniGoalId, taskIndex }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      return await completeTask(context.id, shardId, miniGoalId, taskIndex);
    },
  },
  Query: {
    async getXP(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const user = await cache.getOrSet(
        cacheKeys.user(context.id),
        async () => {
          const [error, userData] = await catchError(
            User.findById(context.id)
              .select("xp level achievements pendingAchievements")
              .lean()
          );

          if (error || !userData) {
            throw new Error("User not found");
          }

          return userData;
        },
        1800
      );

      const xpNeeded = xpForNextLevel(user.level);

      return {
        success: true,
        xp: user.xp,
        level: user.level,
        xpNeeded,
        achievements: user.achievements || [],
        pendingAchievements: user.pendingAchievements || [],
      };
    },

    async getStreaks(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, streaks] = await catchError(
        Streak.find({ userId: context.id }).lean()
      );

      if (error) {
        logError("getStreaks", error);
        return {
          success: false,
          streaks: [],
        };
      }

      return {
        success: true,
        streaks: streaks.map((s: any) => ({
          type: s.type,
          currentStreak: s.currentStreak,
          longestStreak: s.longestStreak,
          lastActivityDate: s.lastActivityDate,
        })),
      };
    },
  },
};

