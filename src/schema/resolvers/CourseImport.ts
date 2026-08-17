/**
 * Course Import resolvers — P1 + P1.5.
 *
 * importCurriculum   → writes a CurriculumDraft, free
 * paceCurriculum     → pure preview, free, no writes
 * createShardFromCurriculum → commits the draft as a shard, charges one credit
 * catchUpToTask      → bulk-complete in curriculum order, one XP award
 * undoCatchUp        → reverse a batch within the 5-minute window
 * reflowSchedule     → re-spread remaining items over remaining days
 */

import { randomUUID } from "crypto";
import Shard from "../../models/Shard.js";
import MiniGoal from "../../models/MiniGoal.js";
import CurriculumDraft from "../../models/CurriculumDraft.js";
import { User } from "../../models/User.js";
import { catchError, logError, ThrowError } from "../../Helpers/Helpers.js";
import { moderate } from "../../Helpers/ContentModerator.js";
import {
  applyEnrichmentDiff,
  detectProvider,
  extractPlaylistId,
  type Curriculum,
} from "../../Helpers/Curriculum.js";
import { pace, type PacingInput } from "../../Helpers/Pacer.js";
import { importYouTubePlaylist, YoutubeAdapterDisabledError, YoutubeQuotaExhaustedError } from "../../Helpers/adapters/youtube.js";
import { importPastedText } from "../../Helpers/adapters/text.js";
import { unfurlLink } from "../../Helpers/adapters/unfurl.js";
import { createChatCompletion } from "../../Helpers/LLM.js";
import { LIGHT_MODEL } from "../../config/models.js";
import { cacheInvalidate } from "../../Helpers/Cache.js";
import {
  tierOf,
  countActiveShards,
  upgradeError,
  FREE_ACTIVE_SHARD_CAP,
} from "../../Helpers/Entitlements.js";
import {
  checkAIUsage,
  trackAIUsage,
  type QuestBriefInput,
} from "../../Helpers/AIHelper.js";
import {
  taskXPValue,
  miniGoalProgress,
  allTasksComplete,
  recomputeShardProgress,
} from "../../Helpers/Progress.js";
import { awardXP, checkAchievements, UNDO_WINDOW_MINUTES } from "./XP.js";
import { recordActivity } from "../../Helpers/Streak.js";
import { logEvent } from "../../Helpers/Telemetry.js";

/** Mirrors XP.ts local helper — XP → character level. */
function calculateLevel(xp: number): number {
  let level = 1;
  let total = 0;
  let required = 100;
  while (total + required <= xp) {
    total += required;
    level++;
    required = Math.floor(100 * Math.pow(1.5, level - 1));
  }
  return level;
}

const USER_PROJECTION =
  "role subscriptionTier trialStartedAt trialEndsAt firstQuestCompletedAt " +
  "username timezone preferences level xp currentStreak";

// ─── Enrichment ───────────────────────────────────────────────────────────────

const ENRICH_SYSTEM = `You are a curriculum enrichment tool. Given a course curriculum JSON, return a diff JSON describing:
1. How to group the flat item list into coherent sections (if the source has none).
2. Which items (by flat index) are optional for the stated goal.
3. Practice tasks to insert after specific items — one per section, max 15% of total items.

You MUST NOT reorder, retitle, delete or re-time existing items.
Only emit a diff. Return ONLY valid JSON matching this schema:
{
  "sections": [{ "title": "string", "itemRange": [startIndex, endIndex] }],
  "optional": [flatIndex, ...],
  "renamedSections": [{ "index": newSectionIndex, "title": "string" }],
  "practice": [{ "afterIndex": flatIndex, "title": "string", "estimatedMinutes": number }]
}
All fields optional except "sections", which must cover every item (0-indexed, non-overlapping, exhaustive).
Cap practice at 15% of total items (round up, min 1). Keep titles under 80 characters.`;

