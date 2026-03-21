import {
  catchError,
  logError,
  SaveAuditTrail,
  ThrowError,
} from "../../Helpers/Helpers.js";
import SideQuest from "../../models/SideQuest.js";
import Shard from "../../models/Shard.js";
import { awardXP } from "./XP.js";
import { breakDownGoalWithAI } from "../../Helpers/AIHelper.js";
import { cache, cacheKeys, cacheInvalidate } from "../../Helpers/Cache.js";

export default {
  Mutation: {
    // Generate AI side quest (with restrictions)
    async generateSideQuest(_, { category }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Check user has < 3 active shards
      const [error, activeShards] = await catchError(
        Shard.countDocuments({
          owner: context.id,
          status: { $in: ["active", "paused"] },
        })
      );

      if (error) {
        logError("generateSideQuest:countShards", error);
        return {
          success: false,
          message: "Failed to check active quests.",
        };
      }

      if (activeShards >= 3) {
        return {
          success: false,
          message: "Complete some of your active quests first! You can only have side quests when you have less than 3 active quests.",
          needsToComplete: true,
          activeShardsCount: activeShards,
        };
      }

      // Check if user already has recent side quest (within 2 weeks)
      const twoWeeksAgo = new Date();
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

      const [recentError, recentSideQuest] = await catchError(
        SideQuest.findOne({
          userId: context.id,
          recommendedBy: "ai",
          createdAt: { $gte: twoWeeksAgo },
        }).lean()
      );

      if (recentSideQuest && !recentSideQuest.completed) {
        return {
          success: false,
          message: "You already have an active side quest! Complete it before generating a new one.",
          existingSideQuest: {
            id: recentSideQuest._id.toString(),
            title: recentSideQuest.title,
          },
        };
      }

      // Generate AI side quest
      const goal = `Create a single side quest challenge related to ${category || "productivity"}. Make it achievable in 1-3 days.`;

      try {
        const questBreakdown = await breakDownGoalWithAI(goal);

        // Use the first mini-quest as the side quest, fall back to main quest
        const sideQuestData = (questBreakdown.miniQuests && questBreakdown.miniQuests.length > 0)
          ? questBreakdown.miniQuests[0]
          : questBreakdown.mainQuest;

        if (!sideQuestData || !sideQuestData.title) {
          logError("generateSideQuest:noData", "AI returned no usable quest data");
          return {
            success: false,
            message: "Failed to generate side quest. Please try again.",
          };
        }

        const [createError, sideQuest] = await catchError(
          SideQuest.create({
            userId: context.id,
            title: sideQuestData.title,
            description: sideQuestData.description || "",
            difficulty: (questBreakdown.mainQuest?.xpReward ?? sideQuestData.xpReward ?? 0) >= 100 ? "hard" : "medium",
            recommendedBy: "ai",
            xpReward: sideQuestData.xpReward || 50,
            category: category || "general",
            completed: false,
          })
        );

        if (createError) {
          logError("generateSideQuest:create", createError);
          return {
            success: false,
            message: "Failed to generate side quest.",
          };
        }

        // Invalidate cache
        await cache.del(`user:${context.id}:sidequests`);

        SaveAuditTrail({
          userId: context.id,
          task: "Generated Side Quest",
          details: `Generated AI side quest: ${sideQuestData.title}`,
        });

        return {
          success: true,
          message: "Side quest generated!",
          sideQuest: {
            id: sideQuest._id.toString(),
            title: sideQuest.title,
            description: sideQuest.description,
            difficulty: sideQuest.difficulty,
            xpReward: sideQuest.xpReward,
            category: sideQuest.category,
          },
        };
      } catch (error) {
        logError("generateSideQuest:ai", error);
        return {
          success: false,
          message: "Failed to generate side quest. Please try again.",
        };
      }
    },

    // Complete side quest
    async completeSideQuest(_, { sideQuestId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, sideQuest] = await catchError(
        SideQuest.findById(sideQuestId).lean()
      );

      if (error || !sideQuest) {
        return {
          success: false,
          message: "Side quest not found.",
        };
      }

      if (sideQuest.userId.toString() !== context.id) {
        return {
          success: false,
          message: "This side quest doesn't belong to you.",
        };
      }

      if (sideQuest.completed) {
        return {
          success: true,
          message: "Side quest already completed.",
          xpEarned: 0,
        };
      }

      // Mark as complete
      await SideQuest.findByIdAndUpdate(sideQuestId, {
        completed: true,
        completedAt: new Date(),
      });

      // Award XP
      const xpResult = await awardXP(
        context.id,
        sideQuest.xpReward,
        `Completed side quest: ${sideQuest.title}`
      );

      // Invalidate cache
      await cache.del(`user:${context.id}:sidequests`);

      SaveAuditTrail({
        userId: context.id,
        task: "Completed Side Quest",
        details: `Completed side quest: ${sideQuest.title}`,
      });

      return {
        success: true,
        message: "Side quest completed!",
        xpEarned: sideQuest.xpReward,
        xpResult,
      };
    },
  },

  Query: {
    // Get user's side quests
    async mySideQuests(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const sideQuests = await cache.getOrSet(
        `user:${context.id}:sidequests`,
        async () => {
          const [error, quests] = await catchError(
            SideQuest.find({
              userId: context.id,
              completed: false,
            })
              .select("title description difficulty xpReward category createdAt")
              .lean()
          );

          if (error) {
            logError("mySideQuests", error);
            return [];
          }

          return quests;
        },
        1800 // 30 minutes
      );

      return {
        success: true,
        sideQuests: sideQuests.map((q: any) => ({
          id: q._id.toString(),
          title: q.title,
          description: q.description,
          difficulty: q.difficulty,
          xpReward: q.xpReward,
          category: q.category,
          createdAt: q.createdAt,
        })),
      };
    },

    // Check if user can generate a new side quest
    async canGenerateSideQuest(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Check active shards
      const [shardsError, activeShards] = await catchError(
        Shard.countDocuments({
          owner: context.id,
          status: { $in: ["active", "paused"] },
        })
      );

      const tooManyShards = !shardsError && activeShards >= 3;

      // Check recent side quest
      const twoWeeksAgo = new Date();
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

      const [recentError, recentSideQuest] = await catchError(
        SideQuest.findOne({
          userId: context.id,
          createdAt: { $gte: twoWeeksAgo },
          completed: false,
        }).lean()
      );

      const hasRecentSideQuest = !recentError && !!recentSideQuest;

      return {
        success: true,
        canGenerate: !tooManyShards && !hasRecentSideQuest,
        reasons: {
          tooManyShards,
          hasRecentSideQuest,
          activeShardsCount: activeShards || 0,
        },
      };
    },
  },
};

