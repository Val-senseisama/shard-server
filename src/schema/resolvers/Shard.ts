import {
  catchError,
  logError,
  SaveAuditTrail,
  ThrowError,
} from "../../Helpers/Helpers.js";
import Shard from "../../models/Shard.js";
import MiniGoal from "../../models/MiniGoal.js";
import { logEvent } from "../../Helpers/Telemetry.js";
import Chat, { Message } from "../../models/Chat.js";
import { User } from "../../models/User.js";
import { breakDownGoalWithAI, checkAIUsage, trackAIUsage, enrichManualShard, UserContext, QuestBriefInput } from "../../Helpers/AIHelper.js";
import { proposeIntakeQuestions } from "../../Helpers/Intake.js";
import { tierOf, countActiveShards, upgradeError, FREE_ACTIVE_SHARD_CAP } from "../../Helpers/Entitlements.js";
import { enqueueReflectionMission } from "../../Helpers/CronJobs.js";
import { moderate } from "../../Helpers/ContentModerator.js";
import SideQuest from "../../models/SideQuest.js";
import { cache, cacheKeys, cacheInvalidate } from "../../Helpers/Cache.js";
import { awardXP, checkAchievements } from "./XP.js";
import { getCloudinarySignedUpload } from "../../Helpers/Cloudinary.js";
import { calculateDueDate, distributeDatesEvenly, smartSchedule, SchedulableTask } from "../../Helpers/DateHelper.js";
import { recordActivity } from "../../Helpers/Streak.js";
import { stampFirstMiniGoal } from "../../Helpers/Activation.js";
import { notifyStreakProgress, notify, notifyMany } from "../../Helpers/Notify.js";
import {
  recomputeShardProgress,
  earlyCompletionBonus,
  miniGoalProgress,
  allTasksComplete,
  taskXPValue,
  cadencePeriodKey,
  previousCadencePeriodKey,
  shardCompletionXP,
  MINI_GOAL_COMPLETION_XP,
} from "../../Helpers/Progress.js";

export const DEFAULT_SHARD_IMAGE =
  "https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=800&auto=format&fit=crop&q=80";
import SocialShare from "../../models/SocialShare.js";
import { OPEN_STATUSES } from "../../Helpers/ShardLifecycle.js";

/**
 * Finish a quest and pay out its rewards. Shared by the `completeShard`
 * mutation and by `updateShard(status: 'completed')`, so a completion cannot
 * skip the payout depending on which path the client happens to use.
 *
 * Idempotent: `completionXPAwarded` is the guard, so a double-tap, a retry, or
 * both entry points firing at once can't pay twice.
 */