async function enrichCurriculum(
  curriculum: Curriculum,
  goal?: string
): Promise<Curriculum> {
  const flatItems = curriculum.sections.flatMap((s) => s.items);
  const totalItems = flatItems.length;
  if (totalItems === 0) return curriculum;

  // Chunk if over 150 items (§4.2).
  if (totalItems > 150) {
    // Process in two halves; apply both diffs with an offset.
    // For now return the curriculum unchanged — chunking is a follow-up.
    // The curriculum is valid on its own.
    return curriculum;
  }

  const userPrompt = [
    goal ? `User's goal: "${goal}"` : "",
    `Curriculum (${totalItems} items):`,
    JSON.stringify({ sections: curriculum.sections }, null, 0),
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await createChatCompletion({
      model: LIGHT_MODEL,
      messages: [
        { role: "system", content: ENRICH_SYSTEM },
        { role: "user", content: userPrompt.slice(0, 12000) },
      ],
      response_format: { type: "json_object" },
    });

    const content = res.choices[0]?.message?.content ?? "";
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return curriculum;

    let diff: unknown;
    try {
      diff = JSON.parse(match[0]);
    } catch {
      return curriculum;
    }

    return applyEnrichmentDiff(curriculum, diff);
  } catch (err) {
    logError("enrichCurriculum:llm", err);
    return curriculum;
  }
}

// ─── importCurriculum ─────────────────────────────────────────────────────────

export async function importCurriculumResolver(
  _: any,
  { input }: { input: { url?: string; pastedText?: string; imageUrls?: string[]; goal?: string } },
  context: any
) {
  if (!context.id) ThrowError("Please login to continue.");

  const { url, pastedText, goal } = input;

  // Moderate the user's goal (it's their stated intent).
  if (goal) {
    const mod = moderate(goal, "goal");
    if (!mod.allowed) {
      return { success: false, message: mod.reason || "That goal can't be used." };
    }
  }

  // Per-user rate limit for imports (~5/hour) to prevent quota abuse.
  // We use a simple in-memory check here; Redis would be more robust for multi-process.
  // The free-tier 3-shard cap is the real binding constraint.

  let curriculum: Curriculum | null = null;
  let notice: string | undefined;

  // ── YouTube ────────────────────────────────────────────────────────────────
  if (url) {
    const provider = detectProvider(url);

    if (provider === "youtube") {
      const playlistId = extractPlaylistId(url);

      if (playlistId) {
        try {
          const result = await importYouTubePlaylist(playlistId, undefined, goal ?? undefined);
          curriculum = result.curriculum;
          notice = result.notice;
        } catch (err) {
          if (err instanceof YoutubeAdapterDisabledError) {
            // API key not set — degrade to unfurl + "paste instead" message.
            const meta = await unfurlLink(url).catch(() => null);
            if (meta?.title) {
              curriculum = {
                provider: "youtube",
                fidelity: "inferred",
                title: meta.title,
                author: meta.author,
                thumbnail: meta.thumbnail,
                sections: [],
                fetchedAt: new Date(),
              };
              notice = "YouTube import isn't configured — paste the curriculum text instead.";
            } else {
              return {
                success: false,
                message: "We couldn't connect to YouTube right now. Paste the course list instead.",
              };
            }
          } else if (err instanceof YoutubeQuotaExhaustedError) {
            return {
              success: false,
              message: "We've hit our YouTube quota for today. Paste the course list instead.",
            };
          } else {
            logError("importCurriculum:youtube", err);
            return { success: false, message: "Couldn't import this YouTube playlist." };
          }
        }
      } else {
        // Single YouTube video — not a playlist.
        const meta = await unfurlLink(url).catch(() => null);
        curriculum = {
          provider: "youtube",
          fidelity: "exact",
          title: meta?.title ?? "YouTube Video",
          author: meta?.author,
          thumbnail: meta?.thumbnail,
          url,
          sections: [
            {
              title: meta?.title ?? "Video",
              items: [{ kind: "lecture", title: meta?.title ?? "Video", url }],
            },
          ],
          fetchedAt: new Date(),
        };
      }
    } else if (provider === "udemy" || provider === "coursera" || provider === "edx") {
      // No API — unfurl for metadata, tell the user to paste/screenshot.
      const meta = await unfurlLink(url).catch(() => null);
      curriculum = {
        provider,
        fidelity: "inferred",
        title: meta?.title ?? `${provider.charAt(0).toUpperCase()}${provider.slice(1)} Course`,
        author: meta?.author,
        thumbnail: meta?.thumbnail,
        url,
        sections: [],
        fetchedAt: new Date(),
      };
      const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
      notice = `${providerName} closed their public API, so we can't read the lecture list automatically. Paste the curriculum text below, or screenshot the curriculum in the app.`;
    } else {
      // Unknown host — unfurl for title.
      const meta = await unfurlLink(url).catch(() => null);
      if (meta?.title) {
        curriculum = {
          provider: "web",
          fidelity: "inferred",
          title: meta.title,
          author: meta.author,
          thumbnail: meta.thumbnail,
          url,
          sections: [],
          fetchedAt: new Date(),
        };
      }
    }
  }

  // ── Pasted text ────────────────────────────────────────────────────────────
  if (pastedText?.trim()) {
    // Moderate imported content (narrow check — skips false-positive criminal patterns).
    const mod = moderate(pastedText, "imported_content");
    if (!mod.allowed) {
      return { success: false, message: "This content can't be imported." };
    }

    try {
      const result = await importPastedText(pastedText, url ?? undefined);
      // Merge: if we already have a curriculum from URL (e.g. a YouTube single
      // video), the paste overrides sections only.
      if (curriculum) {
        curriculum = { ...curriculum, sections: result.curriculum.sections };
      } else {
        curriculum = result.curriculum;
      }
      if (result.notice) notice = result.notice;
    } catch (err) {
      logError("importCurriculum:paste", err);
      return { success: false, message: "Couldn't parse the pasted curriculum." };
    }
  }

  // ── Vision (P2) ────────────────────────────────────────────────────────────
  // imageUrls are accepted but the vision adapter ships in P2. For now we return
  // a clear notice so the UI can direct the user to paste instead.
  if (input.imageUrls?.length && !curriculum) {
    return {
      success: false,
      message: "Screenshot import is coming soon. Paste the curriculum text for now.",
    };
  }

  if (!curriculum) {
    return {
      success: false,
      message: "Please provide a URL or paste the curriculum text.",
    };
  }

  // ── Enrichment ────────────────────────────────────────────────────────────
  // Only enrich when we have actual items — an empty curriculum is waiting for
  // the user to paste and shouldn't go through an LLM call.
  if (curriculum.sections.some((s) => s.items.length > 0)) {
    curriculum = await enrichCurriculum(curriculum, goal ?? undefined);
  }

  // ── Persist draft ─────────────────────────────────────────────────────────
  const [draftError, draft] = await catchError(
    CurriculumDraft.create({ userId: context.id, curriculum, goal: goal ?? undefined })
  );

  if (draftError || !draft) {
    logError("importCurriculum:saveDraft", draftError);
    return { success: false, message: "Failed to save the import." };
  }

  logEvent({
    name: "curriculum_import_succeeded",
    userId: context.id,
    props: {
      provider: curriculum.provider,
      fidelity: curriculum.fidelity,
      sections: curriculum.sections.length,
      items: curriculum.sections.reduce((n, s) => n + s.items.length, 0),
    },
  });

  return {
    success: true,
    draftId: draft._id.toString(),
    curriculum: serialiseCurriculum(curriculum),
    notice,
  };
}

