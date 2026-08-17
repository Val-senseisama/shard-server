import { randomUUID } from "crypto";
import QuestDraft, { type DraftPlan } from "../../models/QuestDraft.js";
import { User } from "../../models/User.js";
import Shard from "../../models/Shard.js";
import { cacheInvalidate } from "../../Helpers/Cache.js";
import { catchError, logError, ThrowError } from "../../Helpers/Helpers.js";
import { moderate } from "../../Helpers/ContentModerator.js";
import {
  breakDownGoalWithAI,
  checkAIUsage,
  trackAIUsage,
  type UserContext,
  type QuestBriefInput,
} from "../../Helpers/AIHelper.js";
import {
  tierOf,
  countActiveShards,
  upgradeError,
  FREE_ACTIVE_SHARD_CAP,
} from "../../Helpers/Entitlements.js";
import { writeQuest } from "../../Helpers/QuestWriter.js";
import { refinePlan, MAX_REFINEMENTS } from "../../Helpers/Refine.js";
import { streamChatCompletion } from "../../Helpers/PlanStream.js";
import { buildQuestUserPrompt, QUEST_ARCHITECT_PROMPT } from "../../Helpers/AIHelper.js";
import { HEAVY_MODEL } from "../../config/models.js";
import { getSocketIO } from "./Chat.js";
import { emitToUser } from "../../server/WebSocketServer.js";
import { logEvent } from "../../Helpers/Telemetry.js";
import { checkAchievements } from "./XP.js";

/** Everything `tierOf` needs plus what personalisation and scheduling read. */
const USER_PROJECTION =
  "role subscriptionTier trialStartedAt trialEndsAt firstQuestCompletedAt " +
  "username bio birthdate timezone level xp currentStreak strength intelligence " +
  "charisma endurance creativity preferences";

/**
 * Give every mini-quest and step a stable id.
 *
 * The model returns positional data with no identity, but the client needs to
 * address "this step" to rename or delete it — and array position is exactly
 * what changes when you reorder. Assigned once, at generation, so an id survives
 * every later edit.
 */
function normalisePlan(breakdown: any): DraftPlan {
  return {
    mainQuest: {
      title: breakdown?.mainQuest?.title ?? "Untitled quest",
      description: breakdown?.mainQuest?.description,
      estimatedDuration: breakdown?.mainQuest?.estimatedDuration,
      xpReward: breakdown?.mainQuest?.xpReward ?? 200,
    },
    miniQuests: (breakdown?.miniQuests ?? []).map((mq: any) => ({
      id: randomUUID(),
      title: mq?.title ?? "Untitled phase",
      description: mq?.description,
      estimatedDuration: mq?.estimatedDuration,
      xpReward: mq?.xpReward ?? 100,
      searchHint: mq?.searchHint,
      steps: (mq?.steps ?? []).map((s: any) => ({
        id: randomUUID(),
        text: s?.text ?? "",
        estimatedDuration: s?.estimatedDuration,
        xpReward: s?.xpReward ?? 20,
      })),
    })),
    warning: breakdown?.warning ?? null,
  };
}