async function _completeShard(shardId: string, userId: string) {
    if (!userId) ThrowError("Please login to continue.");

    const [shardErr, shard] = await catchError(Shard.findById(shardId).lean());
    if (shardErr || !shard) {
      return { success: false, message: "Quest not found." };
    }

    if (shard.owner.toString() !== userId) {
      return { success: false, message: "Only the quest owner can complete it." };
    }

    // Guard on the payout, not the status. `updateShard` sets status first and
    // then delegates here, so a status-based check reported "already complete"
    // for a quest that had never been paid — silently skipping the reward on
    // exactly the path this helper was extracted to protect.
    // `completionXPAwarded` is the only fact that means "we already paid".
    if ((shard as any).completionXPAwarded != null) {
      return {
        success: true,
        message: "This quest is already complete.",
        xpEarned: 0,
        alreadyComplete: true,
      };
    }

    // Recompute rather than trusting the stored percentage, which a stale
    // write could have left behind.
    const { completion } = await recomputeShardProgress(shardId, { touchActivity: false });

    const endDate = shard.timeline?.endDate ? new Date(shard.timeline.endDate) : null;
    const onTime = !endDate || Date.now() <= endDate.getTime();

    const payout = shardCompletionXP(shard.rewards as any[], { onTime, completion });

    const updated = await Shard.findOneAndUpdate(
      // The guard: only pay if nobody has paid yet.
      { _id: shardId, completionXPAwarded: { $exists: false } },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
          completionXPAwarded: payout.total,
          "progress.completion": completion,
          lastActivityAt: new Date(),
        },
      },
      { new: true }
    );

    if (!updated) {
      // Lost the race — someone else completed it microseconds ago.
      return {
        success: true,
        message: "This quest is already complete.",
        xpEarned: 0,
        alreadyComplete: true,
      };
    }

    const xpResult = await awardXP(userId, payout.total, `Completed quest: ${shard.title}`);

    // Completion is qualifying activity for the streak.
    const streak = await recordActivity(userId);
    if (streak.counted) notifyStreakProgress(userId, streak).catch(() => {});

    // Stamp the trial-ending milestone, once. Finishing a quest is the moment the
    // user has actual proof the product works, which is where the paywall belongs
    // — not on day 7 of a countdown they had no way to evaluate.
    // `$exists: false` makes this first-write-wins, so a second completion can't
    // reset someone's trial.
    const milestone = await User.findOneAndUpdate(
      { _id: userId, firstQuestCompletedAt: { $exists: false } },
      { $set: { firstQuestCompletedAt: new Date() } },
      { new: false }
    ).lean();
    const isFirstEverCompletion = !!milestone;
    if (isFirstEverCompletion) {
      await cacheInvalidate.user(userId);
      logEvent({
        name: "first_quest_completed",
        userId,
        props: {
          daysSinceSignup: Math.round(
            (Date.now() - new Date((milestone as any).createdAt).getTime()) / 86_400_000
          ),
          completion,
        },
      });
    }

    // A share card — the SocialShare model existed but nothing ever wrote one.
    const [shareErr, share] = await catchError(
      SocialShare.create({
        userId: userId,
        shardId,
        type: "shard_completed",
        content: `Finished "${shard.title}" — ${completion}% complete, ${payout.total} XP.`,
        metadata: {
          shardTitle: shard.title,
          completion,
          xpEarned: payout.total,
          onTime,
          daysTaken: Math.max(
            1,
            Math.round(
              (Date.now() - new Date(shard.timeline.startDate).getTime()) / 86_400_000
            )
          ),
        },
      })
    );
    if (shareErr) logError("completeShard:share", shareErr);

    await notify({
      userId: userId,
      kind: "shard_completed",
      title: "🏆 Quest complete",
      body: `"${shard.title}" is done — ${payout.total} XP${onTime ? " including an on-time bonus" : ""}. A reflection mission is waiting.`,
      shardId,
      data: { screen: "/Home", shardId },
      emailData: { shardTitle: shard.title },
    });

    // Tell collaborators too — the point of a shared quest.
    const collaboratorIds = (shard.participants ?? [])
      .map((p: any) => p.user.toString())
      .filter((id: string) => id !== userId);
    if (collaboratorIds.length > 0) {
      notifyMany(collaboratorIds, {
        kind: "shard_update",
        title: "Quest complete",
        body: `"${shard.title}" has been completed.`,
        shardId,
        data: { screen: "/Home", shardId },
        emailData: { shardTitle: shard.title },
      }).catch(() => {});
    }

    enqueueReflectionMission({
      userId: userId,
      shardId,
      shardTitle: shard.title,
      completionRate: completion,
    }).catch((err) => logError("completeShard:reflection", err));

    logEvent({
      name: "shard_completed",
      userId: userId,
      props: { completion, onTime, xpEarned: payout.total },
    });

    SaveAuditTrail({
      userId: userId,
      task: "Completed Quest",
      details: `${shard.title} — ${completion}%, ${payout.total} XP`,
    });

    checkAchievements(userId).catch(() => {});
    await cacheInvalidate.shard(shardId);
    await cacheInvalidate.shardList(userId);

    return {
      success: true,
      message: onTime
        ? `Quest complete! +${payout.total} XP (includes a ${payout.onTimeBonus} XP on-time bonus).`
        : `Quest complete! +${payout.total} XP.`,
      xpEarned: payout.total,
      xpResult,
      completion,
      onTime,
      shareId: share ? (share as any)._id.toString() : null,
      // The client shows the upsell here rather than during onboarding: the user
      // has just proved the product works for them, which is the only honest
      // place to ask for money.
      isFirstCompletion: isFirstEverCompletion,
      alreadyComplete: false,
    };
}

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

/**
 * The `brief` and `rhythm` fields to spread onto a new shard.
 *
 * Two fields rather than one because they answer different questions:
 * `brief.rhythm` is what the user *said* at intake, `shard.rhythm` is what the
 * plan is *built against*. They start equal and diverge the first time anyone
 * reschedules — and a reschedule that fell back to the intake answer would
 * silently revert to a pace the user had already abandoned.
 *
 * Returns `{}` for a skipped or absent interview, so every existing creation
 * path is untouched.
 */
function briefFields(brief?: QuestBriefInput): Record<string, unknown> {
  if (!brief) return {};

  const answered =
    brief.done || brief.why || brief.blockers || brief.rhythm || brief.skipped?.length;
  if (!answered) return {};

  const rhythm =
    brief.rhythm && typeof brief.rhythm.sessionMinutes === "number"
      ? {
          days: (brief.rhythm.days ?? []).filter((d) => d >= 0 && d <= 6),
          sessionMinutes: brief.rhythm.sessionMinutes,
          timeOfDay: brief.rhythm.timeOfDay,
        }
      : undefined;

  return {
    brief: { ...brief, capturedAt: new Date() },
    ...(rhythm ? { rhythm } : {}),
  };
}