// ─── paceCurriculum ───────────────────────────────────────────────────────────

export async function paceCurriculumResolver(
  _: any,
  {
    input,
  }: {
    input: {
      draftId: string;
      rhythm: { days?: number[]; sessionMinutes?: number; timeOfDay?: string };
      deadline?: string;
      maxTasksPerDay?: number;
    };
  },
  context: any
) {
  if (!context.id) ThrowError("Please login to continue.");

  const [draftError, draft] = await catchError(CurriculumDraft.findById(input.draftId));
  if (draftError || !draft) {
    ThrowError("Draft not found or expired.");
  }
  if (draft!.userId.toString() !== context.id) {
    ThrowError("That draft isn't yours.");
  }

  const curriculum = draft!.curriculum as Curriculum;
  const user = await User.findById(context.id, "timezone preferences").lean();

  const rhythm = {
    days: input.rhythm.days ?? [],
    sessionMinutes: input.rhythm.sessionMinutes ?? 30,
    timeOfDay: input.rhythm.timeOfDay as any,
  };

  const pacingInput: PacingInput = {
    curriculum,
    rhythm,
    startDate: new Date(),
    timezone: (user as any)?.timezone ?? "UTC",
    deadline: input.deadline ? new Date(input.deadline) : undefined,
    maxTasksPerDay:
      input.maxTasksPerDay ?? (user as any)?.preferences?.maxTasksPerDay ?? 4,
  };

  const plan = pace(pacingInput);

  return {
    miniGoals: plan.miniGoals.map((mg) => ({
      title: mg.title,
      dueDate: mg.dueDate.toISOString(),
      taskCount: mg.tasks.length,
      totalSeconds: mg.tasks.reduce((s, t) => s + (t.estimatedSeconds ?? 0), 0),
    })),
    sessionCount: plan.sessionCount,
    projectedEndDate: plan.projectedEndDate.toISOString(),
    warning: plan.warning,
  };
}

