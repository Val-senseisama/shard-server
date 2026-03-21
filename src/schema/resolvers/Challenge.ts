import {
  catchError,
  logError,
  SaveAuditTrail,
  ThrowError,
} from "../../Helpers/Helpers.js";
import Challenge from "../../models/Challenge.js";
import Shard from "../../models/Shard.js";
import { awardXP } from "./XP.js";
import { cache, cacheKeys, cacheInvalidate } from "../../Helpers/Cache.js";

export default {
  Mutation: {
    // Create a challenge
    async createChallenge(_, { input }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const challenge = await Challenge.create({
        userId: context.id,
        type: input.type,
        title: input.title,
        description: input.description,
        shardId: input.shardId,
        targetDate: new Date(input.targetDate),
        xpReward: input.xpReward || 50,
        completed: false,
      });

      // Invalidate user challenges cache
      await cache.del(`user:${context.id}:challenges`);

      SaveAuditTrail({
        userId: context.id,
        task: "Created Challenge",
        details: `Created ${input.type} challenge: ${input.title}`,
      });

      return {
        success: true,
        message: "Challenge created successfully.",
        challenge: {
          id: challenge._id.toString(),
          title: challenge.title,
          type: challenge.type,
          targetDate: challenge.targetDate,
          xpReward: challenge.xpReward,
        },
      };
    },

    // Complete a challenge
    async completeChallenge(_, { challengeId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, challenge] = await catchError(
        Challenge.findById(challengeId).lean()
      );

      if (error || !challenge) {
        return {
          success: false,
          message: "Challenge not found.",
        };
      }

      if (challenge.userId.toString() !== context.id) {
        return {
          success: false,
          message: "This challenge doesn't belong to you.",
        };
      }

      if (challenge.completed) {
        return {
          success: true,
          message: "Challenge already completed.",
          xpEarned: 0,
        };
      }

      // Mark as complete
      await Challenge.findByIdAndUpdate(challengeId, {
        completed: true,
        completedAt: new Date(),
      });

      // Award XP
      const xpResult = await awardXP(
        context.id,
        challenge.xpReward,
        `Completed ${challenge.type} challenge: ${challenge.title}`
      );

      // Invalidate cache
      await cache.del(`user:${context.id}:challenges`);

      SaveAuditTrail({
        userId: context.id,
        task: "Completed Challenge",
        details: `Completed challenge: ${challenge.title}`,
      });

      return {
        success: true,
        message: "Challenge completed!",
        xpEarned: challenge.xpReward,
        xpResult,
      };
    },
  },

  Query: {
    // Get user's challenges
    async myChallenges(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const challenges = await cache.getOrSet(
        `user:${context.id}:challenges`,
        async () => {
          const [error, challengeList] = await catchError(
            Challenge.find({
              userId: context.id,
              completed: false,
            })
              .select("type title description targetDate xpReward completed")
              .lean()
          );

          if (error) {
            logError("myChallenges", error);
            return [];
          }

          return challengeList;
        },
        1800 // 30 minutes
      );

      return {
        success: true,
        challenges: challenges.map((c: any) => ({
          id: c._id.toString(),
          type: c.type,
          title: c.title,
          description: c.description,
          targetDate: c.targetDate,
          xpReward: c.xpReward,
        })),
      };
    },

    // Get active challenges count
    async getActiveChallengesCount(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, count] = await catchError(
        Challenge.countDocuments({
          userId: context.id,
          completed: false,
        })
      );

      if (error) {
        logError("getActiveChallengesCount", error);
        return {
          success: false,
          count: 0,
        };
      }

      return {
        success: true,
        count,
      };
    },
  },
};

