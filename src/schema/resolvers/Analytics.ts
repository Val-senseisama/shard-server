import {
  catchError,
  logError,
  ThrowError,
} from "../../Helpers/Helpers.js";
import Analytics from "../../models/Analytics.js";
import Shard from "../../models/Shard.js";
import MiniGoal from "../../models/MiniGoal.js";
import { cache } from "../../Helpers/Cache.js";
import { generateProductivityInsights } from "../../Helpers/AIHelper.js";
import { tierOf } from "../../Helpers/Entitlements.js";
import { User } from "../../models/User.js";
import { dateKeyInZone } from "../../Helpers/Timezone.js";

/** Map a 0–1 ratio onto the schema's 1–10 severity, only above a floor. */
function severityFrom(ratio: number): number {
  return Math.max(1, Math.min(10, Math.round(ratio * 10)));
}

/**
 * Derive `averageCompletionRate` and `struggleAreas` from the user's actual
 * task data.
 *
 * Both fields existed on the Analytics model and were returned by
 * `getProductivityData`, but nothing ever wrote them — they were hardcoded to
 * `0` and `[]` at every write site, so the insights screen and the AI prompt
 * that consumes them were both running on empty input.
 *
 * The definitions are chosen to be computable from data we already store, and
 * to describe behaviour the user can actually act on:
 *
 *  - **completion rate** — completed ÷ total over non-deleted tasks, matching
 *    the floor-to-integer convention `getUserStats` already uses, but at task
 *    rather than mini-goal granularity because that is what "productivity"
 *    means here.
 *  - **overdue** — share of still-open tasks whose due date has passed.
 *  - **consistency** — share of the last 14 days with no completed task.
 *  - **follow_through** — share of active shards with no completion in 14 days,
 *    i.e. things started and quietly abandoned.
 *
 * A category is only reported once it clears a floor, so a healthy user gets an
 * empty list rather than three shrugging non-problems. Severity is 1–10 to
 * match `StruggleAreaSchema`.
 */
async function computeAnalyticsSignals(userId: string): Promise<{
  averageCompletionRate: number;
  struggleAreas: { category: string; severity: number; lastUpdated: Date }[];
}> {
  const now = new Date();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [shardsErr, shards] = await catchError(
    Shard.find({ owner: userId }, "_id status").lean()
  );
  if (shardsErr || !shards?.length) {
    return { averageCompletionRate: 0, struggleAreas: [] };
  }

  const shardIds = shards.map((s: any) => s._id);
  const activeShardIds = shards
    .filter((s: any) => s.status === "active")
    .map((s: any) => String(s._id));

  const [mgErr, miniGoals] = await catchError(
    MiniGoal.find({ shardId: { $in: shardIds } }, "shardId tasks").lean()
  );
  if (mgErr || !miniGoals?.length) {
    return { averageCompletionRate: 0, struggleAreas: [] };
  }

  let total = 0;
  let completed = 0;
  let openOverdue = 0;
  let open = 0;
  const completionDayKeys = new Set<string>();
  const shardsWithRecentActivity = new Set<string>();

  for (const mg of miniGoals as any[]) {
    for (const t of mg.tasks || []) {
      if (t.deleted) continue;
      total++;

      if (t.completed) {
        completed++;
        if (t.completedAt) {
          const at = new Date(t.completedAt);
          if (at >= fourteenDaysAgo) {
            completionDayKeys.add(at.toISOString().slice(0, 10));
            shardsWithRecentActivity.add(String(mg.shardId));
          }
        }
        continue;
      }

      open++;
      if (t.dueDate && new Date(t.dueDate) < now) openOverdue++;
    }
  }

  if (total === 0) return { averageCompletionRate: 0, struggleAreas: [] };

  const averageCompletionRate = Math.floor((completed / total) * 100);
  const struggleAreas: { category: string; severity: number; lastUpdated: Date }[] = [];

  // Overdue — only meaningful if there is open work to be late on.
  if (open > 0) {
    const overdueRatio = openOverdue / open;
    if (overdueRatio >= 0.25) {
      struggleAreas.push({
        category: "overdue",
        severity: severityFrom(overdueRatio),
        lastUpdated: now,
      });
    }
  }

  // Consistency — silent days over the last fortnight.
  const silentRatio = (14 - completionDayKeys.size) / 14;
  if (silentRatio >= 0.5) {
    struggleAreas.push({
      category: "consistency",
      severity: severityFrom(silentRatio),
      lastUpdated: now,
    });
  }

  // Follow-through — active shards that have gone quiet.
  if (activeShardIds.length > 0) {
    const stalled = activeShardIds.filter((id) => !shardsWithRecentActivity.has(id)).length;
    const stalledRatio = stalled / activeShardIds.length;
    if (stalledRatio >= 0.5) {
      struggleAreas.push({
        category: "follow_through",
        severity: severityFrom(stalledRatio),
        lastUpdated: now,
      });
    }
  }

  return { averageCompletionRate, struggleAreas };
}