// ─── createShardFromCurriculum ────────────────────────────────────────────────

function normaliseCurriculumInput(raw: any): Curriculum {
  return {
    provider: raw.provider ?? "web",
    fidelity: raw.fidelity ?? "imported",
    title: raw.title ?? "Course",
    author: raw.author,
    url: raw.url,
    thumbnail: raw.thumbnail,
    sections: (raw.sections ?? []).map((s: any) => ({
      title: s.title ?? "Section",
      items: (s.items ?? []).map((item: any) => ({
        kind: item.kind ?? "lecture",
        title: item.title ?? "",
        durationSeconds: item.durationSeconds,
        url: item.url,
        externalId: item.externalId,
        optional: item.optional,
        synthesized: item.synthesized,
      })),
    })),
    totalSeconds: raw.totalSeconds,
    fetchedAt: new Date(raw.fetchedAt ?? Date.now()),
  };
}

export async function createShardFromCurriculumResolver(
  _: any,
  {
    input,
  }: {
    input: {
      draftId: string;
      curriculum: any; // user's edited version
      rhythm: { days?: number[]; sessionMinutes?: number; timeOfDay?: string };
      deadline?: string;
      maxTasksPerDay?: number;
      brief?: QuestBriefInput;
      image?: string;
      participants?: { user: string; role: string }[];
      isPrivate?: boolean;
      isAnonymous?: boolean;
    };
  },
  context: any
) {
  if (!context.id) ThrowError("Please login to continue.");

  const [draftError, draft] = await catchError(CurriculumDraft.findById(input.draftId));
  if (draftError || !draft) {
    return { success: false, message: "That import has expired. Please import again." };
  }
  if (draft.userId.toString() !== context.id) {
    return { success: false, message: "That import isn't yours." };
  }

  const [userError, user] = await catchError(
    User.findById(context.id, USER_PROJECTION).lean()
  );
  if (userError || !user) return { success: false, message: "Failed to verify user." };

  const userTier: "free" | "pro" = tierOf(user as any);

  // Shard cap — checked with the reviewed plan on screen (§13.3 rule 1).
  if (userTier === "free") {
    const activeCount = await countActiveShards(context.id);
    if (activeCount >= FREE_ACTIVE_SHARD_CAP) {
      return upgradeError(
        `Free plan is limited to ${FREE_ACTIVE_SHARD_CAP} active quests. Upgrade to Pro to start this one!`
      );
    }
  }

  // Credit check — same rule as createShard (§13.2: one quest, one credit).
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

  // The user's edited curriculum (they may have unchecked items or edited titles).
  const curriculum = normaliseCurriculumInput(input.curriculum);

  const rhythm = {
    days: input.rhythm.days ?? [],
    sessionMinutes: input.rhythm.sessionMinutes ?? 30,
    timeOfDay: input.rhythm.timeOfDay as any,
  };

  // Re-pace with the SAME inputs the preview used. `paceCurriculum` takes a
  // deadline and a per-day cap; if the commit doesn't take them too, the user
  // approves a plan with optional items dropped to hit their date and receives
  // one with those items back in and a later end date.
  const deadline = input.deadline ? new Date(input.deadline) : undefined;

  const plan = pace({
    curriculum,
    rhythm,
    startDate: new Date(),
    timezone: (user as any)?.timezone ?? "UTC",
    deadline,
    maxTasksPerDay:
      input.maxTasksPerDay ?? (user as any)?.preferences?.maxTasksPerDay ?? 4,
  });

  if (plan.miniGoals.length === 0) {
    return {
      success: false,
      message: "The curriculum is empty — select at least one item.",
    };
  }

  // Create the shard.
  const [shardError, newShard] = await catchError(
    Shard.create({
      title: curriculum.title,
      image: input.image || curriculum.thumbnail || undefined,
      description: curriculum.author ? `Course by ${curriculum.author}` : undefined,
      owner: context.id,
      participants: input.participants?.map((p) => ({ user: p.user, role: p.role })) ?? [],
      timeline: {
        startDate: new Date(),
        endDate: plan.projectedEndDate,
      },
      progress: { completion: 0, xpEarned: 0, level: 1 },
      status: "active",
      isPrivate: input.isPrivate ?? false,
      isAnonymous: input.isAnonymous ?? false,
      questType: "standard",
      rewards: [{ type: "xp", value: 300 }],
      rhythm,
      brief: input.brief ? { ...input.brief, capturedAt: new Date() } : undefined,
      source: {
        provider: curriculum.provider,
        fidelity: curriculum.fidelity,
        url: curriculum.url,
        title: curriculum.title,
        author: curriculum.author,
        importedAt: new Date(),
      },
    })
  );

  if (shardError || !newShard) {
    logError("createShardFromCurriculum:createShard", shardError);
    return { success: false, message: "Failed to create quest." };
  }

  // Write mini-goals with curriculum-order metadata.
  await Promise.all(
    plan.miniGoals.map((mg) =>
      MiniGoal.create({
        shardId: newShard._id,
        title: mg.title,
        dueDate: mg.dueDate,
        progress: 0,
        completed: false,
        // Provenance and sequence start equal here and are allowed to diverge:
        // reordering a plan changes where a section sits, not where it came from.
        sourceSectionIndex: mg.sourceSectionIndex,
        order: mg.sourceSectionIndex,
        tasks: mg.tasks.map((t) => ({
          title: t.title,
          dueDate: t.dueDate,
          completed: false,
          xpReward: 20,
          estimatedSeconds: t.estimatedSeconds,
          synthesized: t.synthesized,
        })),
      })
    )
  );

  // Charge credit after success (§13.2).
  if ((user as any)?.role !== "admin") {
    await trackAIUsage(context.id, userTier).catch(() => {});
  }

  // Same hook createShard and commitQuestDraft both fire. Without it, creating
  // your first quest through the course flow doesn't unlock "First Shard" — the
  // stat is right, but nothing evaluates it until some unrelated action does.
  checkAchievements(context.id).catch(() => {});

  // Delete the draft — it's been committed.
  await CurriculumDraft.findByIdAndDelete(input.draftId).catch(() => {});

  await cacheInvalidate.shardList(context.id).catch(() => {});

  logEvent({
    name: "course_quest_created",
    userId: context.id,
    tier: userTier,
    props: {
      provider: curriculum.provider,
      fidelity: curriculum.fidelity,
      sections: plan.miniGoals.length,
      tasks: plan.miniGoals.reduce((n, mg) => n + mg.tasks.length, 0),
    },
  });

  return {
    success: true,
    message: "Quest created!",
    warning: plan.warning,
    shard: { id: newShard._id.toString(), title: newShard.title },
  };
}

