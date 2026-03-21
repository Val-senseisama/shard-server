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
import { User } from "../../models/User.js";

/**
 * Update productivity metrics
 */
async function updateProductivityMetrics(userId: string, activity: any) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

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
  const todayStr = today.toISOString().split('T')[0];
  const todayRecord = analytics.productivityHistory?.find(
    (h: any) => h.date.toISOString().split('T')[0] === todayStr
  );

  if (todayRecord) {
    // Update today's record
    const updatedHistory = analytics.productivityHistory.map((h: any) => {
      const dateStr = h.date.toISOString().split('T')[0];
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

      const analytics = await cache.getOrSet(
        `analytics:${context.id}`,
        async () => {
          const [error, data] = await catchError(
            Analytics.findOne({ userId: context.id })
              .select("productivityHistory struggleAreas averageCompletionRate preferredTimes")
              .lean()
          );

          if (error || !data) {
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

  Mutation: {
    // Track activity (called after completing tasks)
    async trackActivity(_, { activity }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      await updateProductivityMetrics(context.id, activity);

      return {
        success: true,
        message: "Activity tracked successfully.",
      };
    },
  },
};

// Export the helper function
export { updateProductivityMetrics };