/**
 * Update productivity metrics
 */
async function updateProductivityMetrics(userId: string, activity: any) {
  // Bucket the day the USER is in, not the server's.
  //
  // This used to be `setHours(0,0,0,0)` — midnight on Railway, i.e. UTC — and
  // then keyed on `toISOString()`. For anyone west of UTC an evening's work was
  // credited to tomorrow's bar: the productivity chart showed today empty and
  // yesterday doubled. Same bug class as the schedule bucketing and the streak
  // boundaries; the day key is the one place it has to be right.
  const [tzErr, tzUser] = await catchError(
    User.findById(userId).select("timezone").lean()
  );
  const timezone = !tzErr ? (tzUser as any)?.timezone : undefined;
  const todayStr = dateKeyInZone(new Date(), timezone);
  // Stored at the user's local midnight so the recorded instant matches the key.
  const today = new Date(`${todayStr}T00:00:00.000Z`);

  const [error, analytics] = await catchError(
    Analytics.findOne({ userId }).lean()
  );

  if (!analytics) {
    // Create new analytics record
    await Analytics.create({
      userId,
      productivityHistory: [{
        date: today,
        tasksCompleted: activity.tasksCompleted || 0,
        xpEarned: activity.xpEarned || 0,
        shardsActive: activity.shardsActive || 0,
        hoursLogged: activity.hoursLogged || 0,
      }],
      struggleAreas: [],
      averageCompletionRate: 0,
      preferredTimes: [],
    });
    return;
  }

  // Check if today's record exists
  const todayRecord = analytics.productivityHistory?.find(
    (h: any) => new Date(h.date).toISOString().split('T')[0] === todayStr
  );

  if (todayRecord) {
    // Update today's record
    const updatedHistory = analytics.productivityHistory.map((h: any) => {
      const dateStr = new Date(h.date).toISOString().split('T')[0];
      if (dateStr === todayStr) {
        return {
          date: h.date,
          tasksCompleted: (h.tasksCompleted || 0) + (activity.tasksCompleted || 0),
          xpEarned: (h.xpEarned || 0) + (activity.xpEarned || 0),
          shardsActive: Math.max(h.shardsActive || 0, activity.shardsActive || 0),
          hoursLogged: (h.hoursLogged || 0) + (activity.hoursLogged || 0),
        };
      }
      return h;
    });

    await Analytics.findOneAndUpdate(
      { userId },
      { productivityHistory: updatedHistory }
    );
  } else {
    // Add today's record
    await Analytics.findOneAndUpdate(
      { userId },
      {
        $push: {
          productivityHistory: {
            date: today,
            tasksCompleted: activity.tasksCompleted || 0,
            xpEarned: activity.xpEarned || 0,
            shardsActive: activity.shardsActive || 0,
            hoursLogged: activity.hoursLogged || 0,
          },
        },
      }
    );
  }
}