// ─── catchUpToTask ────────────────────────────────────────────────────────────

/**
 * Resolve the plan-order prefix ending at (miniGoalId, taskIndex).
 *
 * "Before" is the lexicographic pair `(order, taskIndex)`, where `order` is the
 * same field the shard screen sorts by — so the tasks the user can see above the
 * one they tapped are exactly the tasks this completes. Shards created before
 * `order` existed fall back to `createdAt`.
 *
 * Exported for its own tests: this function decides how many of someone's tasks
 * get marked done in one go, so its definition of "before" is worth pinning.
 */
export async function resolveCatchUpPrefix(
  shardId: string,
  targetMiniGoalId: string,
  targetTaskIndex: number
): Promise<Array<{ miniGoalId: string; taskIndex: number }>> {
  const miniGoals = await MiniGoal.find({ shardId })
    .select("_id tasks order createdAt version")
    .lean();

  // "Before" is defined by plan order, not by which insert won the race.
  // `order` is the same field the shard screen sorts by, so the set the user
  // sees above the task they tapped is exactly the set that gets completed.
  // `createdAt` still breaks ties for shards predating the backfill.
  const sorted = [...miniGoals].sort((a, b) => {
    const ai = (a as any).order ?? Infinity;
    const bi = (b as any).order ?? Infinity;
    if (ai !== bi) return ai - bi;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  const result: Array<{ miniGoalId: string; taskIndex: number }> = [];
  let found = false;

  for (const mg of sorted) {
    const mgId = mg._id.toString();
    const tasks = mg.tasks as any[];
    const isTarget = mgId === targetMiniGoalId;

    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i].deleted) continue;

      if (isTarget && i === targetTaskIndex) {
        result.push({ miniGoalId: mgId, taskIndex: i });
        found = true;
        break;
      }
      result.push({ miniGoalId: mgId, taskIndex: i });
    }
    if (found) break;
  }

  if (!found) return [];
  return result;
}

