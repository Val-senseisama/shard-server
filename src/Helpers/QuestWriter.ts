/**
 * The one place a generated plan becomes a real quest.
 *
 * Both creation paths land here — the legacy `createShard` (generate and write
 * in one shot) and `commitQuestDraft` (write a draft the user has already
 * reviewed and edited). Two implementations of "turn a plan into a Shard plus
 * MiniGoals plus a chat plus invites" would drift within a release, and the
 * scheduling logic in particular is not something to have two of.
 */

import Shard from "../models/Shard.js";
import MiniGoal from "../models/MiniGoal.js";
import Chat from "../models/Chat.js";
import { catchError, logError, SaveAuditTrail } from "./Helpers.js";
import { cacheInvalidate } from "./Cache.js";
import { notifyMany } from "./Notify.js";
import { calculateDueDate, smartSchedule, SchedulableTask } from "./DateHelper.js";
import type { DraftPlan } from "../models/QuestDraft.js";
import type { QuestBriefInput } from "./AIHelper.js";

/**
 * Kept identical to the value the resolver has used since before this helper
 * existed — a different default here would silently change the artwork on every
 * quest created through the draft path.
 */
export const DEFAULT_SHARD_IMAGE =
  "https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=800&auto=format&fit=crop&q=80";

export interface WriteQuestInput {
  userId: string;
  /** Already-projected user doc — `preferences` is what scheduling needs. */
  user: any;
  plan: DraftPlan;
  deadline?: string | Date | null;
  image?: string | null;
  participants?: { user: string; role: string }[] | null;
  isPrivate?: boolean;
  isAnonymous?: boolean;
  questType?: string;
  cadence?: string;
  brief?: QuestBriefInput;
  rhythm?: { days: number[]; sessionMinutes: number; timeOfDay?: string };
}

export interface WriteQuestResult {
  shardId: string;
  title: string;
  shard: any;
}

/**
 * `brief` and `rhythm` as they're stored on a Shard.
 *
 * Two fields rather than one because they answer different questions:
 * `brief.rhythm` is what the user *said* at intake, `shard.rhythm` is what the
 * plan is *built against*. They start equal and diverge the first time anyone
 * reschedules — and a reschedule falling back to the intake answer would
 * silently revert to a pace the user had already abandoned.
 */
export function briefFields(
  brief?: QuestBriefInput,
  rhythmOverride?: WriteQuestInput["rhythm"]
): Record<string, unknown> {
  const answered =
    brief &&
    (brief.done || brief.why || brief.blockers || brief.rhythm || brief.skipped?.length ||
      brief.wantsSuggestions);
  if (!answered && !rhythmOverride) return {};

  const source = rhythmOverride ?? brief?.rhythm;
  const rhythm =
    source && typeof source.sessionMinutes === "number"
      ? {
          days: (source.days ?? []).filter((d: number) => d >= 0 && d <= 6),
          sessionMinutes: source.sessionMinutes,
          timeOfDay: source.timeOfDay,
        }
      : undefined;

  return {
    ...(answered ? { brief: { ...brief, capturedAt: new Date() } } : {}),
    ...(rhythm ? { rhythm } : {}),
  };
}

/**
 * Write a plan out as a real quest.
 *
 * Order matters: the Shard is created first so a failed chat can't orphan one,
 * and mini-goals come last so a partial write leaves a quest with no tasks
 * rather than tasks with no quest.
 */
