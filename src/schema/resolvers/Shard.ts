import {
  catchError,
  logError,
  SaveAuditTrail,
  ThrowError,
} from "../../Helpers/Helpers.js";
import Shard from "../../models/Shard.js";
import MiniGoal from "../../models/MiniGoal.js";
import Chat from "../../models/Chat.js";
import { User } from "../../models/User.js";
import { breakDownGoalWithAI, checkAIUsage, trackAIUsage, enrichManualShard, generateReflectionMission } from "../../Helpers/AIHelper.js";
import SideQuest from "../../models/SideQuest.js";
import { createNotification } from "./Notifications.js";
import { cache, cacheKeys, cacheInvalidate } from "../../Helpers/Cache.js";
import { awardXP, checkAchievements } from "./XP.js";
import { getCloudinarySignedUpload } from "../../Helpers/Cloudinary.js";
import { calculateDueDate, distributeDatesEvenly, smartSchedule, SchedulableTask } from "../../Helpers/DateHelper.js";
import { sendNotificationToUsers, sendNotificationToUser } from "../../Helpers/FirebaseMessaging.js";

// ─── Standalone schedule helper (called by both scheduleTasks + generateWeeklyTasks) ───

async function _scheduleShardTasks(shardId: string, userId: string) {
  if (!userId) ThrowError("Please login to continue.");

  const [shardError, shard] = await catchError(Shard.findById(shardId).lean());
  if (shardError || !shard) return { success: false, message: "Quest not found." };

  const isOwner = shard.owner.toString() === userId;
  const isParticipant = shard.participants.some((p: any) => p.user.toString() === userId);
  if (!isOwner && !isParticipant) return { success: false, message: "You don't have access to this quest." };

  const [mgError, miniGoals] = await catchError(
    MiniGoal.find({ shardId, completed: false }).sort({ createdAt: 1 })
  );
  if (mgError || !miniGoals || miniGoals.length === 0) return { success: false, message: "No active goals found." };

  const [, userWithPrefs] = await catchError(User.findById(userId, "preferences").lean());
  const prefs = (userWithPrefs as any)?.preferences || {};

  // Build task list from existing incomplete tasks (preserving order)
  const tasksByGoal: SchedulableTask[][] = miniGoals.map((mg: any, goalIdx: number) =>
    mg.tasks
      .filter((t: any) => !t.completed && !t.deleted)
      .map((t: any) => ({
        miniGoalIndex: goalIdx,
        taskIndex: mg.tasks.indexOf(t),
        title: t.title,
      }))
  );

  const totalTasks = tasksByGoal.reduce((sum, g) => sum + g.length, 0);
  if (totalTasks === 0) return { success: true, message: "No tasks to schedule — all done!" };

  const startDate = new Date();
  const deadline = shard.timeline?.endDate ? new Date(shard.timeline.endDate) : undefined;

  const scheduled = smartSchedule(
    tasksByGoal,
    startDate,
    {
      workingDays: prefs.workingDays || [1, 2, 3, 4, 5],
      maxTasksPerDay: prefs.maxTasksPerDay || 4,
      preferredTaskDuration: prefs.preferredTaskDuration || 'medium',
    },
    deadline,
  );

  // Apply dates to DB
  for (let goalIdx = 0; goalIdx < miniGoals.length; goalIdx++) {
    const mg = miniGoals[goalIdx];
    const goalSchedule = scheduled.filter(s => s.miniGoalIndex === goalIdx);
    let changed = false;

    for (const s of goalSchedule) {
      if (mg.tasks[s.taskIndex]) {
        mg.tasks[s.taskIndex].dueDate = s.dueDate;
        mg.tasks[s.taskIndex].rescheduled = true;
        changed = true;
      }
    }

    if (goalSchedule.length > 0) {
      mg.dueDate = goalSchedule[goalSchedule.length - 1].dueDate;
    }

    if (changed) await mg.save();
  }

  await cacheInvalidate.shard(shardId);
  await cacheInvalidate.shardList(userId);

  return {
    success: true,
    message: `${totalTasks} tasks rescheduled!`,
    tasks: scheduled.map(s => ({
      title: tasksByGoal[s.miniGoalIndex]?.find(t => t.taskIndex === s.taskIndex)?.title || '',
      dueDate: s.dueDate.toISOString(),
      completed: false,
    })),
  };
}