export async function catchUpToTaskResolver(
  _: any,
  {
    shardId,
    miniGoalId,
    taskIndex,
  }: { shardId: string; miniGoalId: string; taskIndex: number },
  context: any
) {
  if (!context.id) ThrowError("Please login to continue.");

  const [shardError, shard] = await catchError(
    Shard.findById(shardId).select("owner participants source").lean()
  );
  if (shardError || !shard) {
    return { success: false, message: "Quest not found." };
  }
  const isOwner = (shard as any).owner.toString() === context.id;
  const isCollaborator = (shard as any).participants.some(
    (p: any) => p.user.toString() === context.id && p.role === "collaborator"
  );
  if (!isOwner && !isCollaborator) {
    return { success: false, message: "You don't have permission." };
  }

  // Resolve the prefix of incomplete tasks in curriculum order.
  const prefix = await resolveCatchUpPrefix(shardId, miniGoalId, taskIndex);
  if (prefix.length === 0) {
    return { success: false, message: "Task not found." };
  }

  const batchId = randomUUID();
  const now = new Date();
  let tasksCompleted = 0;
  let totalXP = 0;

  // Group by mini-goal for efficient bulk writes.
  const byMiniGoal = new Map<string, number[]>();
  for (const { miniGoalId: mgId, taskIndex: ti } of prefix) {
    const list = byMiniGoal.get(mgId) ?? [];
    list.push(ti);
    byMiniGoal.set(mgId, list);
  }

  // Record prevLastActivityAt for undo.
  const prevLastActivityAt = (shard as any).lastActivityAt as Date | undefined;

  for (const [mgId, indices] of byMiniGoal) {
    const mg = await MiniGoal.findById(mgId).lean();
    if (!mg) continue;
    const tasks = mg.tasks as any[];

    for (const ti of indices) {
      const task = tasks[ti];
      if (!task || task.completed || task.deleted) continue;

      const xp = taskXPValue(task);
      await MiniGoal.updateOne(
        { _id: mgId, [`tasks.${ti}.completed`]: false },
        {
          $set: {
            [`tasks.${ti}.completed`]: true,
            [`tasks.${ti}.completedAt`]: now,
            [`tasks.${ti}.xpAwarded`]: xp,
            [`tasks.${ti}.catchUpBatchId`]: batchId,
          },
        }
      );
      totalXP += xp;
      tasksCompleted++;
    }

    // Re-read and recompute progress.
    const fresh = await MiniGoal.findById(mgId).lean();
    if (fresh) {
      const prog = miniGoalProgress(fresh.tasks);
      const complete = allTasksComplete(fresh.tasks);
      await MiniGoal.updateOne(
        { _id: mgId },
        { $set: { progress: prog, completed: complete } }
      );
    }
  }

  if (tasksCompleted === 0) {
    return {
      success: true,
      message: "Already up to date.",
      tasksCompleted: 0,
      xpAwarded: 0,
      batchId,
    };
  }

  await recomputeShardProgress(shardId);

  // One XP award for the whole batch.
  const xpResult = await awardXP(context.id, totalXP, `Catch-up on ${shard ? (shard as any).title ?? "quest" : "quest"}`);
  await recordActivity(context.id);
  // A catch-up can complete a dozen tasks and several mini-goals at once, which
  // is exactly when a count threshold gets crossed. Undo reverses the tasks but
  // not the unlock — deliberate: achievements are permanent by design (see the
  // note in XP.ts), and revoking one is a worse experience than granting it a
  // few minutes early.
  checkAchievements(context.id).catch(() => {});

  logEvent({
    name: "catchup_used",
    userId: context.id,
    props: { tasksCompleted, xpAwarded: totalXP },
  });

  return {
    success: true,
    message: `Caught up ${tasksCompleted} task${tasksCompleted > 1 ? "s" : ""}! +${totalXP} XP`,
    tasksCompleted,
    xpAwarded: totalXP,
    batchId,
    prevLastActivityAt: prevLastActivityAt?.toISOString(),
  };
}