function buildUserContext(u: any): UserContext {
  return {
    username: u?.username || "Adventurer",
    bio: u?.bio,
    age: u?.birthdate
      ? Math.floor((Date.now() - new Date(u.birthdate).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
      : undefined,
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
      workloadLevel: u?.preferences?.workloadLevel || "medium",
      maxTasksPerDay: u?.preferences?.maxTasksPerDay || 4,
      preferredTaskDuration: u?.preferences?.preferredTaskDuration || "medium",
    },
  };
}

/** Moderate the goal plus every free-text answer the user typed. */
function moderateInputs(goal: string, brief?: QuestBriefInput) {
  for (const text of [goal, brief?.done, brief?.why, brief?.blockers, brief?.aids, brief?.rhythm?.raw]) {
    // Callers with no goal to check (a brief-only edit) pass "".

    if (!text) continue;
    const mod = moderate(text, "goal");
    if (!mod.allowed) return mod;
  }
  return null;
}

export default {
  Mutation: {
    /**
     * Generate a plan into a draft. Writes NO Shard.
     *
     * This is the whole point of the draft: the user sees the plan, edits it,
     * and only then does anything become real. The previous flow created the
     * Shard before review, which is why "regenerate" abandoned quests that still
     * counted against the free cap.
     */
    async startQuestDraft(_: any, { goal, deadline, brief, image, participants, questType, cadence, isPrivate, isAnonymous }: any, context: any) {
      if (!context.id) ThrowError("Please login to continue.");

      const [userError, user] = await catchError(
        User.findById(context.id, USER_PROJECTION).lean()
      );
      if (userError || !user) {
        logError("startQuestDraft:getUser", userError);
        return { success: false, message: "Failed to verify user." };
      }

      const userTier: "free" | "pro" = tierOf(user as any);

      // The cap is enforced again at commit, where it belongs — but checking it
      // here too avoids spending a credit on a plan the user can't keep.
      if (userTier === "free") {
        const activeCount = await countActiveShards(context.id);
        if (activeCount >= FREE_ACTIVE_SHARD_CAP) {
          return upgradeError(
            `Free plan is limited to ${FREE_ACTIVE_SHARD_CAP} active quests. Upgrade to Pro for unlimited quests!`
          );
        }
      }

      if ((user as any)?.role !== "admin") {
        const usage = await checkAIUsage(context.id, userTier);
        if (!usage.canProceed) {
          return {
            success: false,
            message: "You've used all your AI credits. Upgrade to Pro for unlimited quests!",
            needsUpgrade: true,
          };
        }
      }

      if (deadline) {
        const d = new Date(deadline);
        if (isNaN(d.getTime())) return { success: false, message: "Invalid deadline date." };
        if (d <= new Date()) return { success: false, message: "Deadline must be in the future." };
      }

      const blocked = moderateInputs(goal, brief);
      if (blocked) {
        return {
          success: false,
          message: blocked.crisisMessage || blocked.reason || "This goal could not be processed.",
          isCrisis: blocked.severity === "crisis",
        };
      }

      // Try streaming first so the plan appears phase by phase instead of behind
      // a spinner. Phases go out over the socket the user is already connected
      // to. If anything about streaming fails we fall back to the ordinary call,
      // which carries the full provider failover chain — streaming is a nicety,
      // availability is not.
      let plan: DraftPlan | null = null;
      const io = getSocketIO();

      const streamed = await streamChatCompletion({
        model: HEAVY_MODEL,
        temperature: 0.7,
        max_completion_tokens: 4096,
        messages: [
          { role: "system", content: QUEST_ARCHITECT_PROMPT },
          { role: "user", content: buildQuestUserPrompt(goal, deadline, buildUserContext(user), brief) },
        ],
        onPhase: (phase, index) => {
          if (io) emitToUser(io, context.id, "quest:draft:phase", { ...phase, index });
        },
      });

      if (streamed) {
        try {
          const match = streamed.match(/\{[\s\S]*\}/);
          if (match) plan = normalisePlan(JSON.parse(match[0]));
        } catch {
          // A truncated stream is a failed stream — fall through and redo it
          // properly rather than saving half a plan.
          plan = null;
        }
      }

      if (!plan) {
        try {
          const breakdown = await breakDownGoalWithAI(
            goal,
            deadline,
            buildUserContext(user),
            brief
          );
          plan = normalisePlan(breakdown);
        } catch (error) {
          logError("startQuestDraft:generate", error);
          return { success: false, message: "Couldn't build a plan just now. Please try again." };
        }
      }

      // Charged once the AI actually produced something — same rule the legacy
      // path uses. Editing and committing the draft cost nothing further.
      if ((user as any)?.role !== "admin") {
        await trackAIUsage(context.id, userTier).catch(() => {});
      }

      const [draftError, draft] = await catchError(
        QuestDraft.create({
          userId: context.id,
          goal,
          deadline: deadline ? new Date(deadline) : undefined,
          image,
          brief: brief ? { ...brief, capturedAt: new Date() } : undefined,
          rhythm: brief?.rhythm,
          questType,
          cadence,
          isPrivate,
          isAnonymous,
          participants: participants?.map((p: any) => ({ user: p.user, role: p.role })),
          plan,
          generated: true,
        })
      );

      if (draftError || !draft) {
        logError("startQuestDraft:createDraft", draftError);
        return { success: false, message: "Failed to save your plan." };
      }

      const answered = brief
        ? ["done", "why", "aids", "blockers", "rhythm"].filter((k) => !!(brief as any)[k])
        : [];
      logEvent({
        name: "quest_draft_created",
        userId: context.id,
        tier: userTier,
        props: {
          answered: answered.join(","),
          answeredCount: answered.length,
          skipped: (brief?.skipped ?? []).join(","),
          wantsSuggestions: !!brief?.wantsSuggestions,
          phases: plan.miniQuests.length,
          streamed: !!streamed,
        },
      });

      return {
        success: true,
        message: "Draft ready.",
        draft: serialiseDraft(draft),
      };
    },

    /**
     * Direct manipulation of a draft. No model call, no credit, no quest.
     *
     * Every op is addressed by id rather than array index, because index is
     * exactly what changes when you reorder — an index-addressed edit racing a
     * reorder edits the wrong thing.
     */
    async editQuestDraft(_: any, { draftId, edit }: any, context: any) {
      if (!context.id) ThrowError("Please login to continue.");

      const [findError, draft] = await catchError(QuestDraft.findById(draftId));
      if (findError || !draft) {
        return { success: false, message: "That plan has expired. Please start again." };
      }
      if (draft.userId.toString() !== context.id) {
        return { success: false, message: "That plan isn't yours." };
      }
      if (draft.committedShardId) {
        return { success: false, message: "This quest has already started." };
      }
      if (!draft.plan) return { success: false, message: "Nothing to edit yet." };

      // User-authored text reaches the architect prompt on any later refine, so
      // it gets the same gate as the goal did.
      if (edit.value) {
        const mod = moderate(edit.value, "goal");
        if (!mod.allowed) {
          return { success: false, message: mod.reason || "That text can't be used." };
        }
      }

      const plan = draft.plan as DraftPlan;
      const phases = plan.miniQuests;
      const phase = edit.phaseId ? phases.find((p) => p.id === edit.phaseId) : undefined;

      switch (edit.op) {
        case "renameQuest":
          if (!edit.value?.trim()) return { success: false, message: "Give it a title." };
          plan.mainQuest.title = edit.value.trim();
          break;

        case "renamePhase":
          if (!phase) return { success: false, message: "That phase is gone." };
          if (!edit.value?.trim()) return { success: false, message: "Give it a title." };
          phase.title = edit.value.trim();
          // Flagged so a later refinement reproduces it verbatim.
          phase.edited = true;
          break;

        case "removePhase": {
          const i = phases.findIndex((p) => p.id === edit.phaseId);
          if (i === -1) return { success: false, message: "That phase is gone." };
          phases.splice(i, 1);
          break;
        }

        case "reorderPhase": {
          const from = phases.findIndex((p) => p.id === edit.phaseId);
          if (from === -1) return { success: false, message: "That phase is gone." };
          const to = Math.max(0, Math.min(edit.toIndex ?? from, phases.length - 1));
          const [moved] = phases.splice(from, 1);
          phases.splice(to, 0, moved);
          break;
        }

        case "setDeadline": {
          // The draft's own deadline, not a phase's. Commit reads this, so
          // without it the "Move the date" fix would change nothing that ships.
          if (!edit.dueDate) {
            draft.deadline = undefined;
          } else {
            const when = new Date(Number(edit.dueDate) || edit.dueDate);
            if (isNaN(when.getTime())) {
              return { success: false, message: "That date isn't valid." };
            }
            if (when <= new Date()) {
              return { success: false, message: "Pick a date in the future." };
            }
            draft.deadline = when;
          }
          break;
        }

        case "redatePhase": {
          if (!phase) return { success: false, message: "That phase is gone." };
          const when = new Date(edit.dueDate);
          if (isNaN(when.getTime())) return { success: false, message: "That date isn't valid." };
          phase.dueDate = when;
          break;
        }

        case "editTask": {
          if (!phase) return { success: false, message: "That phase is gone." };
          const step = phase.steps.find((t) => t.id === edit.taskId);
          if (!step) return { success: false, message: "That task is gone." };
          if (!edit.value?.trim()) return { success: false, message: "Give it a description." };
          step.text = edit.value.trim();
          step.edited = true;
          break;
        }

        case "addTask": {
          if (!phase) return { success: false, message: "That phase is gone." };
          if (!edit.value?.trim()) return { success: false, message: "Give it a description." };
          phase.steps.push({ id: randomUUID(), text: edit.value.trim(), xpReward: 20, edited: true });
          break;
        }

        case "removeTask": {
          if (!phase) return { success: false, message: "That phase is gone." };
          const i = phase.steps.findIndex((t) => t.id === edit.taskId);
          if (i === -1) return { success: false, message: "That task is gone." };
          phase.steps.splice(i, 1);
          break;
        }

        default:
          return { success: false, message: "Unknown edit." };
      }

      // `plan` is Mixed-adjacent, so Mongoose can't see in-place mutation.
      draft.markModified("plan");
      const [saveError] = await catchError(draft.save());
      if (saveError) {
        logError("editQuestDraft:save", saveError);
        return { success: false, message: "Couldn't save that change." };
      }

      logEvent({ name: "quest_draft_edited", userId: context.id, props: { op: edit.op } });

      return { success: true, draft: serialiseDraft(draft) };
    },

    /**
     * Change the plan by describing what's wrong with it.
     *
     * Capped at MAX_REFINEMENTS per draft, and free within the credit already
     * spent on generation. Billing per refinement would teach people not to say
     * "that's too much" — and that sentence is exactly what turns a generic plan
     * into one they'll actually start.
     */
    async refineQuestDraft(_: any, { draftId, instruction }: any, context: any) {
      if (!context.id) ThrowError("Please login to continue.");

      const [findError, draft] = await catchError(QuestDraft.findById(draftId));
      if (findError || !draft) {
        return { success: false, message: "That plan has expired. Please start again.", changes: [] };
      }
      if (draft.userId.toString() !== context.id) {
        return { success: false, message: "That plan isn't yours.", changes: [] };
      }
      if (draft.committedShardId) {
        return { success: false, message: "This quest has already started.", changes: [] };
      }
      if (!draft.plan) return { success: false, message: "Nothing to refine yet.", changes: [] };

      if (draft.refinementsUsed >= MAX_REFINEMENTS) {
        return {
          success: false,
          message: "Start the quest and keep tuning it from the coach.",
          changes: [],
          refinementsRemaining: 0,
        };
      }

      const text = (instruction ?? "").trim();
      if (!text) return { success: false, message: "Tell me what to change.", changes: [] };

      const mod = moderate(text, "goal");
      if (!mod.allowed) {
        return {
          success: false,
          message: mod.crisisMessage || mod.reason || "That can't be used.",
          changes: [],
        };
      }

      const before = JSON.parse(JSON.stringify(draft.plan)) as DraftPlan;
      const result = await refinePlan(before, text, draft.goal);

      if (!result) {
        // The plan is untouched — a half-applied refinement is worse than none.
        return {
          success: false,
          message: "Couldn't apply that change. Try saying it differently?",
          changes: [],
          refinementsRemaining: MAX_REFINEMENTS - draft.refinementsUsed,
        };
      }

      draft.previousPlan = before;
      draft.plan = result.plan;
      draft.refinements.push({ text, at: new Date() });
      draft.refinementsUsed += 1;
      draft.markModified("plan");
      draft.markModified("previousPlan");

      const [saveError] = await catchError(draft.save());
      if (saveError) {
        logError("refineQuestDraft:save", saveError);
        return { success: false, message: "Couldn't save that change.", changes: [] };
      }

      logEvent({
        name: "quest_draft_refined",
        userId: context.id,
        props: { attempt: draft.refinementsUsed, changes: result.changes.length },
      });

      return {
        success: true,
        draft: serialiseDraft(draft),
        changes: result.changes,
        refinementsRemaining: MAX_REFINEMENTS - draft.refinementsUsed,
      };
    },

    /**
     * Put the plan back the way it was before the last refinement.
     *
     * One level deep. A refinement that made things worse is obvious
     * immediately, so a full history would be storage for a case nobody hits.
     * The refinement still counts against the cap — the model call happened.
     */
    async undoQuestDraft(_: any, { draftId }: any, context: any) {
      if (!context.id) ThrowError("Please login to continue.");

      const [findError, draft] = await catchError(QuestDraft.findById(draftId));
      if (findError || !draft) {
        return { success: false, message: "That plan has expired. Please start again." };
      }
      if (draft.userId.toString() !== context.id) {
        return { success: false, message: "That plan isn't yours." };
      }
      if (!draft.previousPlan) {
        return { success: false, message: "Nothing to undo." };
      }

      draft.plan = draft.previousPlan;
      draft.previousPlan = undefined;
      draft.refinements.pop();
      draft.markModified("plan");
      draft.markModified("previousPlan");
      await draft.save().catch(() => {});

      return { success: true, draft: serialiseDraft(draft) };
    },

    /**
     * Correct the brief on a quest that already exists.
     *
     * Deliberately does NOT regenerate. "Actually what I meant was…" should
     * improve every future coach reply, reflection and nudge immediately —
     * silently rewriting a plan the user has already started work against would
     * be a much bigger, unasked-for action.
     */
    async updateShardBrief(_: any, { shardId, brief }: any, context: any) {
      if (!context.id) ThrowError("Please login to continue.");

      const [findError, shard] = await catchError(Shard.findById(shardId).select("owner brief"));
      if (findError || !shard) return { success: false, message: "Quest not found." };
      if (shard.owner.toString() !== context.id) {
        return { success: false, message: "Only the quest owner can change this." };
      }

      const blocked = moderateInputs("", brief);
      if (blocked) {
        return {
          success: false,
          message: blocked.crisisMessage || blocked.reason || "That can't be used.",
        };
      }

      (shard as any).brief = {
        ...(shard as any).brief,
        ...brief,
        capturedAt: (shard as any).brief?.capturedAt ?? new Date(),
      };

      const [saveError] = await catchError(shard.save());
      if (saveError) {
        logError("updateShardBrief:save", saveError);
        return { success: false, message: "Couldn't save that." };
      }

      // The shard is cached; a stale brief here would defeat the point.
      await cacheInvalidate.shard(shardId).catch(() => {});
      await cacheInvalidate.shardList(context.id).catch(() => {});

      return { success: true, message: "Saved." };
    },

    /**
     * Turn a reviewed draft into a real quest.
     *
     * Idempotent: a draft already committed returns its existing shard rather
     * than creating a second one, so a double-tap on a slow connection can't
     * produce two quests.
     */
    async commitQuestDraft(_: any, { draftId }: any, context: any) {
      if (!context.id) ThrowError("Please login to continue.");

      const [draftError, draft] = await catchError(QuestDraft.findById(draftId));
      if (draftError || !draft) {
        return { success: false, message: "That plan has expired. Please start again." };
      }
      if (draft.userId.toString() !== context.id) {
        return { success: false, message: "That plan isn't yours." };
      }
      if (draft.committedShardId) {
        return {
          success: true,
          message: "Quest created successfully!",
          shard: { id: draft.committedShardId.toString(), title: draft.plan?.mainQuest.title },
        };
      }
      if (!draft.plan || draft.plan.miniQuests.length === 0) {
        return { success: false, message: "This plan is empty — add a phase before starting." };
      }

      const [userError, user] = await catchError(
        User.findById(context.id, USER_PROJECTION).lean()
      );
      if (userError || !user) return { success: false, message: "Failed to verify user." };

      // The real gate. Checked here — with the finished plan on screen — rather
      // than before the user has seen anything.
      const userTier: "free" | "pro" = tierOf(user as any);
      if (userTier === "free") {
        const activeCount = await countActiveShards(context.id);
        if (activeCount >= FREE_ACTIVE_SHARD_CAP) {
          return upgradeError(
            `Free plan is limited to ${FREE_ACTIVE_SHARD_CAP} active quests. Upgrade to Pro to start this one!`
          );
        }
      }

      const written = await writeQuest({
        userId: context.id,
        user,
        plan: draft.plan as DraftPlan,
        deadline: draft.deadline,
        image: draft.image,
        participants: draft.participants?.map((p: any) => ({
          user: p.user.toString(),
          role: p.role,
        })),
        isPrivate: draft.isPrivate,
        isAnonymous: draft.isAnonymous,
        questType: draft.questType,
        cadence: draft.cadence,
        brief: draft.brief as QuestBriefInput | undefined,
        rhythm: draft.rhythm as any,
      });

      if (!written) return { success: false, message: "Failed to create quest." };

      // Stamped before cleanup so a retry can't double-write even if the delete
      // below fails.
      draft.committedShardId = written.shard._id;
      await draft.save().catch(() => {});

      checkAchievements(context.id).catch(() => {});
      // Plan edit rate is the metric that says whether the workspace earned its
      // place: plans committed untouched mean the generated plan was already
      // fine and this was decoration.
      logEvent({
        name: "ai_quest_created",
        userId: context.id,
        tier: userTier,
        props: {
          mode: "draft",
          refinements: draft.refinementsUsed,
          phases: draft.plan.miniQuests.length,
        },
      });

      return {
        success: true,
        message: "Quest created successfully!",
        warning: draft.plan.warning || null,
        shard: { id: written.shardId, title: written.title },
      };
    },
  },
};

/** Draft → GraphQL shape. `_id` is exposed as `id` like everything else here. */
function serialiseDraft(draft: any) {
  return {
    id: draft._id.toString(),
    goal: draft.goal,
    deadline: draft.deadline ? draft.deadline.toISOString() : null,
    plan: draft.plan,
    refinements: (draft.refinements ?? []).map((r: any) => r.text),
    refinementsRemaining: MAX_REFINEMENTS - (draft.refinementsUsed ?? 0),
    canUndo: !!draft.previousPlan,
  };
}
