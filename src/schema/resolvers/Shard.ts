import {
  catchError,
  logError,
  SaveAuditTrail,
  ThrowError,
} from "../../Helpers/Helpers.js";
import Shard from "../../models/Shard.js";
import MiniGoal from "../../models/MiniGoal.js";
import Chat, { Message } from "../../models/Chat.js";
import { User } from "../../models/User.js";
import { breakDownGoalWithAI, checkAIUsage, trackAIUsage, enrichManualShard, generateReflectionMission, UserContext } from "../../Helpers/AIHelper.js";
import { moderate } from "../../Helpers/ContentModerator.js";
import SideQuest from "../../models/SideQuest.js";
import { createNotification } from "./Notifications.js";
import { cache, cacheKeys, cacheInvalidate } from "../../Helpers/Cache.js";
import { awardXP, checkAchievements } from "./XP.js";
import { getCloudinarySignedUpload } from "../../Helpers/Cloudinary.js";
import { calculateDueDate, distributeDatesEvenly, smartSchedule, SchedulableTask } from "../../Helpers/DateHelper.js";
import { enqueuePushNotification } from "../../Helpers/Queue.js";

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
    async createShard(_, { goal, deadline, image, participants, isPrivate, isAnonymous, questType, cadence }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      try {
        const [userError, user] = await catchError(
          User.findById(context.id, "role subscriptionTier username bio birthdate timezone level xp currentStreak strength intelligence charisma endurance creativity preferences").lean()
        );

        if (userError) {
          logError("createShard:getUser", userError);
          return { success: false, message: "Failed to verify user." };
        }

        // Check AI credit limit before spending time on validation
        const userTier: "free" | "pro" = (user as any)?.subscriptionTier === 'pro' ? 'pro' : 'free';
        let usageCheck = { canProceed: true, limit: -1, used: 0, remaining: -1 };
        if (user?.role !== 'admin') {
          usageCheck = await checkAIUsage(context.id, userTier);
          if (!usageCheck.canProceed) {
            return {
              success: false,
              message: `You've used all your AI credits. Upgrade to Pro for unlimited quests!`,
              needsUpgrade: true,
            };
          }
        }

        // Validate deadline before spending an AI call
        if (deadline) {
          const deadlineDate = new Date(deadline);
          if (isNaN(deadlineDate.getTime())) {
            return { success: false, message: "Invalid deadline date." };
          }
          if (deadlineDate <= new Date()) {
            return { success: false, message: "Deadline must be in the future." };
          }
        }

        // Moderate goal text before sending to AI
        const goalMod = moderate(goal, 'goal');
        if (!goalMod.allowed) {
          return {
            success: false,
            message: goalMod.crisisMessage || goalMod.reason || 'This goal could not be processed.',
            isCrisis: goalMod.severity === 'crisis',
          };
        }

        // Build user context for AI personalisation
        const u = user as any;
        const userContext: UserContext = {
          username: u?.username || "Adventurer",
          bio: u?.bio,
          age: u?.birthdate ? Math.floor((Date.now() - new Date(u.birthdate).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : undefined,
          timezone: u?.timezone,
          level: u?.level || 1,
          currentStreak: u?.currentStreak || 0,
          stats: {
            strength: u?.strength || 5,
            intelligence: u?.intelligence || 5,
            charisma: u?.charisma || 5,
            endurance: u?.endurance || 5,
            creativity: u?.creativity || 5,
          },
          preferences: {
            workloadLevel: u?.preferences?.workloadLevel || 'medium',
            maxTasksPerDay: u?.preferences?.maxTasksPerDay || 4,
            preferredTaskDuration: u?.preferences?.preferredTaskDuration || 'medium',
          },
        };

        const questBreakdown = await breakDownGoalWithAI(goal, deadline, userContext);

        // Deduct credit only after a successful AI call — prevents losing credits on failures
        if (user?.role !== 'admin') {
          await trackAIUsage(context.id, userTier).catch(() => {});
        }

        const participantIds = participants ? participants.map((p: any) => p.user) : [];
        const totalParticipants = [context.id, ...participantIds];

        // Create shard FIRST — prevents orphaned chats if shard creation fails
        const [shardError, newShard] = await catchError(
          Shard.create({
            title: questBreakdown.mainQuest.title,
            description: questBreakdown.mainQuest.description,
            owner: context.id,
            participants: participants
              ? participants.map((p: any) => ({ user: p.user, role: p.role }))
              : [],
            image,
            timeline: {
              startDate: new Date(),
              endDate: deadline ? new Date(deadline) : undefined,
            },
            progress: { completion: 0, xpEarned: 0, level: 1 },
            status: "active",
            isPrivate: isPrivate || false,
            isAnonymous: isAnonymous || false,
            questType: questType || "standard",
            cadence,
            rewards: [{ type: "xp", value: questBreakdown.mainQuest.xpReward }],
          })
        );

        if (shardError || !newShard) {
          logError("createShard:createShard", shardError);
          return { success: false, message: "Failed to create quest." };
        }

        // Create chat only after shard exists
        if (totalParticipants.length > 1) {
          const [chatError, shardChat] = await catchError(
            Chat.create({
              type: "shard",
              participants: totalParticipants,
              shardId: newShard._id,
              name: questBreakdown.mainQuest.title,
            })
          );
          if (!chatError && shardChat) {
            await Shard.findByIdAndUpdate(newShard._id, { chatId: shardChat._id });
          } else if (chatError) {
            logError("createShard:createChat", chatError);
          }
        }

        const shardStartDate = new Date();
        const shardEndDate = deadline
          ? new Date(deadline)
          : questBreakdown.mainQuest.estimatedDuration
            ? calculateDueDate(shardStartDate, questBreakdown.mainQuest.estimatedDuration)
            : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        const prefs = (user as any)?.preferences || {};

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

        await cacheInvalidate.shardList(context.id);

        SaveAuditTrail({
          userId: context.id,
          task: "Created Shard",
          details: `Created quest: ${newShard.title}`,
        });

        // Notify participants
        if (participants && participants.length > 0) {
          const participantIds = participants.map((p: any) => p.user);
          await enqueuePushNotification(
            participantIds,
            {
              title: "New Quest Invite",
              body: `You've been invited to join the quest: ${newShard.title}`,
              data: { shardId: newShard._id.toString(), screen: "/shard-info" }
            },
            'shardInvites' // Check shard invite preferences
          ).catch(e => logError("PushNotificationError", e));
        }

        console.log("🎉 [createShard] Shard creation complete!");
        console.log("📊 [createShard] Result:", {
          shardId: newShard._id.toString(),
          title: newShard.title,
          aiCallsRemaining: usageCheck.remaining - 1,
        });

        checkAchievements(context.id).catch(() => {});

        const [mgFetchError, createdMiniGoals] = await catchError(
          MiniGoal.find({ shardId: newShard._id }, "title tasks dueDate").lean()
        );

        return {
          success: true,
          message: "Quest created successfully!",
          warning: questBreakdown.warning || null,
          shard: {
            id: newShard._id.toString(),
            title: newShard.title,
            description: newShard.description,
            status: newShard.status,
            progress: newShard.progress,
            aiUsed: true,
            aiCallsRemaining: usageCheck.remaining === -1 ? -1 : usageCheck.remaining - 1,
            miniGoals: (!mgFetchError && createdMiniGoals)
              ? createdMiniGoals.map((mg: any) => ({
                  id: mg._id.toString(),
                  title: mg.title,
                  taskCount: (mg.tasks || []).length,
                  dueDate: mg.dueDate ? new Date(mg.dueDate).toISOString() : null,
                }))
              : [],
          },
        };
      } catch (error) {
        logError("createShard", error);
        return { success: false, message: "Failed to create quest. Please try again." };
      }
    },

    // Create Shard manually (without AI)
    async createShardManual(_, { input }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      try {
        // Create shard immediately with default rewards — enrich with AI in background
        const [shardError, newShard] = await catchError(
          Shard.create({
            title: input.title,
            description: input.description,
            owner: context.id,
            participants: input.participants
              ? input.participants.map((p: any) => ({ user: p.user, role: p.role }))
              : [],
            image: input.image,
            timeline: {
              startDate: input.timeline?.startDate ? new Date(input.timeline.startDate) : new Date(),
              endDate: input.timeline?.endDate ? new Date(input.timeline.endDate) : undefined,
            },
            progress: { completion: 0, xpEarned: 0, level: 1 },
            status: "active",
            isPrivate: input.isPrivate || false,
            isAnonymous: input.isAnonymous || false,
            questType: input.questType || "standard",
            cadence: input.cadence,
            rewards: input.rewards?.length ? input.rewards : [{ type: "xp", value: 200 }],
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
            const goalSchedule = scheduled.filter(s => s.miniGoalIndex === index);
            const miniGoalDueDate = goalSchedule.length > 0
              ? goalSchedule[goalSchedule.length - 1].dueDate
              : shardEndDate;

            const tasks = (mg.tasks || []).map((task: any, taskIndex: number) => {
              const s = goalSchedule.find(g => g.taskIndex === taskIndex);
              return {
                title: task.title,
                dueDate: s?.dueDate || miniGoalDueDate,
                completed: false,
                xpReward: 20,
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

        // Create chat for multi-participant shards
        const manualParticipantIds = input.participants
          ? input.participants.map((p: any) => p.user?.toString() ?? p.userId)
          : [];
        const manualTotalParticipants = [context.id, ...manualParticipantIds];

        if (manualTotalParticipants.length > 1) {
          const [chatError, shardChat] = await catchError(
            Chat.create({
              type: "shard",
              participants: manualTotalParticipants,
              shardId: newShard._id,
              name: `${newShard.title} Chat`,
            })
          );
          if (!chatError && shardChat) {
            await Shard.findByIdAndUpdate(newShard._id, { chatId: shardChat._id });
          } else if (chatError) {
            logError("createShardManual:createChat", chatError);
          }
        }

        // Enrich with AI XP values in the background — doesn't block the response
        if (input.miniGoals?.length > 0) {
          enrichManualShard({
            title: input.title,
            description: input.description || "",
            miniGoals: input.miniGoals,
            deadline: input.timeline?.endDate,
          }).then(async (enrichment) => {
            if (!enrichment) return;
            await Shard.findByIdAndUpdate(newShard._id, {
              rewards: [{ type: "xp", value: enrichment.mainQuestXP }],
            });
          }).catch((e) => logError("createShardManual:enrichBg", e));
        }

        SaveAuditTrail({
          userId: context.id,
          task: "Created Shard Manually",
          details: `Created quest: ${newShard.title}`,
        });

        // Fetch created mini-goals to return as preview
        const [mgFetchErr, createdMGs] = await catchError(
          MiniGoal.find({ shardId: newShard._id }, "title tasks dueDate").lean()
        );

        return {
          success: true,
          message: "Quest created successfully!",
          shard: {
            id: newShard._id.toString(),
            title: newShard.title,
            description: newShard.description,
            status: newShard.status,
            progress: { completion: 0, xpEarned: 0, level: 1 },
            miniGoals: (!mgFetchErr && createdMGs)
              ? createdMGs.map((mg: any) => ({
                  id: mg._id.toString(),
                  title: mg.title,
                  taskCount: (mg.tasks || []).length,
                  dueDate: mg.dueDate ? new Date(mg.dueDate).toISOString() : null,
                }))
              : [],
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

      // Invalidate cache for owner and all participants (including newly added)
      await cacheInvalidate.shard(id);
      const allParticipantIds = updatedShard.participants.map((p: any) => p.user.toString());
      await Promise.all(allParticipantIds.map((uid: string) => cacheInvalidate.shardList(uid)));

      SaveAuditTrail({
        userId: context.id,
        task: "Updated Shard",
        details: `Updated quest: ${updatedShard.title}`,
      });

      // Detect which participants are newly added vs already existing
      const oldParticipantIds = new Set(shard.participants.map((p: any) => p.user.toString()));
      const newlyAddedIds = allParticipantIds.filter((uid: string) => !oldParticipantIds.has(uid) && uid !== context.id);
      const existingIds = allParticipantIds.filter((uid: string) => oldParticipantIds.has(uid) && uid !== context.id);

      const [ownerInfoErr, ownerInfo] = await catchError(User.findById(context.id).select("username").lean());
      const ownerName = (!ownerInfoErr && ownerInfo) ? (ownerInfo as any).username : "Someone";

      // Send "added to quest" to new participants
      if (newlyAddedIds.length > 0) {
        await Promise.all(newlyAddedIds.map((uid: string) => {
          cacheInvalidate.shardList(uid);
          createNotification(uid, `${ownerName} added you to the quest: ${updatedShard.title}`, "shard_invite", { shardId: id });
          return enqueuePushNotification([uid], {
            title: "You've been added to a Quest!",
            body: `${ownerName} added you to "${updatedShard.title}"`,
            data: { shardId: id, screen: "/shard-info" }
          }, 'shardInvites').catch(e => logError("PushNotificationError", e));
        }));
      }

      // Send "quest updated" only to existing participants
      if (existingIds.length > 0) {
        await enqueuePushNotification(
          existingIds,
          {
            title: "Quest Updated",
            body: `${updatedShard.title} has been updated.`,
            data: { shardId: updatedShard._id.toString(), screen: "/shard-info" }
          },
          'shardUpdates'
        ).catch(e => logError("PushNotificationError", e));
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

      // Invalidate shard, chat, and both users' shard lists
      await cacheInvalidate.shard(shardId);
      await cacheInvalidate.shardList(context.id);
      await cacheInvalidate.shardList(userId);
      if (shard.chatId) {
        await cacheInvalidate.chat(shard.chatId.toString());
      }

      SaveAuditTrail({
        userId: context.id,
        task: "Added Shard Participant",
        details: `Added ${(user as any).username} as ${role} to quest: ${shard.title}`,
      });

      // Notify added user with a specific "added" message
      const [ownerErr, owner] = await catchError(User.findById(context.id).select("username").lean());
      const ownerName = (!ownerErr && owner) ? (owner as any).username : "Someone";

      await createNotification(
        userId,
        `${ownerName} added you to the quest: ${shard.title}`,
        "shard_invite",
        { shardId }
      );

      enqueuePushNotification(
        [userId],
        {
          title: "You've been added to a Quest!",
          body: `${ownerName} added you to "${shard.title}"`,
          data: { shardId: shardId, screen: "/shard-info" }
        },
        'shardInvites'
      ).catch(e => logError("QueueDispatchError", e));

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
    async assignMiniGoal(_, { miniGoalId, userId, taskIndex }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Get mini-goal with shard info
      const [minigoalError, minigoal] = await catchError(
        MiniGoal.findById(miniGoalId).populate("shardId").lean()
      );

      if (minigoalError || !minigoal || !minigoal.shardId) {
        return { success: false, message: "Mini-goal not found." };
      }

      const shard: any = minigoal.shardId;

      // Only owner and accountability partners can assign
      const isOwner = shard.owner.toString() === context.id;
      const isAccountabilityPartner = shard.participants.some(
        (p: any) => p.user.toString() === context.id && p.role === "accountability_partner"
      );
      if (!isOwner && !isAccountabilityPartner) {
        return { success: false, message: "Only owners and accountability partners can assign goals." };
      }

      // Verify assignee is a participant or owner
      const isValidAssignee =
        userId === shard.owner.toString() ||
        shard.participants.some((p: any) => p.user.toString() === userId);
      if (!isValidAssignee) {
        return { success: false, message: "User must be a participant or owner to be assigned." };
      }

      // Fetch both users for system message
      const [, assigner] = await catchError(User.findById(context.id, "username").lean());
      const [, assignee] = await catchError(User.findById(userId, "username").lean());
      const assignerName = (assigner as any)?.username || "Someone";
      const assigneeName = (assignee as any)?.username || "a teammate";

      let targetLabel = minigoal.title;

      if (typeof taskIndex === "number") {
        // Task-level assignment
        const [mgFetchErr, mgDoc] = await catchError(MiniGoal.findById(miniGoalId));
        if (mgFetchErr || !mgDoc) return { success: false, message: "Mini-goal not found." };

        if (!mgDoc.tasks[taskIndex]) {
          return { success: false, message: "Task not found at that index." };
        }

        targetLabel = mgDoc.tasks[taskIndex].title;
        mgDoc.tasks[taskIndex].assignedTo = userId;
        await mgDoc.save();
      } else {
        // Mini-goal level assignment
        await MiniGoal.findByIdAndUpdate(miniGoalId, { assignedTo: userId });
      }

      // Inject system message into quest chat (fire-and-forget)
      if (shard.chatId) {
        Message.create({
          chatId: shard.chatId,
          sender: context.id,
          content: `${assignerName} assigned "${targetLabel}" to @${assigneeName}`,
          type: "system",
        }).catch((e: any) => logError("assignMiniGoal:systemMessage", e));
      }

      SaveAuditTrail({
        userId: context.id,
        task: "Assigned Mini-Goal",
        details: `Assigned "${targetLabel}" to ${userId}`,
      });

      // Push notification to assignee
      await enqueuePushNotification(
        [userId],
        {
          title: "New Assignment",
          body: `${assignerName} assigned "${targetLabel}" to you in ${shard.title}`,
          data: { shardId: shard._id.toString(), screen: "/shard-info" }
        },
        'questDeadlines'
      ).catch(e => logError("PushNotificationError", e));

      return { success: true, message: "Assigned successfully." };
    },


    // Complete mini-goal
    async completeHabitCycle(_, { shardId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [shardError, shard] = await catchError(Shard.findById(shardId).lean());
      if (shardError || !shard) ThrowError("Shard not found");

      if (shard.questType !== "habit") {
        ThrowError("This shard is not a recurring habit quest.");
      }

      // Check if user has permission (must be owner or collaborator)
      const isOwner = shard.owner.toString() === context.id;
      const isCollaborator = shard.participants.some(
        (p: any) => p.user.toString() === context.id && p.role === "collaborator"
      );
      if (!isOwner && !isCollaborator) {
        ThrowError("You do not have permission to reset this habit cycle.");
      }

      // Fetch all mini-goals for this shard
      const [mgError, miniGoals] = await catchError(MiniGoal.find({ shardId }).lean());
      if (mgError || !miniGoals) ThrowError("Failed to fetch mini goals");

      // Count total tasks to award XP, and reset completed statuses
      let totalTasksCompleted = 0;

      for (const mg of (miniGoals as any[])) {
        let mgChanged = false;
        
        for (const task of mg.tasks) {
          if (task.completed) {
            totalTasksCompleted++;
            task.completed = false;
            mgChanged = true;
          }
        }
        
        if (mgChanged) {
          await MiniGoal.findByIdAndUpdate(mg._id, {
            tasks: mg.tasks,
            progress: 0,
            completed: false,
          });
        }
      }

      // Increment Habit streak and update progress back to 0
      const newHabitStreak = (shard.habitStreak || 0) + 1;
      
      await Shard.findByIdAndUpdate(shardId, {
        habitStreak: newHabitStreak,
        "progress.completion": 0,
      });

      // Award XP using existing completeTask multiplier rules, if any
      // We process the XP globally for the whole cycle reset
      let xpEarned = totalTasksCompleted * 20;

      // Add simple streak bonus: +5 XP per day in the streak
      xpEarned += (newHabitStreak * 5);
      
      const { awardXP } = await import("./XP.js");
      const xpResult = await awardXP(context.id, xpEarned, `Completed Habit Cycle for ${shard.title}`);

      // Inject system message
      const User = require("../../models/User").User;
      const user = await User.findById(context.id).select("username").lean();
      if (user && shard.chatId) {
        const { Message } = await import("../../models/Chat.js");
        Message.create({
          chatId: shard.chatId,
          sender: context.id,
          content: `${user.username} achieved a ${newHabitStreak}-cycle streak on "${shard.title}" ✨`,
          type: "system",
        }).catch(e => console.error(e));
      }

      // Invalidate caches
      await cacheInvalidate.shard(shardId);
      await cacheInvalidate.shardList(context.id);

      return {
        success: true,
        message: "Habit cycle completed and reset!",
        xpEarned,
        newStreak: newHabitStreak,
      };
    },

    // Manual AI coach nudge trigger
    async triggerCoachNudge(_, { shardId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [shardErr, shard] = await catchError(Shard.findById(shardId).lean());
      if (shardErr || !shard) return { success: false, message: "Shard not found.", nudge: null };

      const isOwner = shard.owner.toString() === context.id;
      if (!isOwner) return { success: false, message: "Only the quest owner can request a nudge.", nudge: null };

      // Rate limit: 1 nudge per 7 days
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      if (shard.lastNudgedAt && new Date(shard.lastNudgedAt) > sevenDaysAgo) {
        const nextDate = new Date(new Date(shard.lastNudgedAt).getTime() + 7 * 24 * 60 * 60 * 1000);
        return { success: false, message: `Next coach tip available on ${nextDate.toLocaleDateString()}.`, nudge: null };
      }

      const { canMakeCoachAICall, incrementCoachAICounter, generateInactivityNudge, COACH_TEMPLATES } = await import("../../Helpers/AIHelper.js");
      const [userErr, user] = await catchError(User.findById(context.id).select("subscriptionTier").lean());
      const isPro = !userErr && (user as any)?.subscriptionTier === "pro";

      const staleDays = shard.lastActivityAt
        ? Math.floor((Date.now() - new Date(shard.lastActivityAt).getTime()) / 86400000)
        : 3;

      let nudge: string;
      if (isPro && canMakeCoachAICall()) {
        nudge = await generateInactivityNudge(shard.title, staleDays);
        incrementCoachAICounter();
      } else {
        nudge = COACH_TEMPLATES.inactivity(shard.title);
      }

      await Shard.findByIdAndUpdate(shardId, { lastNudgedAt: new Date() });

      return { success: true, message: "Coach nudge generated!", nudge };
    },

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
      const isCollaborator = shard.participants.some(
        (p: any) => p.user.toString() === context.id && p.role === "collaborator"
      );

      if (!isOwner && !isCollaborator) {
        return {
          success: false,
          message: "You don't have permission to modify this shard.",
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
      const isCollaborator = shard.participants.some(
        (p: any) => p.user.toString() === context.id && p.role === "collaborator"
      );

      if (!isOwner && !isCollaborator) {
        return {
          success: false,
          message: "You don't have permission to modify this shard.",
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

    async updateMiniGoal(_, { miniGoalId, input }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, miniGoal] = await catchError(
        MiniGoal.findById(miniGoalId).populate("shardId")
      );
      if (error || !miniGoal) return { success: false, message: "Mini-goal not found." };

      const shard: any = miniGoal.shardId;
      const isOwner = shard.owner.toString() === context.id;
      const isCollaborator = shard.participants.some(
        (p: any) => p.user.toString() === context.id && p.role === "collaborator"
      );
      if (!isOwner && !isCollaborator)
        return { success: false, message: "You don't have permission to edit this mini-goal." };

      if (input.title) miniGoal.title = input.title.trim();
      if (input.description !== undefined) miniGoal.description = input.description;
      if (input.dueDate !== undefined)
        (miniGoal as any).dueDate = input.dueDate ? new Date(input.dueDate) : undefined;

      await miniGoal.save();
      await cacheInvalidate.shard(shard._id.toString());

      return { success: true, message: "Mini-goal updated." };
    },

    async deleteMiniGoal(_, { miniGoalId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, miniGoal] = await catchError(
        MiniGoal.findById(miniGoalId).populate("shardId").lean()
      );
      if (error || !miniGoal) return { success: false, message: "Mini-goal not found." };

      const shard: any = miniGoal.shardId;
      if (shard.owner.toString() !== context.id)
        return { success: false, message: "Only the quest owner can delete mini-goals." };

      await MiniGoal.findByIdAndDelete(miniGoalId);
      await cacheInvalidate.shard(shard._id.toString());

      SaveAuditTrail({
        userId: context.id,
        task: "Deleted Mini-Goal",
        details: `Deleted mini-goal: ${miniGoal.title} from quest: ${shard.title}`,
      });

      return { success: true, message: "Mini-goal deleted." };
    },

    async addMiniGoal(_, { shardId, input }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [shardError, shard] = await catchError(Shard.findById(shardId).lean());
      if (shardError || !shard) return { success: false, message: "Quest not found." };

      if (shard.owner.toString() !== context.id)
        return { success: false, message: "Only the quest owner can add mini-goals." };

      const mgMod = moderate(input.title, 'task');
      if (!mgMod.allowed) return { success: false, message: mgMod.crisisMessage || mgMod.reason || 'Content not allowed.' };

      const tasks = (input.tasks || []).map((t: any) => ({
        title: t.title,
        completed: false,
        deleted: false,
        xpReward: 20,
        rescheduled: false,
      }));

      const [createError, newMiniGoal] = await catchError(
        MiniGoal.create({ shardId, title: input.title, description: input.description, tasks, progress: 0, completed: false })
      );
      if (createError) return { success: false, message: "Failed to create mini-goal." };

      await cacheInvalidate.shard(shardId);

      return {
        success: true,
        message: "Mini-goal added.",
        miniGoal: {
          id: newMiniGoal._id.toString(),
          title: newMiniGoal.title,
          description: newMiniGoal.description || null,
          dueDate: (newMiniGoal as any).dueDate?.toISOString() || null,
          tasks: newMiniGoal.tasks
            .filter((t: any) => !t.deleted)
            .map((t: any) => ({ title: t.title, dueDate: t.dueDate?.toISOString() || null, completed: t.completed, assignedTo: t.assignedTo || null })),
        },
      };
    },

    async addTask(_, { miniGoalId, title, dueDate }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, miniGoal] = await catchError(
        MiniGoal.findById(miniGoalId).populate("shardId")
      );
      if (error || !miniGoal) return { success: false, message: "Mini-goal not found." };

      const shard: any = miniGoal.shardId;
      const isOwner = shard.owner.toString() === context.id;
      const isCollaborator = shard.participants.some(
        (p: any) => p.user.toString() === context.id && p.role === "collaborator"
      );
      if (!isOwner && !isCollaborator)
        return { success: false, message: "You don't have permission to add tasks." };

      const addTaskMod = moderate(title, 'task');
      if (!addTaskMod.allowed) return { success: false, message: addTaskMod.crisisMessage || addTaskMod.reason || 'Content not allowed.' };

      (miniGoal.tasks as any).push({
        title: title.trim(),
        dueDate: dueDate ? new Date(dueDate) : undefined,
        completed: false,
        deleted: false,
        xpReward: 20,
        rescheduled: false,
      });

      await miniGoal.save();
      await cacheInvalidate.shard(shard._id.toString());

      return { success: true, message: "Task added." };
    },

    async updateTask(_, { miniGoalId, taskIndex, title, dueDate }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, miniGoal] = await catchError(
        MiniGoal.findById(miniGoalId).populate("shardId")
      );
      if (error || !miniGoal) return { success: false, message: "Mini-goal not found." };

      const shard: any = miniGoal.shardId;
      const isOwner = shard.owner.toString() === context.id;
      const isCollaborator = shard.participants.some(
        (p: any) => p.user.toString() === context.id && p.role === "collaborator"
      );
      if (!isOwner && !isCollaborator)
        return { success: false, message: "You don't have permission to edit tasks." };

      const updateTaskMod = moderate(title, 'task');
      if (!updateTaskMod.allowed) return { success: false, message: updateTaskMod.crisisMessage || updateTaskMod.reason || 'Content not allowed.' };

      const activeTasks = miniGoal.tasks.filter((t: any) => !t.deleted);
      if (taskIndex < 0 || taskIndex >= activeTasks.length)
        return { success: false, message: "Task not found." };

      const task = activeTasks[taskIndex] as any;
      if (title) task.title = title.trim();
      if (dueDate !== undefined) task.dueDate = dueDate ? new Date(dueDate) : undefined;

      await miniGoal.save();
      await cacheInvalidate.shard(shard._id.toString());

      return { success: true, message: "Task updated." };
    },

    async regenerateShard(_, { shardId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [shardError, shard] = await catchError(Shard.findById(shardId).lean());
      if (shardError || !shard) return { success: false, message: "Quest not found." };

      if ((shard as any).owner.toString() !== context.id)
        return { success: false, message: "Only the quest owner can regenerate the plan." };

      const [userError, user] = await catchError(
        User.findById(context.id, "role subscriptionTier username bio level xp currentStreak strength intelligence charisma endurance creativity preferences").lean()
      );
      if (userError || !user) return { success: false, message: "Failed to verify user." };

      const u = user as any;
      let usageCheck = { canProceed: true, limit: -1, used: 0, remaining: -1 };
      if (u?.role !== 'admin') {
        const tier = u?.subscriptionTier || 'free';
        usageCheck = await checkAIUsage(context.id, tier);
        if (!usageCheck.canProceed)
          return { success: false, message: "You've reached your AI limit. Upgrade to Pro for unlimited AI!", needsUpgrade: true };
        await trackAIUsage(context.id, tier);
      }

      const userContext: UserContext = {
        username: u?.username || "Adventurer",
        bio: u?.bio,
        level: u?.level || 1,
        currentStreak: u?.currentStreak || 0,
        stats: {
          strength: u?.strength || 5,
          intelligence: u?.intelligence || 5,
          charisma: u?.charisma || 5,
          endurance: u?.endurance || 5,
          creativity: u?.creativity || 5,
        },
        preferences: {
          workloadLevel: u?.preferences?.workloadLevel || 'medium',
          maxTasksPerDay: u?.preferences?.maxTasksPerDay || 4,
          preferredTaskDuration: u?.preferences?.preferredTaskDuration || 'medium',
        },
      };

      const s = shard as any;
      const goal = s.description ? `${s.title}: ${s.description}` : s.title;
      const deadline = s.timeline?.endDate?.toISOString();

      const questBreakdown = await breakDownGoalWithAI(goal, deadline, userContext);

      await MiniGoal.deleteMany({ shardId, completed: false });

      const newMiniGoals = await Promise.all(
        questBreakdown.miniQuests.map((mq: any) =>
          MiniGoal.create({
            shardId,
            title: mq.title,
            description: mq.description,
            tasks: mq.steps.map((step: any) => ({
              title: step.text,
              completed: false,
              deleted: false,
              xpReward: step.xpReward || 20,
              rescheduled: false,
            })),
            progress: 0,
            completed: false,
          })
        )
      );

      await cacheInvalidate.shard(shardId);
      SaveAuditTrail({ userId: context.id, task: "Regenerated Shard", details: `Regenerated plan for: ${s.title}` });

      return {
        success: true,
        message: "Quest plan regenerated!",
        warning: questBreakdown.warning || null,
        miniGoals: newMiniGoals.map((mg: any) => ({
          id: mg._id.toString(),
          title: mg.title,
          taskCount: mg.tasks.length,
          dueDate: mg.dueDate?.toISOString() || null,
        })),
        aiCallsRemaining: usageCheck.remaining === -1 ? -1 : usageCheck.remaining - 1,
      };
    },
  },

  Query: {
    // Get AI usage for the current user
    async getAIUsage(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");
      const [userError, user] = await catchError(
        User.findById(context.id, "subscriptionTier").lean()
      );
      if (userError || !user) return { success: false, remaining: 0, limit: 0, canProceed: false };
      const tier = (user as any)?.subscriptionTier || 'free';
      const usage = await checkAIUsage(context.id, tier);
      return {
        success: true,
        remaining: usage.remaining,
        limit: usage.limit,
        canProceed: usage.canProceed,
      };
    },

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
          $or: [
            { owner: context.id },
            { "participants.user": context.id },
          ],
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
          .select("title description image status progress timeline participants rewards owner chatId isPrivate isAnonymous version questType cadence habitStreak createdAt updatedAt")
          .populate("owner", "username profilePic")
          .lean()
      );

      if (error || !shardData) {
        return {
          success: false,
          message: "Quest not found",
          shard: null,
        };
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
            profilePic: (shardData.owner as any).profilePic || null,
          },
          isPrivate: shardData.isPrivate ?? false,
          isAnonymous: shardData.isAnonymous ?? false,
          version: shardData.version ?? 1,
          questType: (shardData as any).questType ?? 'standard',
          cadence: (shardData as any).cadence ?? null,
          habitStreak: (shardData as any).habitStreak ?? 0,
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