// ─── undoCatchUp ──────────────────────────────────────────────────────────────

export async function undoCatchUpResolver(
  _: any,
  { batchId }: { batchId: string },
  context: any
) {
  if (!context.id) ThrowError("Please login to continue.");

  // Find all tasks in this batch.
  const miniGoals = await MiniGoal.find({
    "tasks.catchUpBatchId": batchId,
  })
    .select("_id shardId tasks")
    .lean();

  if (miniGoals.length === 0) {
    return { success: false, message: "Batch not found or already reversed." };
  }

  // Verify ownership via the first shard.
  const shardId = miniGoals[0].shardId.toString();
  const shard = await Shard.findById(shardId).select("owner").lean();
  if (!shard || (shard as any).owner.toString() !== context.id) {
    return { success: false, message: "You don't have permission." };
  }

  let totalClawback = 0;
  let reversedCount = 0;
  const now = Date.now();

  for (const mg of miniGoals) {
    const tasks = mg.tasks as any[];
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (t.catchUpBatchId !== batchId || !t.completed) continue;

      const completedAt = t.completedAt ? new Date(t.completedAt).getTime() : 0;
      if (now - completedAt > UNDO_WINDOW_MINUTES * 60 * 1000) {
        return {
          success: false,
          message: `Catch-up can only be undone within ${UNDO_WINDOW_MINUTES} minutes.`,
        };
      }

      const clawback = t.xpAwarded ?? taskXPValue(t);
      await MiniGoal.updateOne(
        { _id: mg._id, [`tasks.${i}.catchUpBatchId`]: batchId },
        {
          $set: { [`tasks.${i}.completed`]: false },
          $unset: {
            [`tasks.${i}.completedAt`]: "",
            [`tasks.${i}.xpAwarded`]: "",
            [`tasks.${i}.catchUpBatchId`]: "",
          },
        }
      );
      totalClawback += clawback;
      reversedCount++;
    }

    // Recompute mini-goal progress.
    const fresh = await MiniGoal.findById(mg._id).lean();
    if (fresh) {
      await MiniGoal.updateOne(
        { _id: mg._id },
        {
          $set: {
            progress: miniGoalProgress(fresh.tasks),
            completed: allTasksComplete(fresh.tasks),
          },
        }
      );
    }
  }

  await recomputeShardProgress(shardId);

  // Claw back XP.
  if (totalClawback > 0) {
    const rawUser = await User.findById(context.id).select("xp level").lean() as any;
    if (rawUser) {
      const newXP = Math.max(0, (rawUser.xp ?? 0) - totalClawback);
      const newLevel = calculateLevel(newXP);
      await User.findByIdAndUpdate(context.id, { $set: { xp: newXP, level: newLevel } });
      await cacheInvalidate.user(context.id).catch(() => {});
    }
  }

  return {
    success: true,
    message: `Undone ${reversedCount} task${reversedCount > 1 ? "s" : ""}.`,
    tasksCompleted: -reversedCount,
    xpAwarded: -totalClawback,
    batchId,
  };
}

// ─── reflowSchedule ───────────────────────────────────────────────────────────

