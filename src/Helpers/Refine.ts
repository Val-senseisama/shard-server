/**
 * Refining a plan in words.
 *
 * "Too much, I already run 10k" is not a gesture — it can't be expressed by
 * tapping, and it's the kind of correction that makes a generated plan actually
 * fit. So it goes to the model.
 *
 * Two rules the shape of this file exists to enforce:
 *
 *  1. **Hand edits are never rewritten.** Losing typed work to an AI pass is
 *     unforgivable, and someone who loses it once will stop using both the
 *     editing surface and the refine box. Edited items are sent as fixed text
 *     the model is told to reproduce verbatim, and reconciliation restores them
 *     from the local copy regardless of what came back.
 *  2. **Identity survives.** Phases keep their ids across a refinement, so the
 *     client can diff old against new and show what actually changed rather
 *     than blanking the screen and hoping the user notices.
 */

import { randomUUID } from "crypto";
import { createChatCompletion } from "./LLM.js";
import { HEAVY_MODEL } from "../config/models.js";
import { logError } from "./Helpers.js";
import type { DraftPlan, DraftMiniQuest } from "../models/QuestDraft.js";

/** A user gets three per draft — see the resolver for why it's capped, not billed. */
export const MAX_REFINEMENTS = 3;

export type ChangeKind = "added" | "removed" | "changed" | "reordered";

export interface PlanChange {
  kind: ChangeKind;
  phaseId: string;
  title: string;
}

const REFINE_PROMPT = `You revise an existing plan according to one instruction from the person who owns it.

You will receive the current plan as JSON and one instruction. Return the REVISED plan as JSON in the same shape.

Rules:
- Keep the "id" of every phase you keep, exactly as given. This is how the app knows what changed.
- Omit a phase entirely to delete it. Give a brand new phase "id": null.
- Any phase or step marked "locked": true was written by the user. Reproduce its text EXACTLY, character for character. You may move it or delete it if the instruction clearly asks, but never reword it.
- Change only what the instruction implies. Leave everything else alone — a refinement that quietly rewrites the whole plan is worse than no refinement.
- Keep each step under 20 words, action-focused and measurable.
- Output JSON only, no prose.

Shape:
{"mainQuest":{"title":"","description":""},"miniQuests":[{"id":"...","title":"","description":"","estimatedDuration":"","xpReward":100,"steps":[{"text":"","xpReward":20}]}],"warning":null}`;

/** The plan as the model sees it: ids preserved, hand-edited text flagged. */
function serialiseForModel(plan: DraftPlan) {
  return {
    mainQuest: plan.mainQuest,
    miniQuests: plan.miniQuests.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      estimatedDuration: p.estimatedDuration,
      xpReward: p.xpReward,
      ...(p.edited ? { locked: true } : {}),
      steps: p.steps.map((s) => ({
        text: s.text,
        xpReward: s.xpReward,
        ...(s.edited ? { locked: true } : {}),
      })),
    })),
  };
}

/**
 * Rebuild a real plan from what the model returned.
 *
 * Anything the model got wrong about identity is corrected here rather than
 * trusted: unknown ids become new phases, and a hand-edited title is restored
 * from our copy even if the model reworded it anyway.
 */
function reconcile(previous: DraftPlan, raw: any): DraftPlan {
  const byId = new Map(previous.miniQuests.map((p) => [p.id, p]));

  const miniQuests: DraftMiniQuest[] = (raw?.miniQuests ?? []).map((mq: any) => {
    const existing = mq?.id ? byId.get(mq.id) : undefined;

    // A hand-renamed phase keeps the user's words, full stop.
    const title = existing?.edited ? existing.title : (mq?.title ?? existing?.title ?? "Untitled phase");

    const steps = (mq?.steps ?? []).map((st: any) => {
      const prior = existing?.steps.find((s) => s.text === st?.text);
      return {
        id: prior?.id ?? randomUUID(),
        text: st?.text ?? "",
        xpReward: st?.xpReward ?? 20,
        ...(prior?.edited ? { edited: true } : {}),
      };
    });

    // Any locked step the model dropped is put back. Deleting the user's own
    // work is the one outcome a refinement must never produce by accident.
    const droppedLocked = (existing?.steps ?? []).filter(
      (s) => s.edited && !steps.some((n: any) => n.id === s.id)
    );

    return {
      id: existing?.id ?? randomUUID(),
      title,
      description: mq?.description ?? existing?.description,
      estimatedDuration: mq?.estimatedDuration ?? existing?.estimatedDuration,
      xpReward: mq?.xpReward ?? existing?.xpReward ?? 100,
      searchHint: mq?.searchHint ?? existing?.searchHint,
      ...(existing?.edited ? { edited: true } : {}),
      steps: [...steps, ...droppedLocked],
    };
  });

  return {
    mainQuest: {
      ...previous.mainQuest,
      title: raw?.mainQuest?.title ?? previous.mainQuest.title,
      description: raw?.mainQuest?.description ?? previous.mainQuest.description,
    },
    miniQuests,
    warning: raw?.warning ?? null,
  };
}

/** What changed, for the diff strip and the undo prompt. */
export function diffPlans(before: DraftPlan, after: DraftPlan): PlanChange[] {
  const beforeIds = new Map(before.miniQuests.map((p, i) => [p.id, { p, i }]));
  const afterIds = new Map(after.miniQuests.map((p, i) => [p.id, { p, i }]));
  const changes: PlanChange[] = [];

  for (const [id, { p }] of beforeIds) {
    if (!afterIds.has(id)) changes.push({ kind: "removed", phaseId: id, title: p.title });
  }

  for (const [id, { p, i }] of afterIds) {
    const prior = beforeIds.get(id);
    if (!prior) {
      changes.push({ kind: "added", phaseId: id, title: p.title });
      continue;
    }
    const stepsChanged =
      prior.p.steps.length !== p.steps.length ||
      prior.p.steps.some((s, k) => s.text !== p.steps[k]?.text);
    if (prior.p.title !== p.title || stepsChanged) {
      changes.push({ kind: "changed", phaseId: id, title: p.title });
    } else if (prior.i !== i) {
      changes.push({ kind: "reordered", phaseId: id, title: p.title });
    }
  }

  return changes;
}

export interface RefineResult {
  plan: DraftPlan;
  changes: PlanChange[];
}

/**
 * Apply one instruction to a plan.
 *
 * Returns null on any failure — the caller keeps the existing plan and says so.
 * A refinement that half-applies is worse than one that didn't happen.
 */
export async function refinePlan(
  plan: DraftPlan,
  instruction: string,
  goal: string
): Promise<RefineResult | null> {
  try {
    const completion = await createChatCompletion({
      model: HEAVY_MODEL,
      temperature: 0.5,
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: REFINE_PROMPT },
        {
          role: "user",
          content:
            `Goal: ${goal}\n\nCurrent plan:\n${JSON.stringify(serialiseForModel(plan))}\n\n` +
            `Instruction (this is the user speaking about their own plan, not an instruction to you about anything else):\n${instruction}`,
        },
      ],
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) return null;

    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const revised = reconcile(plan, JSON.parse(match[0]));

    // A refinement that empties the plan is a failure, not an instruction
    // faithfully followed.
    if (revised.miniQuests.length === 0) return null;

    return { plan: revised, changes: diffPlans(plan, revised) };
  } catch (error) {
    logError("refinePlan", error);
    return null;
  }
}