export default {
  Mutation: {
    // Create a new quest (Shard) with AI breakdown
    async createShard(_, { goal, deadline, image, participants, isPrivate, isAnonymous }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      console.log("🚀 [createShard] Starting shard creation with AI");
      console.log("📝 [createShard] Input:", { goal, deadline, image, participantsCount: participants?.length });

      try {
        // Get user tier to check AI limits
        console.log("👤 [createShard] Fetching user data for:", context.id);
        const [userError, user] = await catchError(
          User.findById(context.id, "role subscriptionTier").lean()
        );

        if (userError) {
          console.error("❌ [createShard] User fetch error:", userError);
          logError("createShard:getUser", userError);
          return {
            success: false,
            message: "Failed to verify user.",
          };
        }

        console.log("✅ [createShard] User found:", { userId: context.id, role: user?.role });

        // Check AI usage limit based on user's subscription tier
        console.log("🔍 [createShard] Checking AI usage limits");
        const tier = user?.subscriptionTier || 'free';
        const usageCheck = await checkAIUsage(context.id, tier);
        console.log("📊 [createShard] AI usage:", usageCheck);

        if (!usageCheck.canProceed) {
          console.warn("⚠️ [createShard] AI limit reached for user:", context.id);
          return {
            success: false,
            message: `You've reached your daily AI limit (${usageCheck.limit} calls). Upgrade to Pro for unlimited AI quests!`,
            needsUpgrade: true,
          };
        }

        // Track AI usage
        console.log("📈 [createShard] Tracking AI usage");
        await trackAIUsage(context.id);

        // Call AI to break down the goal
        console.log("🤖 [createShard] Calling Groq AI to break down goal");
        console.log("🎯 [createShard] Goal:", goal);
        console.log("📅 [createShard] Deadline:", deadline);
        
        const questBreakdown = await breakDownGoalWithAI(goal, deadline);
        
        console.log("✨ [createShard] AI breakdown complete!");
        console.log("📋 [createShard] Main Quest:", questBreakdown.mainQuest?.title);
        console.log("🎯 [createShard] Mini Quests count:", questBreakdown.miniQuests?.length);

        // Create a chat group for this shard ONLY if there are multiple participants
        let shardChat = null;
        const participantIds = participants ? participants.map((p: any) => p.user) : [];
        const totalParticipants = [context.id, ...participantIds];
        
        if (totalParticipants.length > 1) {
          console.log("💬 [createShard] Creating chat group (multiple participants)");
          console.log("👥 [createShard] Chat participants:", totalParticipants);
          
          const [chatError, chat] = await catchError(
            Chat.create({
              type: "shard",
              participants: totalParticipants, // Owner + participants
              shardId: undefined, // Will be set after shard creation
              name: questBreakdown.mainQuest.title,
            })
          );

          if (chatError) {
            console.error("❌ [createShard] Chat creation error:", chatError);
            logError("createShard:createChat", chatError);
            // Continue even if chat creation fails
          } else {
            shardChat = chat;
            console.log("✅ [createShard] Chat created:", shardChat?._id);
          }
        } else {
          console.log("ℹ️ [createShard] Skipping chat creation (only one participant)");
        }


        // Create the Shard (main quest)
        console.log("🏗️ [createShard] Creating shard document");
        const shardData = {
          title: questBreakdown.mainQuest.title,
          description: questBreakdown.mainQuest.description,
          owner: context.id,
          participants: participants
            ? participants.map((p: any) => ({
              user: p.user,
              role: p.role,
            }))
            : [],
          image: image,
          chatId: shardChat?._id,
          timeline: {
            startDate: new Date(),
            endDate: deadline ? new Date(deadline) : undefined,
          },
          progress: {
            completion: 0,
            xpEarned: 0,
            level: 1,
          },
          status: "active",
          isPrivate: isPrivate || false,
          isAnonymous: isAnonymous || false,
          rewards: [
            {
              type: "xp",
              value: questBreakdown.mainQuest.xpReward,
            },
          ],
        };
        
        console.log("📦 [createShard] Shard data:", JSON.stringify(shardData, null, 2));
        
        const [shardError, newShard] = await catchError(
          Shard.create(shardData)
        );

        // Update chat with shardId
        if (shardChat && newShard) {
          console.log("🔗 [createShard] Linking chat to shard");
          await Chat.findByIdAndUpdate(shardChat._id, {
            shardId: newShard._id,
          });
        }

        if (shardError) {
          console.error("❌ [createShard] Shard creation error:", shardError);
          logError("createShard:createShard", shardError);
          return {
            success: false,
            message: "Failed to create quest.",
          };
        }

        console.log("✅ [createShard] Shard created:", newShard._id);

        // Calculate shard end date from AI estimate or use provided deadline
        const shardStartDate = new Date();
        const shardEndDate = deadline
          ? new Date(deadline)
          : questBreakdown.mainQuest.estimatedDuration
            ? calculateDueDate(shardStartDate, questBreakdown.mainQuest.estimatedDuration)
            : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // Default 30 days

        console.log("📅 [createShard] Timeline:", { start: shardStartDate, end: shardEndDate });

        // Fetch user preferences for smart scheduling
        const [prefError, userWithPrefs] = await catchError(
          User.findById(context.id, "preferences").lean()
        );
        const prefs = (userWithPrefs as any)?.preferences || {};

        // Build flat task list grouped by mini-goal for smart scheduling
        const tasksByGoal: SchedulableTask[][] = questBreakdown.miniQuests.map(
          (mq: any, goalIdx: number) =>
            mq.steps.map((step: any, taskIdx: number) => ({
              miniGoalIndex: goalIdx,
              taskIndex: taskIdx,
              title: step.text,
            }))
        );

        // Smart schedule: packs tasks tightly on working days
        const scheduled = smartSchedule(
          tasksByGoal,
          shardStartDate,
          {
            workingDays: prefs.workingDays || [1, 2, 3, 4, 5],
            maxTasksPerDay: prefs.maxTasksPerDay || 4,
            preferredTaskDuration: prefs.preferredTaskDuration || 'medium',
          },
          shardEndDate,
        );

        // Create mini-goals with smart-scheduled task dates
        console.log("🎯 [createShard] Creating mini-goals with smart scheduling");

        const miniGoalsPromises = questBreakdown.miniQuests.map(
          async (mq: any, index: number) => {
            const goalSchedule = scheduled.filter(s => s.miniGoalIndex === index);
            // Mini-goal due date = last task date in that goal
            const miniGoalDueDate = goalSchedule.length > 0
              ? goalSchedule[goalSchedule.length - 1].dueDate
              : shardEndDate;

            const tasks = mq.steps.map((step: any, stepIndex: number) => {
              const s = goalSchedule.find(g => g.taskIndex === stepIndex);
              return {
                title: step.text,
                dueDate: s?.dueDate || shardEndDate,
                completed: false,
                xpReward: step.xpReward || 20,
              };
            });

            console.log(`  📌 [createShard] Mini-goal ${index + 1}: ${mq.title} (${tasks.length} tasks)`);

            return await MiniGoal.create({
              shardId: newShard._id,
              title: mq.title,
              description: mq.description,
              dueDate: miniGoalDueDate,
              progress: 0,
              completed: false,
              tasks,
            });
          }
        );

        await Promise.all(miniGoalsPromises);
        console.log("✅ [createShard] All mini-goals created");

        // Invalidate user's shard list cache
        await cacheInvalidate.shardList(context.id);
        console.log("🗑️ [createShard] Cache invalidated");

        SaveAuditTrail({
          userId: context.id,
          task: "Created Shard",
          details: `Created quest: ${newShard.title}`,
        });

        // Notify participants
        if (participants && participants.length > 0) {
          const participantIds = participants.map((p: any) => p.user);
          await sendNotificationToUsers(
            participantIds,
            {
              title: "New Quest Invite",
              body: `You've been invited to join the quest: ${newShard.title}`,
              data: { shardId: newShard._id.toString(), screen: "/shard-info" }
            },
            'shardInvites' // Check shard invite preferences
          );
        }

        console.log("🎉 [createShard] Shard creation complete!");
        console.log("📊 [createShard] Result:", {
          shardId: newShard._id.toString(),
          title: newShard.title,
          aiCallsRemaining: usageCheck.remaining - 1,
        });

        // Check achievements fire-and-forget
        checkAchievements(context.id).catch(() => {});

        return {
          success: true,
          message: "Quest created successfully!",
          shard: {
            id: newShard._id.toString(),
            title: newShard.title,
            description: newShard.description,
            status: newShard.status,
            progress: newShard.progress,
            aiUsed: true,
            aiCallsRemaining: usageCheck.remaining === -1 ? -1 : usageCheck.remaining - 1,
          },
        };
      } catch (error) {
        console.error("💥 [createShard] Fatal error:", error);
        console.error("💥 [createShard] Error stack:", (error as Error).stack);
        logError("createShard", error);
        return {
          success: false,
          message: "Failed to create quest. Please try again.",
        };
      }
    },

    // Create Shard manually (without AI)
    async createShardManual(_, { input }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      try {
        // Enrich manual shard with AI-generated rewards and timelines if mini-goals provided
        let enrichment: any = null;
        if (input.miniGoals && input.miniGoals.length > 0) {
          try {
            enrichment = await enrichManualShard({
              title: input.title,
              description: input.description,
              miniGoals: input.miniGoals,
              deadline: input.timeline?.endDate,
            });
          } catch (error) {
            logError("enrichManualShard", error);
            // Continue without enrichment if it fails
          }
        }

        const [shardError, newShard] = await catchError(
          Shard.create({
            title: input.title,
            description: input.description,
            owner: context.id,
            participants: input.participants
              ? input.participants.map((p: any) => ({
                user: p.user,
                role: p.role,
              }))
              : [],
            image: input.image,
            timeline: {
              startDate: input.timeline?.startDate ? new Date(input.timeline.startDate) : new Date(),
              endDate: input.timeline?.endDate ? new Date(input.timeline.endDate) : undefined,
            },
            progress: {
              completion: 0,
              xpEarned: 0,
              level: 1,
            },
            status: "active",
            isPrivate: input.isPrivate || false,
            isAnonymous: input.isAnonymous || false,
            rewards: enrichment
              ? [{ type: "xp", value: enrichment.mainQuestXP }]
              : input.rewards || [],
          })
        );

        if (shardError) {
          logError("createShardManual", shardError);
          return {
            success: false,
            message: "Failed to create quest.",
          };
        }

        // Create mini-goals if provided — use smart scheduling
        if (input.miniGoals && input.miniGoals.length > 0) {
          const shardStartDate = input.timeline?.startDate ? new Date(input.timeline.startDate) : new Date();
          const shardEndDate = input.timeline?.endDate ? new Date(input.timeline.endDate) : undefined;

          // Fetch user preferences
          const [prefErr, userPrefs] = await catchError(
            User.findById(context.id, "preferences").lean()
          );
          const prefs = (userPrefs as any)?.preferences || {};

          // Build task list for smart scheduling
          const tasksByGoal: SchedulableTask[][] = input.miniGoals.map(
            (mg: any, goalIdx: number) =>
              (mg.tasks || []).map((task: any, taskIdx: number) => ({
                miniGoalIndex: goalIdx,
                taskIndex: taskIdx,
                title: task.title,
              }))
          );

          const scheduled = smartSchedule(
            tasksByGoal,
            shardStartDate,
            {
              workingDays: prefs.workingDays || [1, 2, 3, 4, 5],
              maxTasksPerDay: prefs.maxTasksPerDay || 4,
              preferredTaskDuration: prefs.preferredTaskDuration || 'medium',
            },
            shardEndDate,
          );

          const miniGoalsPromises = input.miniGoals.map(async (mg: any, index: number) => {
            const enrichedMG = enrichment?.miniGoals?.[index];
            const goalSchedule = scheduled.filter(s => s.miniGoalIndex === index);
            const miniGoalDueDate = goalSchedule.length > 0
              ? goalSchedule[goalSchedule.length - 1].dueDate
              : shardEndDate;

            const tasks = (mg.tasks || []).map((task: any, taskIndex: number) => {
              const enrichedTask = enrichedMG?.tasks?.[taskIndex];
              const s = goalSchedule.find(g => g.taskIndex === taskIndex);
              return {
                title: task.title,
                dueDate: s?.dueDate || miniGoalDueDate,
                completed: false,
                xpReward: enrichedTask?.xpReward || 20,
              };
            });

            return await MiniGoal.create({
              shardId: newShard._id,
              title: mg.title,
              description: mg.description || "",
              dueDate: miniGoalDueDate,
              progress: 0,
              completed: false,
              tasks,
            });
          });

          await Promise.all(miniGoalsPromises);
        }

        // Create chat if there are multiple participants
        const participantIds = input.participants ? input.participants.map((p: any) => p.user?.toString() ?? p.userId) : [];
        const totalParticipants = [context.id, ...participantIds];
        
        if (totalParticipants.length > 1) {
          console.log("💬 [createShardManual] Creating chat group (multiple participants)");
          const [chatError, shardChat] = await catchError(
            Chat.create({
              type: "shard",
              participants: totalParticipants,
              shardId: newShard._id,
              name: `${newShard.title} Chat`,
            })
          );

          if (!chatError && shardChat) {
            // Update shard with chat ID
            await Shard.findByIdAndUpdate(newShard._id, { chatId: shardChat._id });
            console.log("✅ [createShardManual] Chat created:", shardChat._id);
          } else {
            logError("createShardManual:createChat", chatError);
          }
        } else{
          console.log("ℹ️ [createShardManual] Skipping chat creation (only one participant)");
        }

        SaveAuditTrail({
          userId: context.id,
          task: "Created Shard Manually",
          details: `Created quest: ${newShard.title}`,
        });

        return {
          success: true,
          message: "Quest created successfully!",
          shard: {
            id: newShard._id.toString(),
            title: newShard.title,
            description: newShard.description,
            status: newShard.status,
          },
        };
      } catch (error) {
        logError("createShardManual", error);
        return {
          success: false,
          message: "Failed to create quest. Please try again.",
        };
      }
    },

    // Update Shard
    async updateShard(_, { id, input }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Verify ownership
      const [verifyError, shard] = await catchError(
        Shard.findById(id).lean()
      );

      if (verifyError || !shard) {
        return {
          success: false,
          message: "Quest not found.",
        };
      }

      if (shard.owner.toString() !== context.id) {
        return {
          success: false,
          message: "You don't have permission to update this quest.",
        };
      }

      // Optional optimistic concurrency check
      if (input.version !== undefined && shard.version !== input.version) {
        return {
          success: false,
          message: "Version conflict. Please refresh and retry.",
        };
      }

      const setFields: any = {};
      if (input.title) setFields.title = input.title;
      if (input.description) setFields.description = input.description;
      if (input.status) setFields.status = input.status;
      if (input.image !== undefined) setFields.image = input.image;
      if (input.isPrivate !== undefined) setFields.isPrivate = input.isPrivate;
      if (input.isAnonymous !== undefined) setFields.isAnonymous = input.isAnonymous;
      if (input.participants) {
        setFields.participants = input.participants.map((p: any) => ({
          user: p.user,
          role: p.role,
        }));
      }
      if (input.timeline) {
        setFields.timeline = {
          startDate: input.timeline.startDate
            ? new Date(input.timeline.startDate)
            : shard.timeline.startDate,
          endDate: input.timeline.endDate
            ? new Date(input.timeline.endDate)
            : shard.timeline.endDate,
        };
      }

      const [updateError, updatedShard] = await catchError(
        Shard.findByIdAndUpdate(id, { $set: setFields, $inc: { version: 1 } }, { new: true }).lean()
      );

      if (updateError) {
        logError("updateShard", updateError);
        return {
          success: false,
          message: "Failed to update quest.",
        };
      }

      // Sync participants with chat if participants were updated
      if (input.participants && shard.chatId) {
        const [chatError, chat] = await catchError(
          Chat.findById(shard.chatId).lean()
        );

        if (!chatError && chat) {
          // New participant list: owner + all participants
          const newChatParticipants = [
            shard.owner.toString(),
            ...input.participants.map((p: any) => p.user?.toString() ?? p.userId),
          ];

          await Chat.findByIdAndUpdate(shard.chatId, {
            participants: [...new Set(newChatParticipants)], // Remove duplicates
          });
        }
      }

      // Invalidate cache
      await cacheInvalidate.shard(id);

      SaveAuditTrail({
        userId: context.id,
        task: "Updated Shard",
        details: `Updated quest: ${updatedShard.title}`,
      });

      // Notify participants of update
      const participantIds = updatedShard.participants
        .map((p: any) => p.user.toString())
        .filter((uid: string) => uid !== context.id);

      if (participantIds.length > 0) {
        await sendNotificationToUsers(
          participantIds,
          {
            title: "Quest Updated",
            body: `${updatedShard.title} has been updated.`,
            data: { shardId: updatedShard._id.toString(), screen: "/shard-info" }
          },
          'shardUpdates'
        );
      }

      // Trigger reflection mission when shard is marked complete
      if (input.status === 'completed' && shard.status !== 'completed') {
        generateReflectionMission(updatedShard.title, updatedShard.progress.completion)
          .then(async (mission) => {
            if (!mission) return;
            await SideQuest.create({
              userId: context.id,
              title: mission.title,
              description: mission.description,
              difficulty: 'easy',
              xpReward: mission.xpReward || 30,
              category: 'reflection',
              recommendedBy: 'ai',
            });
          })
          .catch((err) => logError('reflectionMission', err));

        await createNotification(
          context.id,
          `Quest complete! A reflection mission is waiting for you.`,
          'achievement',
          { shardId: updatedShard._id.toString() }
        );
      }

      return {
        success: true,
        message: "Quest updated successfully!",
        shard: {
          id: updatedShard._id.toString(),
          title: updatedShard.title,
          description: updatedShard.description,
          status: updatedShard.status,
          progress: updatedShard.progress,
        },
      };
    },

    // Delete Shard
    async deleteShard(_, { id }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Verify ownership
      const [verifyError, shard] = await catchError(
        Shard.findById(id).lean()
      );

      if (verifyError || !shard) {
        return {
          success: false,
          message: "Quest not found.",
        };
      }

      if (shard.owner.toString() !== context.id) {
        return {
          success: false,
          message: "You don't have permission to delete this quest.",
        };
      }

      // Delete associated mini-goals
      await MiniGoal.deleteMany({ shardId: id });

      // Delete the shard
      await Shard.findByIdAndDelete(id);

      // Invalidate cache
      await cacheInvalidate.shard(id);
      await cacheInvalidate.shardList(context.id);

      SaveAuditTrail({
        userId: context.id,
        task: "Deleted Shard",
        details: `Deleted quest: ${shard.title}`,
      });

      return {
        success: true,
        message: "Quest deleted successfully.",
      };
    },

    // Add participant to Shard
    async addShardParticipant(_, { shardId, userId, role }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [shardError, shard] = await catchError(
        Shard.findById(shardId).lean()
      );

      if (shardError || !shard) {
        return {
          success: false,
          message: "Quest not found.",
        };
      }

      // Only owner can add participants
      if (shard.owner.toString() !== context.id) {
        return {
          success: false,
          message: "Only the quest owner can add participants.",
        };
      }

      // Check if user exists
      const [userError, user] = await catchError(User.findById(userId).lean());

      if (userError || !user) {
        return {
          success: false,
          message: "User not found.",
        };
      }

      // Check if already a participant
      const isAlreadyParticipant = shard.participants.some(
        (p: any) => p.user.toString() === userId
      );

      if (isAlreadyParticipant) {
        return {
          success: false,
          message: "User is already a participant.",
        };
      }

      // Add participant to shard
      const updatedParticipants = [
        ...shard.participants,
        {
          user: userId,
          role: role || "collaborator",
        },
      ];

      await Shard.findByIdAndUpdate(shardId, {
        participants: updatedParticipants,
      });

      // Add participant to shard's chat group
      if (shard.chatId) {
        const [chatError, chat] = await catchError(
          Chat.findById(shard.chatId).lean()
        );

        if (!chatError && chat) {
          const updatedChatParticipants = [
            ...chat.participants.map((p: any) => p.toString()),
            userId,
          ];

          await Chat.findByIdAndUpdate(shard.chatId, {
            participants: updatedChatParticipants,
          });
        }
      }

      // Invalidate cache
      await cacheInvalidate.shardList(context.id);

      SaveAuditTrail({
        userId: context.id,
        task: "Added Shard Participant",
        details: `Added ${user.username} as ${role} to quest: ${shard.title}`,
      });

      // Notify added user
      await sendNotificationToUser(
        userId,
        {
          title: "Quest Invite",
          body: `You've been added to ${shard.title}`,
          data: { shardId: shardId, screen: "/shard-info" }
        },
        'shardInvites' // Check shard invite preferences
      );

      return {
        success: true,
        message: "Participant added successfully.",
        addedUser: {
          id: userId,
          username: user.username,
          role: role || "collaborator",
        },
      };
    },

    // Remove participant from Shard
    async removeShardParticipant(_, { shardId, userId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [shardError, shard] = await catchError(
        Shard.findById(shardId).lean()
      );

      if (shardError || !shard) {
        return {
          success: false,
          message: "Quest not found.",
        };
      }

      // Only owner can remove participants (or user themselves)
      if (shard.owner.toString() !== context.id && context.id !== userId) {
        return {
          success: false,
          message: "Only the quest owner can remove participants.",
        };
      }

      // Remove participant
      const updatedParticipants = shard.participants.filter(
        (p: any) => p.user.toString() !== userId
      );

      await Shard.findByIdAndUpdate(shardId, {
        participants: updatedParticipants,
      });

      // Remove from chat group
      if (shard.chatId) {
        const [chatError, chat] = await catchError(
          Chat.findById(shard.chatId).lean()
        );

        if (!chatError && chat) {
          const updatedChatParticipants = chat.participants
            .map((p: any) => p.toString())
            .filter((p: string) => p !== userId);

          await Chat.findByIdAndUpdate(shard.chatId, {
            participants: updatedChatParticipants,
          });
        }
      }

      // Invalidate cache
      await cacheInvalidate.shardList(context.id);

      SaveAuditTrail({
        userId: context.id,
        task: "Removed Shard Participant",
        details: `Removed participant ${userId} from quest: ${shard.title}`,
      });

      return {
        success: true,
        message: "Participant removed successfully.",
      };
    },

    // Assign mini-goal to collaborator
    async assignMiniGoal(_, { miniGoalId, userId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Get mini-goal with shard info
      const [minigoalError, minigoal] = await catchError(
        MiniGoal.findById(miniGoalId)
          .populate("shardId")
          .lean()
      );

      if (minigoalError || !minigoal || !minigoal.shardId) {
        return {
          success: false,
          message: "Mini-goal not found.",
        };
      }

      const shard: any = minigoal.shardId;

      // Check permissions
      // Only owner and accountability partners can assign
      const isOwner = shard.owner.toString() === context.id;
      const isAccountabilityPartner = shard.participants.some(
        (p: any) => p.user.toString() === context.id && p.role === "accountability_partner"
      );

      if (!isOwner && !isAccountabilityPartner) {
        return {
          success: false,
          message: "Only owners and accountability partners can assign goals.",
        };
      }

      // Verify user is a collaborator on this shard
      const isCollaborator = shard.participants.some(
        (p: any) => p.user.toString() === userId && p.role === "collaborator"
      );

      if (!isCollaborator && userId !== shard.owner.toString()) {
        return {
          success: false,
          message: "User must be a collaborator or owner to be assigned a mini-goal.",
        };
      }

      // Update mini-goal to track assignment
      // Add assignment tracking (can extend MiniGoal model or use a separate field)
      await MiniGoal.findByIdAndUpdate(miniGoalId, {
        assignedTo: userId,
      });

      SaveAuditTrail({
        userId: context.id,
        task: "Assigned Mini-Goal",
        details: `Assigned mini-goal to ${userId}`,
      });

      // Notify assignee
      await sendNotificationToUser(
        userId,
        {
          title: "New Goal Assignment",
          body: `You've been assigned a new goal in ${shard.title}`,
          data: { shardId: shard._id.toString(), screen: "/shard-info" }
        },
        'questDeadlines' // Check quest deadline preferences
      );

      return {
        success: true,
        message: "Mini-goal assigned successfully.",
      };
    },

    // Complete mini-goal
    async completeMiniGoal(_, { miniGoalId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, minigoal] = await catchError(
        MiniGoal.findById(miniGoalId)
          .populate("shardId")
          .lean()
      );

      if (error || !minigoal) {
        return {
          success: false,
          message: "Mini-goal not found.",
        };
      }

      if (minigoal.completed) {
        return {
          success: true,
          message: "Mini-goal already completed.",
          xpEarned: 0,
        };
      }

      // Get shard to award XP
      const shard: any = minigoal.shardId;

      // Check for early completion bonus
      const { updateStreak } = await import("../../Helpers/StreakHelper.js");
      const { calculateEarlyCompletionBonus } = await import("../../Helpers/StreakHelper.js");
      
      const earlyBonus = calculateEarlyCompletionBonus(
        minigoal.dueDate,
        new Date()
      );

      // Base XP + early bonus
      const totalXP = 100 + earlyBonus.bonusXP;

      // Award XP for completing mini-goal
      const xpResult = await awardXP(
        context.id,
        totalXP,
        `Completed mini-goal: ${minigoal.title}${earlyBonus.isEarly ? ` (${earlyBonus.daysEarly} days early!)` : ''}`
      );

      // Update streak
      await updateStreak(context.id);

      // Update mini-goal
      await MiniGoal.findByIdAndUpdate(miniGoalId, {
        completed: true,
        progress: 100,
      });

      // Check and update shard progress
      const allMinigoals = await MiniGoal.find({ shardId: shard._id }).lean();
      const completedCount = allMinigoals.filter((m: any) => m.completed).length;
      const shardProgress = Math.floor((completedCount / allMinigoals.length) * 100);

      // Update shard
      await Shard.findByIdAndUpdate(shard._id, {
        "progress.completion": shardProgress,
      });

      // Invalidate cache
      await cacheInvalidate.shard(shard._id.toString());
      await cacheInvalidate.shardList(context.id);

      SaveAuditTrail({
        userId: context.id,
        task: "Completed Mini-Goal",
        details: `Completed mini-goal: ${minigoal.title}${earlyBonus.isEarly ? ` (early completion bonus: +${earlyBonus.bonusXP} XP)` : ''}`,
      });

      // Check achievements (fire-and-forget — never blocks response)
      checkAchievements(context.id).catch(() => {});

      return {
        success: true,
        message: earlyBonus.isEarly
          ? `Mini-goal completed ${earlyBonus.daysEarly} days early! Bonus: +${earlyBonus.bonusXP} XP`
          : "Mini-goal completed!",
        xpEarned: totalXP,
        xpResult,
        shardProgress,
        earlyCompletion: earlyBonus.isEarly ? {
          daysEarly: earlyBonus.daysEarly,
          bonusXP: earlyBonus.bonusXP
        } : null,
      };
    },

    async scheduleTasks(_, { shardId }, context) {
      return _scheduleShardTasks(shardId, context.id);
    },

    async generateWeeklyTasks(_, { miniGoalId }, context) {
      if (!context.id) ThrowError("Please login to continue.");
      const [mgErr, miniGoal] = await catchError(
        MiniGoal.findById(miniGoalId).lean()
      );
      if (mgErr || !miniGoal) {
        return { success: false, message: "Mini-goal not found." };
      }
      return _scheduleShardTasks(miniGoal.shardId.toString(), context.id);
    },

    // Soft delete a task
    async deleteTask(_, { miniGoalId, taskTitle }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, miniGoal] = await catchError(
        MiniGoal.findById(miniGoalId).populate("shardId")
      );

      if (error || !miniGoal) {
        return {
          success: false,
          message: "Mini-goal not found.",
        };
      }

      const shard: any = miniGoal.shardId;

      // Verify ownership/participation
      const isOwner = shard.owner.toString() === context.id;
      const isParticipant = shard.participants.some(
        (p: any) => p.user.toString() === context.id
      );

      if (!isOwner && !isParticipant) {
        return {
          success: false,
          message: "You don't have access to this shard.",
        };
      }

      // Find task by title
      const task = miniGoal.tasks.find((t: any) => t.title === taskTitle);

      if (!task) {
        return {
          success: false,
          message: "Task not found.",
        };
      }

      if (task.deleted) {
        return {
          success: false,
          message: "Task is already deleted.",
        };
      }

      // Soft delete
      task.deleted = true;
      task.deletedAt = new Date();
      task.deletedBy = context.id;

      await miniGoal.save();
      await cacheInvalidate.shard(shard._id.toString());

      return {
        success: true,
        message: "Task deleted. You can restore it within 30 days.",
      };
    },

    // Restore a soft-deleted task
    async restoreTask(_, { miniGoalId, taskTitle }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, miniGoal] = await catchError(
        MiniGoal.findById(miniGoalId).populate("shardId")
      );

      if (error || !miniGoal) {
        return {
          success: false,
          message: "Mini-goal not found.",
        };
      }

      const shard: any = miniGoal.shardId;

      // Verify ownership/participation
      const isOwner = shard.owner.toString() === context.id;
      const isParticipant = shard.participants.some(
        (p: any) => p.user.toString() === context.id
      );

      if (!isOwner && !isParticipant) {
        return {
          success: false,
          message: "You don't have access to this shard.",
        };
      }

      // Find deleted task
      const task = miniGoal.tasks.find((t: any) => t.title === taskTitle && t.deleted);

      if (!task) {
        return {
          success: false,
          message: "Deleted task not found.",
        };
      }

      // Restore
      task.deleted = false;
      task.deletedAt = undefined;
      task.deletedBy = undefined;

      await miniGoal.save();
      await cacheInvalidate.shard(shard._id.toString());

      return {
        success: true,
        message: "Task restored successfully.",
      };
    },
  },

  Query: {
    getSignedUploadUrl: async (_, __, context) => {
      // No auth required for signed upload parameters
      const params = getCloudinarySignedUpload();
      console.log("params", params);

      return {
        success: true,
        message: "Signed upload URL generated",
        uploadUrl: `https://api.cloudinary.com/v1_1/${params.cloudName}/auto/upload`,
        params,
      };
    },
    // Get user's shards (NO CACHE - always fetch fresh)
    async myShards(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, shardList] = await catchError(
        Shard.find({
          owner: context.id,
        })
          .select("title description image status progress timeline participants createdAt updatedAt")
          .sort({ createdAt: -1 })
          .lean()
      );

      if (error) {
        logError("myShards", error);
        return {
          success: true,
          shards: [],
        };
      }

      return {
        success: true,
        shards: (shardList || []).map((s: any) => ({
          id: s._id.toString(),
          title: s.title,
          description: s.description,
          image: s.image,
          status: s.status,
          progress: s.progress,
          timeline: s.timeline,
          participantsCount: s.participants?.length || 0,
        })),
      };
    },

    // Get single Shard with details (NO CACHE - always fetch fresh)
    async getShard(_, { id }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Fetch shard data directly from database
      const [error, shardData] = await catchError(
        Shard.findById(id)
          .select("title description image status progress timeline participants rewards owner chatId isPrivate isAnonymous version createdAt updatedAt")
          .populate("owner", "username")
          .lean()
      );

      if (error || !shardData) {
        throw new Error("Quest not found");
      }

      // Fetch mini-goals directly from database
      const [mgError, minigoalsList] = await catchError(
        MiniGoal.find({ shardId: id })
          .select("_id title description progress completed tasks")
          .lean()
      );

      const minigoals = minigoalsList || [];

      // Populate participant user details (username, profilePic)
      const participantUserIds = (shardData.participants || []).map((p: any) => p.user);
      const [usersError, participantUsers] = await catchError(
        User.find({ _id: { $in: participantUserIds } }).select("username profilePic").lean()
      );
      const userMap = new Map((participantUsers || []).map((u: any) => [u._id.toString(), u]));

      return {
        success: true,
        shard: {
          id: shardData._id.toString(),
          title: shardData.title,
          description: shardData.description,
          image: shardData.image,
          status: shardData.status,
          chatId: shardData.chatId?.toString(),
          progress: shardData.progress,
          timeline: shardData.timeline,
          participants: (shardData.participants || []).map((p: any) => {
            const u = userMap.get(p.user.toString());
            return {
              user: p.user.toString(),
              role: p.role,
              username: u?.username || null,
              profilePic: u?.profilePic || null,
            };
          }),
          rewards: shardData.rewards,
          owner: {
            id: (shardData.owner as any)._id.toString(),
            username: (shardData.owner as any).username,
          },
          isPrivate: shardData.isPrivate ?? false,
          isAnonymous: shardData.isAnonymous ?? false,
          version: shardData.version ?? 1,
          minigoals: minigoals.map((mg: any) => ({
            id: mg._id.toString(),
            title: mg.title,
            description: mg.description,
            progress: mg.progress,
            completed: mg.completed,
            tasks: mg.tasks,
          })),
        },
      };
    },

    // Get shard schedule with tasks grouped by date
    async getShardSchedule(_, { shardId, startDate, endDate }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      try {
        console.log("🔍 [getShardSchedule] Starting with shardId:", shardId);
        
        // Verify user has access to this shard
        const [shardError, shard] = await catchError(
          Shard.findById(shardId).lean()
        );

        console.log("🔍 [getShardSchedule] Shard query result:", { shardError: !!shardError, hasShard: !!shard });

        if (shardError || !shard) {
          console.error("❌ [getShardSchedule] Shard error:", shardError);
          return {
            success: false,
            message: "Quest not found.",
          };
        }

        // Check if user is owner or participant
        const isOwner = shard.owner.toString() === context.id;
        const isParticipant = shard.participants.some(
          (p: any) => p.user.toString() === context.id
        );

        console.log("🔍 [getShardSchedule]  Permission check:", { isOwner, isParticipant });

        if (!isOwner && !isParticipant) {
          return {
            success: false,
            message: "You don't have access to this quest.",
          };
        }

        // Get all mini-goals for this shard
        const [mgError, miniGoals] = await catchError(
          MiniGoal.find({ shardId }).lean()
        );

        console.log("🔍 [getShardSchedule] MiniGoals query result:", { mgError: !!mgError, count: miniGoals?.length });

        if (mgError) {
          logError("getShardSchedule:miniGoals", mgError);
          return {
            success: false,
            message: "Failed to fetch schedule.",
          };
        }

        // Flatten all tasks and group by date
        const tasksByDate: Record<string, any[]> = {};
        const allTasks: any[] = [];

        miniGoals.forEach((mg: any) => {
          mg.tasks.forEach((task: any, taskIndex: number) => {
            if (task.dueDate) {
              // Handle different dueDate formats (Date object, number, or string)
              let dueDateValue: Date;
              if (task.dueDate instanceof Date) {
                dueDateValue = task.dueDate;
              } else if (typeof task.dueDate === 'number') {
                dueDateValue = new Date(task.dueDate);
              } else {
                dueDateValue = new Date(task.dueDate);
              }
              
              // Generate composite ID since tasks don't have _id field (they're subdocuments with _id: false)
              const compositeId = `${mg._id.toString()}-${taskIndex}`;
              
              const taskData = {
                id: compositeId,
                title: task.title,
                dueDate: dueDateValue.getTime().toString(), // Return as timestamp string
                completed: task.completed,
                xpReward: task.xpReward || 20,
                miniGoalId: mg._id.toString(),
                miniGoalTitle: mg.title,
              };

              allTasks.push(taskData);

              // Group by date (YYYY-MM-DD)
              const dateKey = dueDateValue.toISOString().split('T')[0];
              if (!tasksByDate[dateKey]) {
                tasksByDate[dateKey] = [];
              }
              tasksByDate[dateKey].push(taskData);
            }
          });
        });

        // Sort tasks within each date by time
        Object.keys(tasksByDate).forEach(dateKey => {
          tasksByDate[dateKey].sort((a, b) =>
            new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
          );
        });

        // Sort all tasks by due date
        allTasks.sort((a, b) =>
          new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
        );

        return {
          success: true,
          tasksByDate,
          tasks: allTasks,
        };
      } catch (error) {
        console.error("❌ [getShardSchedule] Catch block error:", error);
        console.error("❌ [getShardSchedule] Error stack:", (error as Error).stack);
        logError("getShardSchedule", error);
        return {
          success: false,
          message: "Failed to fetch schedule.",
        };
      }
    },

    // Get user's general schedule across all shards
    async getMySchedule(_, { startDate, endDate }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      try {
        // Get all shards where user is owner or participant
        const [shardError, shards] = await catchError(
          Shard.find({
            $or: [
              { owner: context.id },
              { 'participants.user': context.id }
            ],
            status: 'active'
          }).lean()
        );

        if (shardError) {
          logError("getMySchedule:shards", shardError);
          return {
            success: false,
            message: "Failed to fetch schedule.",
          };
        }

        const shardIds = shards.map((s: any) => s._id);

        // Get all mini-goals for these shards
        const [mgError, miniGoals] = await catchError(
          MiniGoal.find({ shardId: { $in: shardIds } }).lean()
        );

        if (mgError) {
          logError("getMySchedule:miniGoals", mgError);
          return {
            success: false,
            message: "Failed to fetch schedule.",
          };
        }

        // Create a map of shardId to shard for quick lookup
        const shardMap = new Map();
        shards.forEach((s: any) => {
          shardMap.set(s._id.toString(), s);
        });

        // Flatten all tasks and group by date
        const tasksByDate: Record<string, any[]> = {};
        const allTasks: any[] = [];

        miniGoals.forEach((mg: any) => {
          const shard = shardMap.get(mg.shardId.toString());

          mg.tasks.forEach((task: any, taskIndex: number) => {
            if (task.dueDate) {
              // Handle different dueDate formats (Date object, number, or string)
              let dueDateValue: Date;
              if (task.dueDate instanceof Date) {
                dueDateValue = task.dueDate;
              } else if (typeof task.dueDate === 'number') {
                dueDateValue = new Date(task.dueDate);
              } else {
                dueDateValue = new Date(task.dueDate);
              }
              
              // Generate composite ID since tasks don't have _id field (they're subdocuments with _id: false)
              const compositeId = `${mg._id.toString()}-${taskIndex}`;
              
              const taskData = {
                id: compositeId,
                title: task.title,
                dueDate: dueDateValue.getTime().toString(), // Return as timestamp string
                completed: task.completed,
                xpReward: task.xpReward || 20,
                miniGoalId: mg._id.toString(),
                miniGoalTitle: mg.title,
                shardId: mg.shardId.toString(),
                shardTitle: shard?.title || 'Unknown Shard',
              };

              allTasks.push(taskData);

              // Group by date (YYYY-MM-DD)
              const dateKey = dueDateValue.toISOString().split('T')[0];
              if (!tasksByDate[dateKey]) {
                tasksByDate[dateKey] = [];
              }
              tasksByDate[dateKey].push(taskData);
            }
          });
        });

        // Sort tasks within each date by time
        Object.keys(tasksByDate).forEach(dateKey => {
          tasksByDate[dateKey].sort((a, b) =>
            new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
          );
        });

        // Sort all tasks by due date
        allTasks.sort((a, b) =>
          new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
        );

        // Get today's date key
        const today = new Date().toISOString().split('T')[0];
        const todaysTasks = tasksByDate[today] || [];

        return {
          success: true,
          tasksByDate,
          tasks: allTasks,
          todaysTasks,
        };
      } catch (error) {
        logError("getMySchedule", error);
        return {
          success: false,
          message: "Failed to fetch schedule.",
        };
      }
    },
  },
};