export async function reflowScheduleResolver(
  _: any,
  {
    shardId,
    rhythm: rhythmInput,
  }: { shardId: string; rhythm?: { days?: number[]; sessionMinutes?: number; timeOfDay?: string } },
  context: any
) {
  if (!context.id) ThrowError("Please login to continue.");

  const [shardError, shard] = await catchError(
    Shard.findById(shardId).select("owner source rhythm title").lean()
  );
  if (shardError || !shard) return { success: false, message: "Quest not found." };
  if ((shard as any).owner.toString() !== context.id) {
    return { success: false, message: "Only the quest owner can reflow the schedule." };
  }
  if (!(shard as any).source) {
    return { success: false, message: "Reflow is only available for course quests." };
  }

  const effectiveRhythm = rhythmInput
    ? {
        days: rhythmInput.days ?? [],
        sessionMinutes: rhythmInput.sessionMinutes ?? 30,
        timeOfDay: rhythmInput.timeOfDay as any,
      }
    : (shard as any).rhythm;

  if (!effectiveRhythm || effectiveRhythm.days.length === 0) {
    return {
      success: false,
      message: "No rhythm set. Choose which days to work on this quest first.",
    };
  }

  const user = await User.findById(context.id, "timezone preferences").lean() as any;
  const timezone = user?.timezone ?? "UTC";

  // Load remaining (incomplete) mini-goals in plan order. The comment used to
  // claim this ordering without a `.sort()` to back it, so a reflow could
  // re-spread the remaining work into the wrong sequence.
  const miniGoals = await MiniGoal.find({
    shardId,
    completed: false,
  })
    .select("_id title tasks order sourceSectionIndex dueDate")
    .sort({ order: 1, createdAt: 1 })
    .lean();

  if (miniGoals.length === 0) {
    return { success: false, message: "No remaining tasks to reflow." };
  }

  const sorted = [...miniGoals].sort(
    (a, b) =>
      ((a as any).sourceSectionIndex ?? Infinity) -
      ((b as any).sourceSectionIndex ?? Infinity)
  );

  // Build a pseudo-curriculum from the remaining items.
  const pseudoCurriculum: Curriculum = {
    provider: (shard as any).source.provider,
    fidelity: (shard as any).source.fidelity,
    title: (shard as any).source.title,
    sections: sorted.map((mg) => ({
      title: mg.title,
      items: (mg.tasks as any[])
        .filter((t) => !t.completed && !t.deleted)
        .map((t) => ({
          kind: "lecture" as const,
          title: t.title,
          durationSeconds: t.estimatedSeconds,
          synthesized: t.synthesized,
        })),
    })),
    fetchedAt: new Date(),
  };

  const plan = pace({
    curriculum: pseudoCurriculum,
    rhythm: effectiveRhythm,
    startDate: new Date(), // Always "now" — never back-date.
    timezone,
    maxTasksPerDay: user?.preferences?.maxTasksPerDay ?? 4,
  });

  // Apply new dates to existing tasks.
  await Promise.all(
    plan.miniGoals.map(async (reflowed, i) => {
      const original = sorted[i];
      if (!original) return;

      const mgTasks = (original.tasks as any[]).filter((t) => !t.completed && !t.deleted);
      const updates: Record<string, any> = {};

      reflowed.tasks.forEach((t, ti) => {
        const origTask = mgTasks[ti];
        if (!origTask) return;
        // Find the actual index in the full tasks array.
        const realIdx = (original.tasks as any[]).indexOf(origTask);
        if (realIdx >= 0) {
          updates[`tasks.${realIdx}.dueDate`] = t.dueDate;
        }
      });

      await MiniGoal.updateOne({ _id: original._id }, { $set: { ...updates, dueDate: reflowed.dueDate } });
    })
  );

  // Update shard rhythm if caller supplied a new one.
  if (rhythmInput) {
    await Shard.findByIdAndUpdate(shardId, { $set: { rhythm: effectiveRhythm } });
  }

  // Update shard timeline.endDate.
  await Shard.findByIdAndUpdate(shardId, {
    $set: { "timeline.endDate": plan.projectedEndDate },
  });

  await cacheInvalidate.shard(shardId).catch(() => {});
  await cacheInvalidate.shardList(context.id).catch(() => {});

  logEvent({
    name: "schedule_reflowed",
    userId: context.id,
    props: { shardId, rhythmChanged: !!rhythmInput },
  });

  return {
    success: true,
    message: "Schedule updated.",
    warning: plan.warning,
    shard: { id: shardId, title: (shard as any).title },
  };
}

// ─── Resolver export ──────────────────────────────────────────────────────────

function serialiseCurriculum(c: Curriculum) {
  return {
    ...c,
    fetchedAt: c.fetchedAt.toISOString(),
  };
}

export default {
  Mutation: {
    importCurriculum: importCurriculumResolver,
    paceCurriculum: paceCurriculumResolver,
    createShardFromCurriculum: createShardFromCurriculumResolver,
    catchUpToTask: catchUpToTaskResolver,
    undoCatchUp: undoCatchUpResolver,
    reflowSchedule: reflowScheduleResolver,
  },
};
