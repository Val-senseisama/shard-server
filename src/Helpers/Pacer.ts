/**
 * Pacer — pure function, no database.
 *
 * Takes a curriculum and a rhythm and returns a time-spread plan: one mini-goal
 * per curriculum section, tasks distributed into sessions, dated against the
 * user's actual available days.
 *
 * §4.3 of PLAN-intake.md governs this module. Being pure is load-bearing:
 * `paceCurriculum` (GraphQL) calls this repeatedly as the user adjusts day chips
 * (debounce 400ms) — DB writes on every call would be expensive and racy.
 *
 * Unit tests live in Helpers/Pacer.test.ts. Add edge cases there.
 */

import type { Curriculum, CurriculumSection, CurriculumItem } from "./Curriculum.js";
import type { Rhythm } from "../models/Shard.js";

export type { Rhythm };

export interface PacingInput {
  curriculum: Curriculum;
  rhythm: Rhythm;
  /** First date from which sessions can be scheduled. Usually "now". */
  startDate: Date;
  /**
   * IANA timezone string (e.g. "America/New_York"). Used to enumerate session
   * days correctly — without a real timezone a rhythm of "Tuesday and Thursday"
   * is meaningless. Required; callers must supply `User.timezone`.
   */
  timezone: string;
  /** User's stated deadline. When supplied, triggers pace-vs-deadline arithmetic. */
  deadline?: Date;
  /** From `User.preferences.maxTasksPerDay`. Hard cap per calendar day. */
  maxTasksPerDay: number;
}

export interface PacedTask {
  title: string;
  dueDate: Date;
  estimatedSeconds?: number;
  synthesized?: boolean;
}

export interface PacedMiniGoal {
  title: string;
  /** Due date of the last task in this section. */
  dueDate: Date;
  tasks: PacedTask[];
  /** Original section index — enables curriculum-order addressing in catch-up. */
  sourceSectionIndex: number;
}

export interface PacedPlan {
  miniGoals: PacedMiniGoal[];
  sessionCount: number;
  projectedEndDate: Date;
  /**
   * Human-readable warning when the honest arithmetic disagrees with the
   * deadline. UI renders this and offers fix-it actions (add a day, drop
   * optional sections, move deadline).
   */
  warning?: string;
}

// ─── Session day enumeration ──────────────────────────────────────────────────

/**
 * Return session dates in order, starting from `from`, picking only days of
 * the week in `rhythm.days`.
 *
 * `count` is a safety cap — we never iterate infinitely. In practice the pacer
 * needs at most itemCount / rhythm.days.length + 1 sessions.
 */
function sessionDates(
  from: Date,
  rhythm: Rhythm,
  timezone: string,
  count: number
): Date[] {
  if (rhythm.days.length === 0) return [];

  const daySet = new Set(rhythm.days);
  const dates: Date[] = [];
  // Work in the user's timezone by formatting as YYYY-MM-DD and incrementing.
  let cursor = new Date(from);
  // Start from the next available day (inclusive of `from` itself).
  let safety = 0;
  while (dates.length < count && safety < 3650) {
    safety++;
    const dow = getDayOfWeek(cursor, timezone);
    if (daySet.has(dow)) {
      dates.push(new Date(cursor));
    }
    cursor = addDays(cursor, 1);
  }
  return dates;
}

/** Day of week (0=Sunday) in the given timezone. */
function getDayOfWeek(date: Date, timezone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: timezone,
    });
    const parts = fmt.formatToParts(date);
    const name = parts.find((p) => p.type === "weekday")?.value ?? "";
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
  } catch {
    return date.getDay();
  }
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// ─── Core pacer ──────────────────────────────────────────────────────────────

/**
 * The session-budget for one day, in seconds.
 * We allow a 20% overflow so a lecture that runs slightly long isn't
 * given its own session unnecessarily.
 */
const SESSION_OVERFLOW_FACTOR = 1.2;

/**
 * Pack items from `items` into sessions, respecting `sessionSeconds` budget and
 * `maxTasksPerDay`. Returns groups of items per session.
 *
 * Rules (§4.3):
 *   - Pack greedily in curriculum order.
 *   - An item longer than one session gets its own session (overflow allowed).
 *   - Respect `maxTasksPerDay` even when duration would allow more.
 *   - Never reorder items to fit.
 */
