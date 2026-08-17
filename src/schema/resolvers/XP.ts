import {
  catchError,
  logError,
  SaveAuditTrail,
  ThrowError,
} from "../../Helpers/Helpers.js";
import { User } from "../../models/User.js";
import MiniGoal from "../../models/MiniGoal.js";
import Shard from "../../models/Shard.js";
import Friendship from "../../models/Friendship.js";
import { cache, cacheKeys, cacheInvalidate } from "../../Helpers/Cache.js";
import { ACHIEVEMENTS, ACHIEVEMENT_MAP, type UserStats } from "../../data/achievements.js";
import { recordActivity, getStreak, xpMultiplierFor, repairStreak } from "../../Helpers/Streak.js";
import { tierOf } from "../../Helpers/Entitlements.js";
import { logEvent } from "../../Helpers/Telemetry.js";
import { notify, notifyStreakProgress } from "../../Helpers/Notify.js";
import { stampFirstMiniGoal } from "../../Helpers/Activation.js";
import { updateProductivityMetrics } from "./Analytics.js";
import {
  taskXPValue,
  miniGoalProgress,
  allTasksComplete,
  recomputeShardProgress,
} from "../../Helpers/Progress.js";

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

  const multiplier = xpMultiplierFor(user as any);

  const finalAmount = Math.floor(amount * multiplier);
  const newXP = user.xp + finalAmount;
  const newLevel = calculateLevel(newXP);

  await User.findByIdAndUpdate(userId, {
    $inc: { xp: finalAmount },
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

  return { newXP, newLevel, leveledUp: newLevel > user.level, bonusMultiplier: multiplier };
}

/**
 * Build live UserStats for a given userId — used by checkAchievements.
 * Runs all DB counts in parallel for speed.
 */
export async function buildUserStats(userId: string): Promise<UserStats | null> {
  const user = await User.findById(userId)
    .select("xp level currentStreak longestStreak")
    .lean();
  if (!user) return null;

  // Every shard this user touches. Resolving ids first lets the mini-goal stats
  // below hit the `shardId` index directly instead of $lookup-ing the whole
  // shards collection twice per achievement check.
  //
  // This is a normal Mongoose query, so the string `userId` is cast to an
  // ObjectId automatically. That casting is exactly what the previous
  // aggregation pipelines did NOT get — Mongoose does not cast inside an
  // aggregate, so `{ "shard.owner": { $eq: userId } }` compared an ObjectId to a
  // string, matched nothing, and silently pinned tasksCompleted and
  // miniGoalsCompleted to 0 forever.
  const myShards = await Shard.find(
    { $or: [{ owner: userId }, { "participants.user": userId }] },
    "_id owner"
  ).lean();

  const myShardIds = myShards.map((s: any) => s._id);
  // "Joined" means a shard someone else owns — being in your own isn't a collab.
  const joinedCount = myShards.filter((s: any) => s.owner.toString() !== userId).length;

  const [friendCount, shardsCreated, shardsCompleted, tasksCompleted, miniGoalsCompleted] =
    await Promise.all([
      // The Friendship model's fields are `user` / `friend`. This used to query
      // `requester` / `recipient`, which exist on no schema, so it always
      // returned 0 and no friend achievement could ever unlock.
      Friendship.countDocuments({
        $or: [{ user: userId }, { friend: userId }],
        status: "accepted",
      }),
      Shard.countDocuments({ owner: userId }),
      Shard.countDocuments({ owner: userId, status: "completed" }),
      // tasksCompleted: sum of completed, non-deleted tasks across those shards
      MiniGoal.aggregate([
        { $match: { shardId: { $in: myShardIds } } },
        {
          $project: {
            completedCount: {
              $size: {
                $filter: {
                  input: { $ifNull: ["$tasks", []] },
                  as: "t",
                  cond: { $and: ["$$t.completed", { $ne: ["$$t.deleted", true] }] },
                },
              },
            },
          },
        },
        { $group: { _id: null, total: { $sum: "$completedCount" } } },
      ]).then((r) => r[0]?.total ?? 0),
      MiniGoal.countDocuments({ shardId: { $in: myShardIds }, completed: true }),
    ]);

  return {
    xp: user.xp,
    level: user.level,
    currentStreak: user.currentStreak,
    longestStreak: user.longestStreak,
    friendCount,
    shardsCreated,
    shardsCompleted,
    tasksCompleted,
    miniGoalsCompleted,
    collaborationsJoined: joinedCount,
  };
}

/**
 * Check and unlock any newly-eligible achievements.
 * Returns the ids of newly unlocked achievements.
 * Sends an in-app notification for each unlock.
 */
export interface CheckAchievementsOptions {
  /**
   * Grant without sending a push.
   *
   * For backfills. When a fix makes previously-unreachable achievements
   * reachable, every affected user unlocks a pile of them at once — and pushing
   * "🏆 Achievement unlocked" eight times for things they earned weeks ago is how
   * people turn notifications off for good. Silent grants still populate
   * `pendingAchievements`, so the user sees the celebration in-app on their next
   * open, in context. Default false: the live path always notifies.
   */
  silent?: boolean;
}

export async function checkAchievements(
  userId: string,
  options: CheckAchievementsOptions = {}
): Promise<string[]> {
  const user = await User.findById(userId).select("achievements").lean();
  if (!user) return [];

  const earned = new Set(user.achievements ?? []);
  // Only check achievements the user hasn't earned yet
  const toCheck = ACHIEVEMENTS.filter((a) => !earned.has(a.id));
  if (toCheck.length === 0) return [];

  const stats = await buildUserStats(userId);
  if (!stats) return [];

  const newlyUnlocked: string[] = [];

  for (const achievement of toCheck) {
    const { stat, threshold } = achievement.condition;
    if ((stats[stat] ?? 0) >= threshold) {
      newlyUnlocked.push(achievement.id);
    }
  }

  if (newlyUnlocked.length === 0) return [];

  // Persist all unlocks in one write
  await User.findByIdAndUpdate(userId, {
    $push: {
      achievements:        { $each: newlyUnlocked },
      pendingAchievements: { $each: newlyUnlocked },
    },
  });

  await cacheInvalidate.user(userId);

  // One notification per unlock, and now an actual push — these only ever wrote
  // an in-app row, so the moment a user earned something they weren't told
  // unless they happened to be looking. Deduped per achievement id, so an
  // unlock can't be announced twice.
  if (!options.silent) {
    for (const id of newlyUnlocked) {
      const a = ACHIEVEMENT_MAP.get(id)!;
      notify({
        userId,
        kind: "achievement",
        title: `${a.icon} Achievement unlocked`,
        body: `${a.name} — ${a.description}`,
        data: { screen: "/achievements" },
        dedupeKey: `achievement:${id}`,
        emailData: { achievementName: a.name },
      }).catch(() => {});
    }
  }

  SaveAuditTrail({
    userId,
    task: options.silent ? "Achievements Backfilled" : "Achievements Unlocked",
    details: newlyUnlocked.join(", "),
  });

  return newlyUnlocked;
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

  // Claim the task with a single conditional write.
  //
  // This used to be a read-check-then-write-the-whole-array sequence, which had
  // two failure modes. Writing the entire `tasks` array back meant two tasks in
  // the same mini-goal completed at once would clobber each other — last write
  // wins, one completion silently lost. And checking `completed` in application
  // code before writing left a TOCTOU window where a double-tap paid XP twice.
  //
  // Matching on `completed: false` in the query makes the claim atomic: MongoDB
  // applies it to a single document, and only one caller can ever observe
  // `modifiedCount === 1`.
  const claim = await MiniGoal.updateOne(
    { _id: miniGoalId, [`tasks.${taskIndex}.completed`]: false },
    {
      $set: {
        [`tasks.${taskIndex}.completed`]: true,
        [`tasks.${taskIndex}.completedAt`]: new Date(),
      },
    }
  );

  if (claim.modifiedCount === 0) {
    console.log(`ℹ️ [completeTask] Task already completed`);
    return {
      success: true,
      message: "Task already completed.",
      xpEarned: 0,
      achievements: [],
    };
  }

  // Re-read so progress is computed from the document as it now stands, rather
  // than from the stale snapshot this function opened with — another writer may
  // have completed a sibling task in between.
  const [freshError, fresh] = await catchError(MiniGoal.findById(miniGoalId).lean());
  if (freshError || !fresh) {
    logError("completeTask:reread", freshError);
    return { success: false, message: "Task not found.", xpEarned: 0, achievements: [] };
  }

  const freshTasks = fresh.tasks;
  const progress = miniGoalProgress(freshTasks);
  const miniGoalNowComplete = allTasksComplete(freshTasks);

  await MiniGoal.updateOne(
    { _id: miniGoalId },
    { $set: { progress, completed: miniGoalNowComplete } }
  );

  // Finishing the last task finishes the mini-goal — the activation milestone
  // reaches through this path too, not just the explicit completeMiniGoal call.
  if (miniGoalNowComplete && !minigoal.completed) {
    stampFirstMiniGoal(userId).catch(() => {});
  }

  // One shard-progress formula, shared with completeMiniGoal (they used to
  // disagree and overwrite each other), and it refreshes lastActivityAt.
  await recomputeShardProgress(shardId);

  // Streak: one engine, user-local day boundaries, idempotent per day.
  // Must run BEFORE awardXP so a comeback bonus granted by this activity
  // applies to the XP it earned.
  const streak = await recordActivity(userId);

  // XP scales with the task's own reward — the AI already sizes these per task
  // (see AIHelper), so a 3-hour task no longer pays the same as a 5-minute one.
  const baseXP = taskXPValue(freshTasks[taskIndex]);
  const xpResult = await awardXP(userId, baseXP, `Task in ${minigoal.title}`);

  // Record what was ACTUALLY paid out, so uncompleteTask can claw back the
  // exact amount rather than guessing at the bonus multiplier.
  const xpAwarded = Math.floor(baseXP * (xpResult?.bonusMultiplier ?? 1));
  await MiniGoal.updateOne(
    { _id: miniGoalId },
    { $set: { [`tasks.${taskIndex}.xpAwarded`]: xpAwarded } }
  );

  // Celebrate milestones / freeze saves at the moment they happen, rather than
  // in a next-day cron that couldn't tell a new milestone from a stale one.
  if (streak.counted) {
    notifyStreakProgress(userId, streak).catch(() => {});
  }

  // Check for achievements
  const achievements = await checkAchievements(userId);

  // Feed the productivity analytics. This is recorded here, server-side, on the
  // authoritative completion path rather than from a client `trackActivity`
  // call: the `trackActivity` mutation existed but nothing ever invoked it, so
  // `productivityHistory` was never written and the (Pro-gated) insights screen
  // could only ever render its "no data yet" branch. Client-driven analytics
  // would also lose every completion where the app is killed before the second
  // round trip, and would be trivially forgeable.
  //
  // Best-effort and non-blocking: analytics must never fail a completion the
  // user has already been credited for.
  updateProductivityMetrics(userId, { tasksCompleted: 1, xpEarned: baseXP }).catch((e) =>
    logError("completeTask:updateProductivityMetrics", e)
  );

  return {
    success: true,
    message: "Task completed!",
    xpEarned: baseXP,
    xpResult,
    achievements,
  };
}

/** How long after completing a task you can still take it back. */
export const UNDO_WINDOW_MINUTES = 5;

/**
 * Undo a task completion — for mis-taps, not for farming.
 *
 * Deliberate scope:
 *  - XP IS clawed back, exactly (we stored `xpAwarded`, so the comeback-bonus
 *    multiplier is accounted for). Without this, complete→undo→complete would
 *    be an infinite XP loop.
 *  - The STREAK IS NOT reverted. A streak answers "did you show up today", and
 *    you did — you just mis-tapped one task. The engine is idempotent per local
 *    day anyway, so there is no per-completion state to unwind.
 *  - ACHIEVEMENTS ARE NOT revoked. They're permanent by design and there is no
 *    revocation path; taking a badge away over a mis-tap is worse than keeping it.
 */
export async function uncompleteTask(userId: string, shardId: string, miniGoalId: string, taskIndex: number) {
  const [error, minigoal] = await catchError(MiniGoal.findById(miniGoalId).lean());

  if (error || !minigoal || minigoal.shardId.toString() !== shardId) {
    return { success: false, message: "Task not found.", xpEarned: 0, achievements: [] };
  }

  const [shardError, shard] = await catchError(Shard.findById(shardId).lean());
  if (shardError || !shard) {
    return { success: false, message: "Shard not found.", xpEarned: 0, achievements: [] };
  }

  const isOwner = shard.owner.toString() === userId;
  const isCollaborator = shard.participants.some(
    (p: any) => p.user.toString() === userId && p.role === "collaborator"
  );
  if (!isOwner && !isCollaborator) {
    return {
      success: false,
      message: "You don't have permission to change tasks in this shard.",
      xpEarned: 0,
      achievements: [],
    };
  }

  const tasks = minigoal.tasks;
  if (taskIndex < 0 || taskIndex >= tasks.length) {
    return { success: false, message: "Invalid task.", xpEarned: 0, achievements: [] };
  }

  const task = tasks[taskIndex];
  if (!task.completed) {
    return { success: true, message: "Task is not completed.", xpEarned: 0, achievements: [] };
  }

  // The undo window. Tasks completed before this feature shipped have no
  // `completedAt` — treat those as out of window rather than granting a
  // retroactive undo on historical data.
  const completedAt = task.completedAt ? new Date(task.completedAt) : null;
  const ageMs = completedAt ? Date.now() - completedAt.getTime() : Infinity;
  if (ageMs > UNDO_WINDOW_MINUTES * 60 * 1000) {
    return {
      success: false,
      message: `Tasks can only be undone within ${UNDO_WINDOW_MINUTES} minutes of completing them.`,
      xpEarned: 0,
      achievements: [],
    };
  }

  // Release the task with a single conditional write, mirroring the claim in
  // completeTask. Matching on `completed: true` means only one caller can undo a
  // given completion, so two concurrent undos can't claw back the XP twice — and
  // no sibling task's state is touched.
  const clawback = task.xpAwarded ?? taskXPValue(task);

  const release = await MiniGoal.updateOne(
    { _id: miniGoalId, [`tasks.${taskIndex}.completed`]: true },
    {
      $set: { [`tasks.${taskIndex}.completed`]: false },
      $unset: {
        [`tasks.${taskIndex}.completedAt`]: "",
        [`tasks.${taskIndex}.xpAwarded`]: "",
      },
    }
  );

  if (release.modifiedCount === 0) {
    return { success: true, message: "Task is not completed.", xpEarned: 0, achievements: [] };
  }

  // Recompute from the document as it now stands, not the opening snapshot.
  const [freshError, fresh] = await catchError(MiniGoal.findById(miniGoalId).lean());
  if (freshError || !fresh) {
    logError("uncompleteTask:reread", freshError);
    return { success: false, message: "Task not found.", xpEarned: 0, achievements: [] };
  }

  const progress = miniGoalProgress(fresh.tasks);
  const miniGoalNowComplete = allTasksComplete(fresh.tasks);

  await MiniGoal.updateOne(
    { _id: miniGoalId },
    { $set: { progress, completed: miniGoalNowComplete } }
  );

  // Finishing the last task finishes the mini-goal — the activation milestone
  // reaches through this path too, not just the explicit completeMiniGoal call.
  if (miniGoalNowComplete && !minigoal.completed) {
    stampFirstMiniGoal(userId).catch(() => {});
  }

  // Roll the parent shard's progress back through the same one formula.
  await recomputeShardProgress(shardId);

  // Claw back the XP, never below zero, and recompute the level from the result.
  const [userError, rawUser] = await catchError(User.findById(userId).select("xp level").lean());
  const user = rawUser as any;
  let newXP = 0;
  let newLevel = 1;
  if (!userError && user) {
    newXP = Math.max(0, (user.xp || 0) - clawback);
    newLevel = calculateLevel(newXP);
    await User.findByIdAndUpdate(userId, { $set: { xp: newXP, level: newLevel } });
    await cacheInvalidate.user(userId);
    SaveAuditTrail({
      userId,
      task: "Task Undone",
      details: `Task in ${minigoal.title} undone; ${clawback} XP reclaimed`,
    });
  }

  return {
    success: true,
    message: "Task undone.",
    xpEarned: -clawback,
    xpResult: { newXP, newLevel, leveledUp: false, bonusMultiplier: 1 },
    achievements: [],
  };
}

export default {
  Mutation: {
    // Complete task and award XP
    async completeTask(_, { shardId, miniGoalId, taskIndex }, context) {
      if (!context.id) ThrowError("Please login to continue.");
      return await completeTask(context.id, shardId, miniGoalId, taskIndex);
    },

    // Undo a task completion within the undo window, clawing the XP back
    async uncompleteTask(_, { shardId, miniGoalId, taskIndex }, context) {
      if (!context.id) ThrowError("Please login to continue.");
      return await uncompleteTask(context.id, shardId, miniGoalId, taskIndex);
    },

    /**
     * Restore a streak broken within the repair window. Pro only.
     *
     * The strongest retention save in the product and a natural paid moment: a
     * user who just lost a 23-day streak is the most motivated buyer you will
     * ever have.
     *
     * Freezes and repairs are deliberately DIFFERENT things, and this used to
     * conflate them:
     *
     *   - A **freeze** is automatic forgiveness for one isolated missed day.
     *     It stays free and is refilled weekly (CronJobs `weekly-freeze-grant`).
     *     Nobody should have to pay because life happened on a Tuesday.
     *   - A **repair** resurrects a streak that has actually broken — two or
     *     more consecutive missed days, past what a freeze will cover.
     *
     * Letting a free user spend a freeze token on a repair meant the paid moment
     * was purchasable with a currency we hand out every Monday, so the paywall
     * only opened for users who had missed ~4 days in three weeks — i.e. exactly
     * the users whose streak wasn't worth paying to save. The gate was real; the
     * key was free.
     */
    async repairStreak(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [userErr, user] = await catchError(
        User.findById(context.id)
          .select("subscriptionTier role trialStartedAt trialEndsAt firstQuestCompletedAt streakFreezeTokens")
          .lean()
      );
      if (userErr || !user) return { success: false, message: "User not found." };

      const isPro = tierOf(user as any) === "pro";

      if (!isPro) {
        return {
          success: false,
          // `needsUpgrade` is what the client keys off to open the paywall —
          // without it this is a dead-end error message.
          needsUpgrade: true,
          message:
            "Repairing a broken streak is a Pro feature. Your free streak freezes cover single missed days automatically.",
        };
      }

      const result = await repairStreak(context.id);
      if (!result.success) return result;

      // Freeze tokens are untouched: they're the free mechanic, and spending
      // one here would charge a Pro user for something their subscription
      // already covers.
      await cacheInvalidate.user(context.id);
      SaveAuditTrail({
        userId: context.id,
        task: "Streak Repaired",
        details: `Restored ${result.restored} day streak (pro)`,
      });
      logEvent({
        name: "streak_repaired",
        userId: context.id,
        tier: "pro",
        props: { restored: result.restored ?? 0 },
      });

      return result;
    },

    // Clear the pending achievements queue after the client has shown them
    async clearPendingAchievements(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");
      await User.findByIdAndUpdate(context.id, { $set: { pendingAchievements: [] } });
      await cacheInvalidate.user(context.id);
      return { success: true, message: 'Achievements cleared.' };
    },
  },
  Query: {
    // Returns full metadata for all achievements, with earned/pending flags
    async getAchievements(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [user, stats] = await Promise.all([
        User.findById(context.id).select("achievements pendingAchievements").lean(),
        // Same stats checkAchievements evaluates, so the bar on screen and the
        // unlock that fires can never disagree.
        buildUserStats(context.id),
      ]);

      const earned = new Set(user?.achievements ?? []);
      const pending = new Set(user?.pendingAchievements ?? []);

      return {
        success: true,
        achievements: ACHIEVEMENTS.map((a) => {
          const target = a.condition.threshold;
          const isEarned = earned.has(a.id);
          const current = stats?.[a.condition.stat] ?? 0;
          return {
            id: a.id,
            name: a.name,
            description: a.description,
            icon: a.icon,
            category: a.category,
            rarity: a.rarity,
            earned: isEarned,
            pending: pending.has(a.id),
            // Earned reads full even if the underlying stat has since fallen —
            // streaks reset, badges don't.
            progress: isEarned ? target : Math.min(current, target),
            target,
          };
        }),
      };
    },

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

    /**
     * The user's streak, from the engine.
     *
     * Previously read the per-type `Streak` collection, which was written on
     * every completion but never surfaced anywhere in the app — and computed its
     * day boundaries in UTC, so it disagreed with the streak the user actually
     * saw. The response shape is unchanged; there's now one authoritative entry.
     */
    async getStreaks(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const snapshot = await getStreak(context.id);
      if (!snapshot) {
        return { success: false, streaks: [] };
      }

      return {
        success: true,
        streaks: [
          {
            type: "daily_activity",
            currentStreak: snapshot.current,
            longestStreak: snapshot.longest,
            lastActivityDate: snapshot.lastDayKey ?? "",
            state: snapshot.state,
            freezesAvailable: snapshot.freezesAvailable,
            atRiskToday: snapshot.atRiskToday,
          },
        ],
      };
    },
  },
};