export default {
  Query: {
    async getProductivityData(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Advanced analytics are Pro-only
      const [tierErr, anUser] = await catchError(
        User.findById(context.id, "subscriptionTier role trialStartedAt trialEndsAt firstQuestCompletedAt").lean()
      );
      if (tierOf(anUser as any) === "free") {
        return {
          success: false,
          message: "Advanced analytics are a Pro feature. Upgrade to unlock your productivity insights!",
          needsUpgrade: true,
          weeklyData: [],
          monthlyData: [],
          insights: [],
          struggleAreas: [],
          averageCompletionRate: 0,
        };
      }

      const analytics = await cache.getOrSet(
        `analytics:${context.id}`,
        async () => {
          // Recompute the derived signals on the way through. They live behind
          // the same hourly cache as the read, so this costs two extra queries
          // per user per hour at most, and it keeps the stored document honest
          // for anything that reads it outside this resolver (the AI prompt in
          // particular) rather than only the response we're about to send.
          const signals = await computeAnalyticsSignals(context.id);

          const [error, data] = await catchError(
            Analytics.findOneAndUpdate(
              { userId: context.id },
              {
                $set: {
                  averageCompletionRate: signals.averageCompletionRate,
                  struggleAreas: signals.struggleAreas,
                },
              },
              // `new` so we serve what we just wrote. No upsert: absent a
              // document the user has never completed anything, and the
              // "no data yet" branch below is the correct answer — creating an
              // empty shell here would route them to a screen of zeroes.
              { new: true }
            )
              .select("productivityHistory struggleAreas averageCompletionRate preferredTimes")
              .lean()
          );

          if (error || !data) {
            if (error) logError("getProductivityData:refreshSignals", error);
            return null;
          }

          return data;
        },
        3600 // 1 hour cache
      );

      if (!analytics) {
        return {
          success: true,
          message: "No productivity data yet. Start completing tasks to see your insights!",
          weeklyData: [],
          monthlyData: [],
          insights: [],
        };
      }

      // Calculate weekly data
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      
      const weeklyData = analytics.productivityHistory
        ?.filter((h: any) => new Date(h.date) >= weekAgo)
        .map((h: any) => ({
          date: h.date,
          tasksCompleted: h.tasksCompleted || 0,
          xpEarned: h.xpEarned || 0,
          shardsActive: h.shardsActive || 0,
        })) || [];

      // Calculate monthly data
      const monthAgo = new Date();
      monthAgo.setDate(monthAgo.getDate() - 30);
      
      const monthlyData = analytics.productivityHistory
        ?.filter((h: any) => new Date(h.date) >= monthAgo)
        .map((h: any) => ({
          date: h.date,
          tasksCompleted: h.tasksCompleted || 0,
          xpEarned: h.xpEarned || 0,
          shardsActive: h.shardsActive || 0,
        })) || [];

      // Gather streak count for AI insights
      const [userErr, userData] = await catchError(
        User.findById(context.id).select("currentStreak").lean()
      );

      const weeklyXP = weeklyData.reduce((sum: number, d: any) => sum + (d.xpEarned || 0), 0);
      const tasksThisWeek = weeklyData.reduce((sum: number, d: any) => sum + (d.tasksCompleted || 0), 0);

      // Generate AI-personalized insights (non-blocking fallback)
      const struggleAreaNames = (analytics.struggleAreas || []).map((s: any) =>
        typeof s === 'string' ? s : s.category
      );
      const insights = await generateProductivityInsights({
        completionRate: analytics.averageCompletionRate || 0,
        tasksThisWeek,
        streakCount: (userData as any)?.currentStreak || 0,
        struggleAreas: struggleAreaNames,
        weeklyXP,
      });

      return {
        success: true,
        weeklyData,
        monthlyData,
        insights,
        struggleAreas: struggleAreaNames,
        averageCompletionRate: analytics.averageCompletionRate || 0,
      };
    },

    async getShardAnalytics(_, { shardId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Fetch shard to verify ownership
      const [shardError, shard] = await catchError(
        Shard.findById(shardId).lean()
      );

      if (shardError || !shard) {
        return {
          success: false,
          message: "Shard not found",
          weeklyCompletion: 0,
          dailyProgress: [],
          totalTasks: 0,
          completedTasks: 0,
        };
      }

      // Fetch all mini-goals for this shard
      const [mgError, miniGoals] = await catchError(
        MiniGoal.find({ shardId }).lean()
      );

      if (mgError || !miniGoals || miniGoals.length === 0) {
        return {
          success: true,
          message: "No mini-goals found for this shard",
          weeklyCompletion: 0,
          dailyProgress: [],
          totalTasks: 0,
          completedTasks: 0,
        };
      }

      // Aggregate all tasks from mini-goals
      const allTasks = miniGoals.flatMap(mg => mg.tasks || []);
      const totalTasks = allTasks.length;
      const completedTasks = allTasks.filter(t => t.completed).length;

      // Calculate this week's completion
      // Since we don't have completion timestamps, we'll calculate based on current state
      // This week's completion = percentage of tasks completed in the shard
      const weeklyCompletion = totalTasks > 0 
        ? Math.round((completedTasks / totalTasks) * 100)
        : 0;

      // Build daily progress history
      // Since tasks don't track individual completion dates,
      // we'll show the current state as of today
      const today = new Date().toISOString().split('T')[0];
      const dailyProgressMap = new Map<string, { tasksCompleted: number; tasksTotal: number }>();

      // Initialize today's entry
      dailyProgressMap.set(today, { tasksCompleted: 0, tasksTotal: 0 });

      // Count all tasks and completed tasks
      miniGoals.forEach(mg => {
        const tasksInGoal = mg.tasks?.length || 0;
        const completedInGoal = mg.tasks?.filter(t => t.completed).length || 0;

        const entry = dailyProgressMap.get(today)!;
        entry.tasksTotal += tasksInGoal;
        entry.tasksCompleted += completedInGoal;
      });

      console.log(`📊 [getShardAnalytics] Today: ${today}, Tasks: ${dailyProgressMap.get(today)?.tasksCompleted}/${dailyProgressMap.get(today)?.tasksTotal}`);

      // Convert map to array and sort by date
      const dailyProgress = Array.from(dailyProgressMap.entries())
        .map(([date, data]) => ({
          date,
          tasksCompleted: data.tasksCompleted,
          tasksTotal: data.tasksTotal,
        }))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      return {
        success: true,
        weeklyCompletion,
        dailyProgress,
        totalTasks,
        completedTasks,
      };
    },

    async getMyStats(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Get user's stats
      const [shardsError, activeShards] = await catchError(
        Shard.countDocuments({
          owner: context.id,
          status: { $in: ["active", "paused"] },
        })
      );

      const [completedShardsError, completedShards] = await catchError(
        Shard.countDocuments({
          owner: context.id,
          status: "completed",
        })
      );

      const [miniGoalsError, totalMinigoals] = await catchError(
        MiniGoal.aggregate([
          {
            $lookup: {
              from: "shards",
              localField: "shardId",
              foreignField: "_id",
              as: "shard",
            },
          },
          {
            $match: {
              "shard.owner": { $toObjectId: context.id },
            },
          },
          {
            $group: {
              _id: "$completed",
              count: { $sum: 1 },
            },
          },
        ])
      );

      const completedMinigoals = totalMinigoals?.find((m: any) => m._id === true)?.count || 0;
      const activeMinigoals = totalMinigoals?.reduce((sum: number, m: any) => sum + m.count, 0) || 0;

      return {
        success: true,
        stats: {
          activeShards: activeShards || 0,
          completedShards: completedShards || 0,
          activeMinigoals,
          completedMinigoals,
          completionRate: activeMinigoals > 0 
            ? Math.floor((completedMinigoals / activeMinigoals) * 100)
            : 0,
        },
      };
    },
  },

  // No Mutation block. Productivity is recorded server-side from
  // XP.completeTask via `updateProductivityMetrics` below — see the note in
  // Typedefinitions where `trackActivity` used to be declared.
};

// Export the helper function
export { updateProductivityMetrics };