export default {
  Mutation: {
    /**
     * Which intake questions to ask for this goal.
     *
     * Deliberately cheap and uncharged: it writes nothing, spends no credit, and
     * never fails in a way the client has to handle — `proposeIntakeQuestions`
     * returns fallback questions rather than throwing. Charging for this would
     * mean a user who abandons the interview has burned one of fifteen monthly
     * credits for nothing, which is the worst possible place to spend one.
     */
    async startQuestIntake(_, { goal, deadline }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // The goal reaches an LLM here, so it gets the same gate as createShard.
      const goalMod = moderate(goal, 'goal');
      if (!goalMod.allowed) {
        return {
          success: false,
          message: goalMod.crisisMessage || goalMod.reason || 'This goal could not be processed.',
          questions: [],
        };
      }

      const questions = await proposeIntakeQuestions(goal, deadline);
      return { success: true, questions };
    },

    // Create a new quest (Shard) with AI breakdown
    async createShard(_, { goal, deadline, image, participants, isPrivate, isAnonymous, questType, cadence, brief }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      try {
        const [userError, user] = await catchError(
          User.findById(context.id, "role subscriptionTier trialStartedAt trialEndsAt firstQuestCompletedAt username bio birthdate timezone level xp currentStreak strength intelligence charisma endurance creativity preferences").lean()
        );

        if (userError) {
          logError("createShard:getUser", userError);
          return { success: false, message: "Failed to verify user." };
        }

        // Free plan: cap active quests (counts active + paused, both create paths).
        // Checked before the AI call so a blocked user never spends a credit.
        const userTier: "free" | "pro" = tierOf(user as any);
        if (userTier === 'free') {
          const activeCount = await countActiveShards(context.id);
          if (activeCount >= FREE_ACTIVE_SHARD_CAP) {
            return upgradeError("Free plan is limited to 3 active quests. Upgrade to Pro for unlimited quests!");
          }
        }

        // Check AI credit limit before spending time on validation
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

        // The brief's free-text answers are the user's own words heading for the
        // same prompt, so they get the same gate. Checked before the AI call so a
        // blocked brief never spends a credit.
        for (const field of [brief?.done, brief?.why, brief?.blockers, brief?.rhythm?.raw]) {
          if (!field) continue;
          const mod = moderate(field, 'goal');
          if (!mod.allowed) {
            return {
              success: false,
              message: mod.crisisMessage || mod.reason || 'That answer could not be processed.',
              isCrisis: mod.severity === 'crisis',
            };
          }
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

        const questBreakdown = await breakDownGoalWithAI(goal, deadline, userContext, brief);

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
            image: image || DEFAULT_SHARD_IMAGE,
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
            ...briefFields(brief),
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
          await notifyMany(participantIds, {
            kind: "shard_invite",
            title: "New Quest Invite",
            body: `You've been invited to join the quest: ${newShard.title}`,
            shardId: newShard._id.toString(),
            data: { screen: "/shard-info" },
            emailData: { shardTitle: newShard.title },
          }).catch((e) => logError("notify:shardInvite", e));
        }

        console.log("🎉 [createShard] Shard creation complete!");
        console.log("📊 [createShard] Result:", {
          shardId: newShard._id.toString(),
          title: newShard.title,
          aiCallsRemaining: usageCheck.remaining - 1,
        });

        checkAchievements(context.id).catch(() => {});

        logEvent({ name: "ai_quest_created", userId: context.id, tier: userTier, props: { mode: "ai" } });

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
        // Free plan: cap active quests. Counts all active+paused Shards so the
        // manual path can't be used to bypass the createShard cap.
        const [capUserErr, capUser] = await catchError(
          User.findById(context.id, "subscriptionTier role trialStartedAt trialEndsAt firstQuestCompletedAt").lean()
        );
        if (!capUserErr && tierOf(capUser as any) === 'free') {
          const activeCount = await countActiveShards(context.id);
          if (activeCount >= FREE_ACTIVE_SHARD_CAP) {
            return upgradeError("Free plan is limited to 3 active quests. Upgrade to Pro for unlimited quests!");
          }
        }

        // Create shard immediately with default rewards — enrich with AI in background
        const [shardError, newShard] = await catchError(
          Shard.create({
            title: input.title,
            description: input.description,
            owner: context.id,
            participants: input.participants
              ? input.participants.map((p: any) => ({ user: p.user, role: p.role }))
              : [],
            image: input.image || DEFAULT_SHARD_IMAGE,
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

        logEvent({ name: "ai_quest_created", userId: context.id, props: { mode: "manual" } });

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
      // 'completed' is NOT written here — `_completeShard` below owns that
      // transition so the status and the payout can never disagree. Writing it
      // here as well would also re-introduce the ordering bug where the status
      // landed first and the payout was then skipped as "already complete".
      if (input.status && input.status !== 'completed') setFields.status = input.status;
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
        newlyAddedIds.forEach((uid: string) => cacheInvalidate.shardList(uid));
        await notifyMany(newlyAddedIds, {
          kind: "shard_invite",
          title: "You've been added to a Quest!",
          body: `${ownerName} added you to "${updatedShard.title}"`,
          shardId: id,
          data: { screen: "/shard-info" },
          emailData: { shardTitle: updatedShard.title, actorName: ownerName },
        }).catch((e) => logError("notify:shardInvite", e));
      }

      // Send "quest updated" only to existing participants
      if (existingIds.length > 0) {
        await notifyMany(existingIds, {
          kind: "shard_update",
          title: "Quest Updated",
          body: `${updatedShard.title} has been updated.`,
          shardId: updatedShard._id.toString(),
          data: { screen: "/shard-info" },
          emailData: { shardTitle: updatedShard.title, message: "Details changed." },
        }).catch((e) => logError("notify:shardUpdate", e));
      }

      // Completing via a status write goes through the same payout path as the
      // `completeShard` mutation. This branch used to fire a reflection mission
      // and a notification and nothing else — no XP, no rewards, no share card —
      // so which entry point the client used decided whether finishing a quest
      // was worth anything.
      if (input.status === 'completed' && shard.status !== 'completed') {
        // `_completeShard` owns the whole transition — status, completedAt, the
        // payout, the share card and the notifications. It is also the only place
        // that checks ownership, so a non-owner's status write is refused here
        // rather than half-applied.
        await _completeShard(id, context.id);
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

      await notify({
        userId,
        kind: "shard_invite",
        title: "You've been added to a Quest!",
        body: `${ownerName} added you to "${shard.title}"`,
        shardId,
        data: { screen: "/shard-info" },
        emailData: { shardTitle: shard.title, actorName: ownerName },
      });

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
        // Task-level assignment. Written with a positional $set rather than
        // mutate-and-save(): saving the whole document rewrites the entire
        // `tasks` array, so an assignment landing at the same time as a
        // completion elsewhere in the mini-goal would silently discard it.
        const [mgFetchErr, mgDoc] = await catchError(
          MiniGoal.findById(miniGoalId).select("tasks").lean()
        );
        if (mgFetchErr || !mgDoc) return { success: false, message: "Mini-goal not found." };

        if (!mgDoc.tasks?.[taskIndex]) {
          return { success: false, message: "Task not found at that index." };
        }

        targetLabel = mgDoc.tasks[taskIndex].title;
        await MiniGoal.updateOne(
          { _id: miniGoalId },
          { $set: { [`tasks.${taskIndex}.assignedTo`]: userId } }
        );
      } else {
        // Mini-goal level assignment
        await MiniGoal.findByIdAndUpdate(miniGoalId, { assignedTo: userId });
      }

      // Post assignment card into quest chat (fire-and-forget)
      if (shard.chatId) {
        Message.create({
          chatId: shard.chatId,
          sender: context.id,
          content: `${assignerName} assigned "${targetLabel}" to @${assigneeName}`,
          type: "minitask_assignment",
          minitaskRef: {
            miniGoalId: miniGoalId,
            taskId: typeof taskIndex === "number" ? `task-${taskIndex}` : miniGoalId,
            miniGoalTitle: minigoal.title,
            taskTitle: typeof taskIndex === "number" ? targetLabel : undefined,
            assignedTo: userId,
          },
          readBy: [context.id],
          readAt: [{ userId: context.id, readAt: new Date() }],
        }).catch((e: any) => logError("assignMiniGoal:message", e));
      }

      SaveAuditTrail({
        userId: context.id,
        task: "Assigned Mini-Goal",
        details: `Assigned "${targetLabel}" to ${userId}`,
      });

      // Push notification to assignee
      await notify({
        userId,
        kind: "task_assigned",
        title: "New Assignment",
        body: `${assignerName} assigned "${targetLabel}" to you in ${shard.title}`,
        shardId: shard._id.toString(),
        data: { screen: "/shard-info" },
        emailData: { shardTitle: shard.title, actorName: assignerName },
      }).catch((e) => logError("notify:taskAssigned", e));

      return { success: true, message: "Assigned successfully." };
    },


    /**
     * Check in on a recurring habit quest for the current cadence period.
     *
     * Rewritten. The previous version:
     *   - called CommonJS `require()` inside this ESM module, which threw a
     *     ReferenceError *after* it had already awarded XP and bumped the
     *     streak — a partial write that reported failure to the client;
     *   - enforced no cadence at all, so it could be called in a loop, each call
     *     doing `habitStreak + 1` and paying `20×tasks + 5×habitStreak`. XP grew
     *     quadratically for anyone who noticed.
     *
     * Now one check-in per cadence period, keyed on the period the USER is in.
     */
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
        ThrowError("You do not have permission to check in on this habit.");
      }

      const [tzErr, tzUser] = await catchError(
        User.findById(context.id).select("timezone username").lean()
      );
      const timezone = !tzErr ? (tzUser as any)?.timezone : undefined;

      // The cadence gate. One check-in per period, in the user's own clock.
      const periodKey = cadencePeriodKey(shard.cadence, timezone);
      if (shard.lastCycleKey === periodKey) {
        return {
          success: false,
          message:
            shard.cadence === "weekly"
              ? "You've already checked in this week."
              : "You've already checked in today.",
          xpEarned: 0,
          newStreak: shard.habitStreak || 0,
        };
      }

      // A missed period breaks the habit streak rather than silently continuing it.
      const continuing =
        !shard.lastCycleKey ||
        shard.lastCycleKey === previousCadencePeriodKey(shard.cadence, timezone);
      const newHabitStreak = continuing ? (shard.habitStreak || 0) + 1 : 1;

      // Fetch all mini-goals for this shard
      const [mgError, miniGoals] = await catchError(MiniGoal.find({ shardId }).lean());
      if (mgError || !miniGoals) ThrowError("Failed to fetch mini goals");

      // XP is the weight of the work actually completed this period, then the
      // tasks reset for the next one.
      let earnedWeight = 0;

      for (const mg of (miniGoals as any[])) {
        let mgChanged = false;

        for (const task of mg.tasks) {
          if (task.completed) {
            earnedWeight += taskXPValue(task);
            task.completed = false;
            task.completedAt = undefined;
            task.xpAwarded = undefined;
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

      // Streak bonus, capped — the old uncapped `5 × habitStreak` was the other
      // half of the farming exploit.
      const streakBonus = Math.min(newHabitStreak, 20) * 5;
      const xpEarned = earnedWeight + streakBonus;

      await Shard.findByIdAndUpdate(shardId, {
        $set: {
          habitStreak: newHabitStreak,
          lastCycleKey: periodKey,
          lastActivityAt: new Date(),
          "progress.completion": 0,
        },
      });

      // A habit check-in is qualifying activity for the daily streak too.
      const streak = await recordActivity(context.id);
      const xpResult = await awardXP(
        context.id,
        xpEarned,
        `Habit check-in for ${shard.title}`
      );
      if (streak.counted) {
        notifyStreakProgress(context.id, streak).catch(() => {});
      }

      // Inject system message. (This is where the ESM `require` crash lived.)
      const username = (tzUser as any)?.username;
      if (username && shard.chatId) {
        Message.create({
          chatId: shard.chatId,
          sender: context.id,
          content: `${username} kept the "${shard.title}" habit going — ${newHabitStreak} in a row ✨`,
          type: "system",
        }).catch((e) => logError("completeHabitCycle:systemMessage", e));
      }

      // Invalidate caches
      await cacheInvalidate.shard(shardId);
      await cacheInvalidate.shardList(context.id);

      return {
        success: true,
        message: continuing
          ? `Checked in — ${newHabitStreak} ${shard.cadence === "weekly" ? "weeks" : "days"} in a row!`
          : "Checked in — starting a fresh run.",
        xpEarned,
        xpResult,
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
      const [userErr, user] = await catchError(User.findById(context.id).select("subscriptionTier role trialStartedAt trialEndsAt firstQuestCompletedAt").lean());
      const isPro = !userErr && tierOf(user as any) === "pro";

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

    /** Finish a quest and pay out its rewards. See `_completeShard`. */
    async completeShard(_, { shardId }, context) {
      if (!context.id) ThrowError("Please login to continue.");
      return _completeShard(shardId, context.id);
    },

    /**
     * Reschedule an overdue task to a new date, or drop it.
     *
     * The explicit half of the decision the nightly sweep now asks for. The old
     * `overdue-task-reschedule` cron made this choice silently for the user every
     * night by rewriting `dueDate` to today, which is why deadlines carried no
     * weight.
     */
    async resolveOverdueTask(_, { miniGoalId, taskIndex, action, newDueDate }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [mgErr, miniGoal] = await catchError(MiniGoal.findById(miniGoalId));
      if (mgErr || !miniGoal) return { success: false, message: "Task not found." };

      const [shardErr, shard] = await catchError(
        Shard.findById(miniGoal.shardId).select("owner participants").lean()
      );
      if (shardErr || !shard) return { success: false, message: "Quest not found." };

      const isOwner = (shard as any).owner.toString() === context.id;
      const isCollaborator = ((shard as any).participants ?? []).some(
        (p: any) => p.user.toString() === context.id && p.role === "collaborator"
      );
      if (!isOwner && !isCollaborator) {
        return { success: false, message: "You don't have permission to change this task." };
      }

      const task = (miniGoal.tasks as any[])[taskIndex];
      if (!task) return { success: false, message: "Invalid task." };

      if (action === "drop") {
        task.deleted = true;
        task.deletedAt = new Date();
        task.deletedBy = context.id;
        task.overdue = false;
      } else {
        const target = newDueDate ? new Date(Number(newDueDate) || newDueDate) : new Date();
        if (Number.isNaN(target.getTime())) {
          return { success: false, message: "Invalid date." };
        }
        if (!task.rescheduled) task.originalDueDate = task.dueDate;
        task.dueDate = target;
        task.rescheduled = true;
        task.overdue = false;
        task.overdueSince = undefined;
      }

      await miniGoal.save();
      await recomputeShardProgress(miniGoal.shardId.toString());
      await cacheInvalidate.shard(miniGoal.shardId.toString());

      return {
        success: true,
        message: action === "drop" ? "Task dropped." : "Task rescheduled.",
      };
    },

    /**
     * Move a whole mini-goal, carrying its open tasks with it.
     *
     * `updateMiniGoal` already accepted a `dueDate`, but it only wrote the field
     * on the mini-goal — and nothing schedules off that field. The schedule, the
     * streak, the backlog and the widget are all built from `task.dueDate`, so
     * "rescheduling" a mini-goal moved a label and left every task where it was.
     *
     * The shift is a **uniform delta**, not a redistribution. A plan's shape is
     * information the user put there — two tasks a day apart mean something that
     * two tasks squeezed to the same afternoon do not — so every open task moves
     * by the same amount and the spacing survives.
     *
     * The anchor is the LAST open task, because that is what a user means by "when
     * this mini-goal is done". Anchoring on the first would make "move it to
     * Friday" start the work on Friday rather than finish it then.
     *
     * Completed tasks never move: they are a record of when work actually
     * happened, and rewriting that would corrupt the streak's history.
     */
    async rescheduleMiniGoal(_, { miniGoalId, newDueDate }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [mgErr, miniGoal] = await catchError(MiniGoal.findById(miniGoalId));
      if (mgErr || !miniGoal) return { success: false, message: "Mini-goal not found." };

      const [shardErr, shard] = await catchError(
        Shard.findById(miniGoal.shardId).select("owner participants").lean()
      );
      if (shardErr || !shard) return { success: false, message: "Quest not found." };

      const isOwner = (shard as any).owner.toString() === context.id;
      const isCollaborator = ((shard as any).participants ?? []).some(
        (p: any) => p.user.toString() === context.id && p.role === "collaborator"
      );
      if (!isOwner && !isCollaborator) {
        return { success: false, message: "You don't have permission to change this mini-goal." };
      }

      const target = new Date(Number(newDueDate) || newDueDate);
      if (Number.isNaN(target.getTime())) {
        return { success: false, message: "Invalid date." };
      }

      const tasks = miniGoal.tasks as any[];
      const movable = tasks.filter((t) => t && !t.completed && !t.deleted && t.dueDate);

      // Nothing to carry — this is just a label change, and the old behaviour is
      // the right one.
      if (movable.length === 0) {
        (miniGoal as any).dueDate = target;
        await miniGoal.save();
        await cacheInvalidate.shard(miniGoal.shardId.toString());
        return { success: true, message: "Mini-goal rescheduled." };
      }

      const anchor = movable.reduce(
        (latest, t) => Math.max(latest, new Date(t.dueDate).getTime()),
        0
      );
      const delta = target.getTime() - anchor;

      // Moving a mini-goal earlier is legitimate, but because the anchor is the
      // last task, a big enough shift drags the earlier ones into the past —
      // where they would land as instantly overdue work the user never actually
      // missed. Refuse with the reason rather than silently clamping them all
      // onto today, which would destroy the spacing this whole mutation exists
      // to preserve.
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const wouldStrand = movable.filter(
        (t) => new Date(t.dueDate).getTime() + delta < startOfToday.getTime()
      ).length;
      if (wouldStrand > 0) {
        return {
          success: false,
          message:
            wouldStrand === 1
              ? "That would put a task in the past. Pick a later date."
              : `That would put ${wouldStrand} tasks in the past. Pick a later date.`,
        };
      }

      for (const task of movable) {
        // Same bookkeeping resolveOverdueTask does for a single task, so
        // RescheduledBadge can still say where a task came from. Only stamped on
        // the first move: `originalDueDate` means "where this started", not
        // "where it was last time".
        if (!task.rescheduled) task.originalDueDate = task.dueDate;
        task.dueDate = new Date(new Date(task.dueDate).getTime() + delta);
        task.rescheduled = true;
        task.overdue = false;
        task.overdueSince = undefined;
      }

      (miniGoal as any).dueDate = target;

      await miniGoal.save();
      await recomputeShardProgress(miniGoal.shardId.toString());
      await cacheInvalidate.shard(miniGoal.shardId.toString());

      return {
        success: true,
        message:
          movable.length === 1
            ? "Mini-goal rescheduled. 1 task moved."
            : `Mini-goal rescheduled. ${movable.length} tasks moved.`,
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

      // Deleting shrinks the denominator: removing the last unticked task has to
      // be able to carry a mini-goal to complete, otherwise it can never finish.
      miniGoal.progress = miniGoalProgress(miniGoal.tasks as any);
      miniGoal.completed = allTasksComplete(miniGoal.tasks as any);

      await miniGoal.save();
      await recomputeShardProgress(shard._id.toString());
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

      // The mirror of deleteTask: bringing an unticked task back has to be able
      // to pull a mini-goal out of `completed`.
      miniGoal.progress = miniGoalProgress(miniGoal.tasks as any);
      miniGoal.completed = allTasksComplete(miniGoal.tasks as any);

      await miniGoal.save();
      await recomputeShardProgress(shard._id.toString());
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
      // Removing a mini-goal changes the shard's weighting, so the rolled-up
      // completion is stale until it is recomputed from what actually remains.
      await recomputeShardProgress(shard._id.toString());
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

      // A new mini-goal adds unfinished weight, so the shard's completion has to
      // come back down rather than keep the figure it had before.
      await recomputeShardProgress(shardId);
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

      // Adding a task changes the denominator, so the stored progress and the
      // `completed` flag are both stale the moment the push lands. Without this,
      // adding a task to a finished mini-goal leaves it sitting at 100% and
      // `completed: true` while carrying an unticked task.
      miniGoal.progress = miniGoalProgress(miniGoal.tasks as any);
      miniGoal.completed = allTasksComplete(miniGoal.tasks as any);

      await miniGoal.save();
      await recomputeShardProgress(shard._id.toString());
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
        User.findById(context.id, "role subscriptionTier trialStartedAt trialEndsAt firstQuestCompletedAt username bio level xp currentStreak strength intelligence charisma endurance creativity preferences").lean()
      );
      if (userError || !user) return { success: false, message: "Failed to verify user." };

      const u = user as any;
      let usageCheck = { canProceed: true, limit: -1, used: 0, remaining: -1 };
      if (u?.role !== 'admin') {
        const tier = tierOf(u);
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
        User.findById(context.id, "subscriptionTier role trialStartedAt trialEndsAt firstQuestCompletedAt").lean()
      );
      if (userError || !user) return { success: false, remaining: 0, limit: 0, canProceed: false };
      const tier = tierOf(user as any);
      const usage = await checkAIUsage(context.id, tier);
      return {
        success: true,
        remaining: usage.remaining,
        limit: usage.limit,
        canProceed: usage.canProceed,
      };
    },

    getSignedUploadUrl: async (_, __, context) => {
      // A signed upload parameter set is a write credential for our Cloudinary
      // account. Handing it out unauthenticated made the account free file
      // hosting for anyone who found the endpoint.
      if (!context.id) ThrowError("Please login to continue.");

      // Scope every upload to the caller's own folder so one user's signature
      // can't be used to write over another's assets.
      const params = getCloudinarySignedUpload(`shard-server/users/${context.id}`);

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
          .select("title description image status progress timeline participants chatId createdAt updatedAt")
          .sort({ createdAt: -1 })
          .lean()
      );

      if (error) {
        logError("myShards", error, { userId: context.id });
        return {
          success: false,
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
          chatId: s.chatId?.toString() || null,
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

      // Only the owner and participants may read a quest. Without this, any
      // authenticated user could read any quest by id — including private ones —
      // along with every mini-goal and task. `owner` is populated above, so the
      // id lives on `owner._id`. Same rule as getShardSchedule.
      const ownerId = (shardData.owner as any)?._id?.toString() ?? shardData.owner?.toString();
      const isOwner = ownerId === context.id;
      const isParticipant = (shardData.participants || []).some(
        (p: any) => p.user?.toString() === context.id
      );

      if (!isOwner && !isParticipant) {
        // Same shape as "not found" so this can't be used to probe which ids exist.
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
            // Soft-deleted tasks are gone from the user's plan. Helpers/Progress
            // already excludes them from the bar and `myShards` filters them, but
            // neither schedule resolver did — so a dropped task kept turning up
            // on Home, in the backlog and on the widget, which made the "drop"
            // action of resolveOverdueTask look like it had done nothing at all.
            //
            // Skipped in place rather than by compacting the array, because
            // `taskIndex` is this loop's index into the ORIGINAL tasks array and
            // that is exactly what completeTask and resolveOverdueTask address a
            // task by. Rebuilding the list would renumber every task after a
            // deleted one and silently target the wrong work.
            if (task.deleted) return;

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
                // Lets the client know whether the undo window is still open.
                completedAt: task.completedAt ? new Date(task.completedAt).getTime().toString() : null,
                xpReward: taskXPValue(task),
                // Marked by the nightly sweep. Sent so the client can style the
                // row and offer reschedule-or-drop, which is the whole point of
                // marking lateness instead of hiding it.
                overdue: !!task.overdue,
                taskIndex,
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
    /**
     * Every task assigned to the caller, across every quest they're in.
     *
     * Assignment already worked end to end — `assignMiniGoal` sets the assignee,
     * posts a card into the quest chat and fires a `task_assigned` push — but the
     * assignee had no way to see the resulting list. A notification you dismiss is
     * the only place the work existed, which makes assignment feel unreliable and
     * is the difference between a collaborator and a spectator.
     *
     * Covers both assignment levels: a task assigned individually, and every task
     * under a mini-goal assigned as a whole.
     */
    async getMyAssignedTasks(_, { includeCompleted }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      try {
        // Only quests the caller still belongs to. Assignment doesn't survive
        // being removed from a quest, and open states only — a stalled quest's
        // tasks are exactly the ones worth surfacing, but a finished one's aren't.
        const [shardError, shards] = await catchError(
          Shard.find({
            $or: [{ owner: context.id }, { "participants.user": context.id }],
            status: { $in: OPEN_STATUSES },
          })
            .select("title")
            .lean()
        );

        if (shardError) {
          logError("getMyAssignedTasks:shards", shardError);
          return { success: false, message: "Failed to fetch assigned tasks.", tasks: [] };
        }

        const shardIds = (shards || []).map((s: any) => s._id);
        if (shardIds.length === 0) {
          return { success: true, tasks: [] };
        }

        const shardMap = new Map(
          (shards || []).map((s: any) => [s._id.toString(), s])
        );

        // NOTE the two different types. `MiniGoal.assignedTo` is an ObjectId while
        // `tasks[].assignedTo` is a String (see models/MiniGoal.ts). Mongoose casts
        // each correctly on its own path, so querying both in one $or is safe —
        // but don't "tidy" this into a single shared value without checking, since
        // a string/ObjectId mismatch is exactly what silently zeroed the
        // achievement stats.
        const [mgError, miniGoals] = await catchError(
          MiniGoal.find({
            shardId: { $in: shardIds },
            $or: [{ "tasks.assignedTo": context.id }, { assignedTo: context.id }],
          }).lean()
        );

        if (mgError) {
          logError("getMyAssignedTasks:miniGoals", mgError);
          return { success: false, message: "Failed to fetch assigned tasks.", tasks: [] };
        }

        const tasks: any[] = [];

        for (const mg of (miniGoals as any[]) || []) {
          const shard = shardMap.get(mg.shardId.toString());
          // A mini-goal assigned as a whole makes every task under it the
          // assignee's, without each one being individually stamped.
          const wholeGoalIsMine = mg.assignedTo?.toString() === context.id;

          (mg.tasks || []).forEach((task: any, taskIndex: number) => {
            if (task.deleted) return;
            if (!includeCompleted && task.completed) return;

            const mine = wholeGoalIsMine || task.assignedTo?.toString() === context.id;
            if (!mine) return;

            tasks.push({
              // Tasks are subdocuments with `_id: false`, so identity is the
              // composite the rest of the schedule API already uses.
              id: `${mg._id.toString()}-${taskIndex}`,
              title: task.title,
              dueDate: task.dueDate ? new Date(task.dueDate).getTime().toString() : null,
              completed: !!task.completed,
              completedAt: task.completedAt
                ? new Date(task.completedAt).getTime().toString()
                : null,
              xpReward: task.xpReward ?? null,
              overdue: !!task.overdue,
              taskIndex,
              miniGoalId: mg._id.toString(),
              miniGoalTitle: mg.title,
              shardId: mg.shardId.toString(),
              shardTitle: shard?.title ?? null,
            });
          });
        }

        // Soonest deadline first; undated work sorts last rather than blocking the
        // top of a list the user is meant to act on.
        tasks.sort((a, b) => {
          if (!a.dueDate && !b.dueDate) return 0;
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return Number(a.dueDate) - Number(b.dueDate);
        });

        return { success: true, tasks };
      } catch (error) {
        logError("getMyAssignedTasks", error, { userId: context.id });
        return { success: false, message: "Failed to fetch assigned tasks.", tasks: [] };
      }
    },

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
            // Every open state, not just 'active'. A shard that the lifecycle
            // sweep marked at_risk or stalled is exactly the one whose tasks the
            // user still needs to see — dropping it from the schedule after five
            // idle days would hide work at the worst possible moment.
            status: { $in: OPEN_STATUSES },
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
            // Soft-deleted tasks are gone from the user's plan. Helpers/Progress
            // already excludes them from the bar and `myShards` filters them, but
            // neither schedule resolver did — so a dropped task kept turning up
            // on Home, in the backlog and on the widget, which made the "drop"
            // action of resolveOverdueTask look like it had done nothing at all.
            //
            // Skipped in place rather than by compacting the array, because
            // `taskIndex` is this loop's index into the ORIGINAL tasks array and
            // that is exactly what completeTask and resolveOverdueTask address a
            // task by. Rebuilding the list would renumber every task after a
            // deleted one and silently target the wrong work.
            if (task.deleted) return;

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
                // Lets the client know whether the undo window is still open.
                completedAt: task.completedAt ? new Date(task.completedAt).getTime().toString() : null,
                xpReward: taskXPValue(task),
                // Marked by the nightly sweep. Sent so the client can style the
                // row and offer reschedule-or-drop, which is the whole point of
                // marking lateness instead of hiding it.
                overdue: !!task.overdue,
                taskIndex,
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