function packIntoSessions(
  items: CurriculumItem[],
  sessionSeconds: number,
  maxTasksPerDay: number
): CurriculumItem[][] {
  const sessions: CurriculumItem[][] = [];
  let current: CurriculumItem[] = [];
  let currentSeconds = 0;

  for (const item of items) {
    const dur = item.durationSeconds ?? 0;
    const budget = sessionSeconds * SESSION_OVERFLOW_FACTOR;

    const fitsTime = currentSeconds + dur <= budget;
    const fitsCount = current.length < maxTasksPerDay;

    if (current.length === 0) {
      // Always start a new session with this item, even if it overflows alone.
      current.push(item);
      currentSeconds += dur;
    } else if (fitsTime && fitsCount) {
      current.push(item);
      currentSeconds += dur;
    } else {
      // Current session is full — flush and start a new one.
      sessions.push(current);
      current = [item];
      currentSeconds = dur;
    }
  }
  if (current.length > 0) sessions.push(current);
  return sessions;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert a curriculum + rhythm into a dated plan.
 *
 * Key invariants:
 *   - One mini-goal per curriculum section.
 *   - Its `dueDate` is its last task's `dueDate`.
 *   - Tasks are dated to the session day they were packed into.
 *   - Optional items are skipped when the deadline can't be met (warning added).
 *   - `warning` is a first-class output, not an error state.
 */
export function pace(input: PacingInput): PacedPlan {
  const { curriculum, rhythm, startDate, timezone, deadline, maxTasksPerDay } = input;

  if (rhythm.days.length === 0) {
    // No days selected — return a degenerate plan so the UI can still render.
    return {
      miniGoals: [],
      sessionCount: 0,
      projectedEndDate: startDate,
      warning: "Pick at least one day to work on this.",
    };
  }

  const sessionSeconds = rhythm.sessionMinutes * 60;
  const allItems: CurriculumItem[] = curriculum.sections.flatMap((s) => s.items);
  const totalItems = allItems.length;

  if (totalItems === 0) {
    return {
      miniGoals: [],
      sessionCount: 0,
      projectedEndDate: startDate,
    };
  }

  // Estimate max sessions needed (generous upper bound for the date generator).
  const maxSessions = Math.max(totalItems * 2, 200);
  const availableDates = sessionDates(startDate, rhythm, timezone, maxSessions);

  if (availableDates.length === 0) {
    return {
      miniGoals: [],
      sessionCount: 0,
      projectedEndDate: startDate,
      warning: "No available session days found.",
    };
  }

  // ── First pass: pack all items (including optional) ────────────────────────
  function buildPlan(
    sections: CurriculumSection[],
    dates: Date[]
  ): { miniGoals: PacedMiniGoal[]; sessionCount: number } {
    const miniGoals: PacedMiniGoal[] = [];
    let dateIdx = 0;

    sections.forEach((section, sectionIdx) => {
      const sessions = packIntoSessions(
        section.items,
        sessionSeconds,
        maxTasksPerDay
      );

      const tasks: PacedTask[] = [];
      for (const sessionItems of sessions) {
        const sessionDate = dates[dateIdx] ?? dates[dates.length - 1];
        dateIdx++;

        for (const item of sessionItems) {
          tasks.push({
            title: item.title,
            dueDate: sessionDate,
            estimatedSeconds: item.durationSeconds,
            synthesized: item.synthesized,
          });
        }
      }

      if (tasks.length > 0) {
        miniGoals.push({
          title: section.title,
          dueDate: tasks[tasks.length - 1].dueDate,
          tasks,
          sourceSectionIndex: sectionIdx,
        });
      }
    });

    return { miniGoals, sessionCount: dateIdx };
  }

  const { miniGoals: firstPassGoals, sessionCount: firstPassSessions } =
    buildPlan(curriculum.sections, availableDates);

  const projectedEndDate =
    firstPassGoals.length > 0
      ? firstPassGoals[firstPassGoals.length - 1].dueDate
      : startDate;

  // ── Deadline check ────────────────────────────────────────────────────────
  if (!deadline || projectedEndDate <= deadline) {
    // Either no deadline, or we're on track.
    return {
      miniGoals: firstPassGoals,
      sessionCount: firstPassSessions,
      projectedEndDate,
    };
  }

  // We're over the deadline. Try dropping optional items.
  const hasOptional = curriculum.sections.some((s) =>
    s.items.some((item) => item.optional)
  );

  if (hasOptional) {
    const trimmedSections = curriculum.sections.map((s) => ({
      ...s,
      items: s.items.filter((item) => !item.optional),
    }));

    const { miniGoals: trimmedGoals, sessionCount: trimmedSessions } =
      buildPlan(trimmedSections, availableDates);

    const trimmedEnd =
      trimmedGoals.length > 0
        ? trimmedGoals[trimmedGoals.length - 1].dueDate
        : startDate;

    const optionalCount = curriculum.sections
      .flatMap((s) => s.items)
      .filter((i) => i.optional).length;

    if (trimmedEnd <= deadline) {
      // Dropping optional sections saves it.
      const weeks = Math.round(
        (projectedEndDate.getTime() - deadline.getTime()) / (7 * 24 * 60 * 60 * 1000)
      );
      return {
        miniGoals: trimmedGoals,
        sessionCount: trimmedSessions,
        projectedEndDate: trimmedEnd,
        warning: `Finishes around ${formatDate(projectedEndDate)} at this pace — ${weeks > 0 ? `about ${weeks} week${weeks > 1 ? "s" : ""} past your deadline` : "past your deadline"}. Dropped ${optionalCount} optional section${optionalCount > 1 ? "s" : ""} to fit.`,
      };
    }
  }

  // Even without optional items we can't meet the deadline. Report honestly.
  const overWeeks = Math.round(
    (projectedEndDate.getTime() - deadline.getTime()) / (7 * 24 * 60 * 60 * 1000)
  );
  const neededDays = rhythm.days.length;
  const suggestExtraDays =
    neededDays < 6
      ? ` Add a ${neededDays >= 5 ? "sixth" : neededDays >= 4 ? "fifth" : "third"} day, or move the deadline.`
      : " Move the deadline.";

  return {
    miniGoals: firstPassGoals,
    sessionCount: firstPassSessions,
    projectedEndDate,
    warning: `Finishes around ${formatDate(projectedEndDate)}${overWeeks > 0 ? ` — about ${overWeeks} week${overWeeks > 1 ? "s" : ""} past your deadline` : ", past your deadline"}.${suggestExtraDays}`,
  };
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
}