export async function writeQuest(input: WriteQuestInput): Promise<WriteQuestResult | null> {
  const { userId, user, plan, deadline, image, participants } = input;

  const participantIds = participants ? participants.map((p) => p.user) : [];
  const totalParticipants = [userId, ...participantIds];

  const [shardError, newShard] = await catchError(
    Shard.create({
      title: plan.mainQuest.title,
      description: plan.mainQuest.description,
      owner: userId,
      participants: participants
        ? participants.map((p) => ({ user: p.user, role: p.role }))
        : [],
      image: image || DEFAULT_SHARD_IMAGE,
      timeline: {
        startDate: new Date(),
        endDate: deadline ? new Date(deadline) : undefined,
      },
      progress: { completion: 0, xpEarned: 0, level: 1 },
      status: "active",
      isPrivate: input.isPrivate || false,
      isAnonymous: input.isAnonymous || false,
      questType: input.questType || "standard",
      cadence: input.cadence,
      rewards: [{ type: "xp", value: plan.mainQuest.xpReward }],
      ...briefFields(input.brief, input.rhythm),
    })
  );

  if (shardError || !newShard) {
    logError("writeQuest:createShard", shardError);
    return null;
  }

  // Chat only after the shard exists, and only when there's someone to talk to.
  if (totalParticipants.length > 1) {
    const [chatError, shardChat] = await catchError(
      Chat.create({
        type: "shard",
        participants: totalParticipants,
        shardId: newShard._id,
        name: plan.mainQuest.title,
      })
    );
    if (!chatError && shardChat) {
      await Shard.findByIdAndUpdate(newShard._id, { chatId: shardChat._id });
    } else if (chatError) {
      logError("writeQuest:createChat", chatError);
    }
  }

  const startDate = new Date();
  const endDate = deadline
    ? new Date(deadline)
    : plan.mainQuest.estimatedDuration
      ? calculateDueDate(startDate, plan.mainQuest.estimatedDuration)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const prefs = user?.preferences || {};

  const tasksByGoal: SchedulableTask[][] = plan.miniQuests.map((mq, goalIdx) =>
    mq.steps.map((step, taskIdx) => ({
      miniGoalIndex: goalIdx,
      taskIndex: taskIdx,
      title: step.text,
    }))
  );

  const scheduled = smartSchedule(
    tasksByGoal,
    startDate,
    {
      // A rhythm the user set beats the stored preference — it's the pace they
      // just told us this specific quest runs at.
      workingDays: input.rhythm?.days?.length
        ? input.rhythm.days
        : prefs.workingDays || [1, 2, 3, 4, 5],
      maxTasksPerDay: prefs.maxTasksPerDay || 4,
      preferredTaskDuration: prefs.preferredTaskDuration || "medium",
    },
    endDate
  );

  await Promise.all(
    plan.miniQuests.map(async (mq, index) => {
      const goalSchedule = scheduled.filter((s) => s.miniGoalIndex === index);

      // A hand-set date wins over the scheduler: the user picked it while
      // looking at the plan, which beats anything inferred from preferences.
      const handSet = mq.dueDate ? new Date(mq.dueDate) : null;
      const miniGoalDueDate =
        handSet ??
        (goalSchedule.length > 0 ? goalSchedule[goalSchedule.length - 1].dueDate : endDate);

      const tasks = mq.steps.map((step, stepIndex) => {
        const s = goalSchedule.find((g) => g.taskIndex === stepIndex);
        const scheduledDate = s?.dueDate || endDate;
        return {
          title: step.text,
          // Tasks can't outlive the phase they belong to — pulling a phase
          // earlier has to pull its overdue-by-definition tasks with it.
          dueDate:
            handSet && scheduledDate > handSet ? handSet : scheduledDate,
          completed: false,
          xpReward: step.xpReward || 20,
        };
      });

      return MiniGoal.create({
        shardId: newShard._id,
        title: mq.title,
        description: mq.description,
        dueDate: miniGoalDueDate,
        progress: 0,
        completed: false,
        tasks,
      });
    })
  );

  await cacheInvalidate.shardList(userId);

  SaveAuditTrail({
    userId,
    task: "Created Shard",
    details: `Created quest: ${newShard.title}`,
  });

  if (participants && participants.length > 0) {
    notifyMany(participantIds, {
      kind: "shard_invite",
      title: "New Quest Invite",
      body: `You've been invited to join the quest: ${newShard.title}`,
      shardId: newShard._id.toString(),
      data: { screen: "/shard-info" },
      emailData: { shardTitle: newShard.title },
    }).catch((e) => logError("notify:shardInvite", e));
  }

  return { shardId: newShard._id.toString(), title: newShard.title, shard: newShard };
}
