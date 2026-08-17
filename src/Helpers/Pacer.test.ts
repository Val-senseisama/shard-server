import { describe, it, expect } from "vitest";
import { pace, type PacingInput } from "./Pacer.js";
import type { Curriculum } from "./Curriculum.js";

describe("Pacer pure logic", () => {
  const sampleCurriculum: Curriculum = {
    provider: "youtube",
    fidelity: "exact",
    title: "Intro to TypeScript",
    sections: [
      {
        title: "Section 1: Basics",
        items: [
          { kind: "lecture", title: "1. Types", durationSeconds: 600 },
          { kind: "lecture", title: "2. Interfaces", durationSeconds: 900 },
          { kind: "practice", title: "3. Practice Basics", durationSeconds: 600, synthesized: true },
        ],
      },
      {
        title: "Section 2: Advanced",
        items: [
          { kind: "lecture", title: "4. Generics", durationSeconds: 1200 },
          { kind: "lecture", title: "5. Utility Types", durationSeconds: 900, optional: true },
        ],
      },
    ],
    fetchedAt: new Date("2026-08-17T00:00:00Z"),
  };

  it("handles empty days gracefully with a friendly warning", () => {
    const plan = pace({
      curriculum: sampleCurriculum,
      rhythm: { days: [], sessionMinutes: 30 },
      startDate: new Date("2026-08-17T00:00:00Z"),
      timezone: "UTC",
      maxTasksPerDay: 4,
    });

    expect(plan.miniGoals).toHaveLength(0);
    expect(plan.sessionCount).toBe(0);
    expect(plan.warning).toContain("Pick at least one day");
  });

  it("schedules tasks into sessions greedily by time budget", () => {
    const plan = pace({
      curriculum: sampleCurriculum,
      // Mon (1), Wed (3), Fri (5), 30 min (1800s) sessions
      rhythm: { days: [1, 3, 5], sessionMinutes: 30 },
      startDate: new Date("2026-08-17T00:00:00Z"), // Monday
      timezone: "UTC",
      maxTasksPerDay: 4,
    });

    expect(plan.miniGoals).toHaveLength(2);
    expect(plan.miniGoals[0].title).toBe("Section 1: Basics");
    expect(plan.miniGoals[0].tasks).toHaveLength(3);
    expect(plan.miniGoals[1].title).toBe("Section 2: Advanced");
    expect(plan.miniGoals[1].tasks).toHaveLength(2);
    expect(plan.sessionCount).toBeGreaterThanOrEqual(2);
  });

  it("respects maxTasksPerDay even if time budget permits more", () => {
    const manyShortItems: Curriculum = {
      provider: "web",
      fidelity: "imported",
      title: "Fast Vocabulary",
      sections: [
        {
          title: "Vocab Section",
          items: [
            { kind: "lecture", title: "Word 1", durationSeconds: 60 },
            { kind: "lecture", title: "Word 2", durationSeconds: 60 },
            { kind: "lecture", title: "Word 3", durationSeconds: 60 },
            { kind: "lecture", title: "Word 4", durationSeconds: 60 },
            { kind: "lecture", title: "Word 5", durationSeconds: 60 },
          ],
        },
      ],
      fetchedAt: new Date(),
    };

    const plan = pace({
      curriculum: manyShortItems,
      rhythm: { days: [1, 2, 3, 4, 5], sessionMinutes: 60 },
      startDate: new Date("2026-08-17T00:00:00Z"),
      timezone: "UTC",
      maxTasksPerDay: 2,
    });

    // 5 items with max 2 per day → 3 sessions
    expect(plan.sessionCount).toBe(3);
  });

  it("warns and drops optional items when deadline cannot be met with all items", () => {
    // 2 sections, with an optional item
    const deadline = new Date("2026-08-19T23:59:59Z"); // Wednesday

    const plan = pace({
      curriculum: sampleCurriculum,
      rhythm: { days: [1, 3, 5], sessionMinutes: 15 }, // Very short 15m sessions
      startDate: new Date("2026-08-17T00:00:00Z"), // Mon
      timezone: "UTC",
      deadline,
      maxTasksPerDay: 4,
    });

    expect(plan.warning).toBeDefined();
  });

  // ─── Session packing across section boundaries ──────────────────────────────

  /** N sections of one short item each — the shape a pasted syllabus produces. */
  function oneItemSections(count: number, durationSeconds = 600): Curriculum {
    return {
      provider: "web",
      fidelity: "imported",
      title: "Syllabus",
      sections: Array.from({ length: count }, (_, i) => ({
        title: `Week ${i + 1}`,
        items: [
          { kind: "lecture" as const, title: `Lesson ${i + 1}`, durationSeconds },
        ],
      })),
      fetchedAt: new Date(),
    };
  }

  it("packs multiple sections into one session when the budget allows", () => {
    // 6 sections × 10 min, 60-minute sessions. Packing per section would give
    // 6 sessions (one per day); packing by budget gives 2.
    const plan = pace({
      curriculum: oneItemSections(6),
      rhythm: { days: [1, 3, 5], sessionMinutes: 60 },
      startDate: new Date("2026-08-17T00:00:00Z"), // Monday
      timezone: "UTC",
      maxTasksPerDay: 4,
    });

    expect(plan.sessionCount).toBe(2); // 4 items (maxTasksPerDay) then 2
    expect(plan.miniGoals).toHaveLength(6); // still one mini-goal per section
    // First four land on Monday, the rest on Wednesday.
    const dates = plan.miniGoals.map((mg) => mg.dueDate.toISOString().slice(0, 10));
    expect(dates).toEqual([
      "2026-08-17",
      "2026-08-17",
      "2026-08-17",
      "2026-08-17",
      "2026-08-19",
      "2026-08-19",
    ]);
  });

  it("keeps curriculum order when a session spans a section boundary", () => {
    const plan = pace({
      curriculum: oneItemSections(3),
      rhythm: { days: [1, 2, 3, 4, 5], sessionMinutes: 60 },
      startDate: new Date("2026-08-17T00:00:00Z"),
      timezone: "UTC",
      maxTasksPerDay: 4,
    });

    expect(plan.sessionCount).toBe(1);
    expect(plan.miniGoals.map((mg) => mg.sourceSectionIndex)).toEqual([0, 1, 2]);
    expect(plan.miniGoals.flatMap((mg) => mg.tasks.map((t) => t.title))).toEqual([
      "Lesson 1",
      "Lesson 2",
      "Lesson 3",
    ]);
  });

  it("treats a zero-minute session as a bad input rather than one item per day", () => {
    const plan = pace({
      curriculum: oneItemSections(6, 60),
      rhythm: { days: [1, 2, 3, 4, 5], sessionMinutes: 0 },
      startDate: new Date("2026-08-17T00:00:00Z"),
      timezone: "UTC",
      maxTasksPerDay: 4,
    });

    // Floor of 10 minutes → six 1-minute items fit in two sessions (cap 4/day),
    // not six. A 0 budget would have given every item its own day.
    expect(plan.sessionCount).toBe(2);
  });

  // ─── Warning honesty ────────────────────────────────────────────────────────

  it("does not call a plan late when dropping optional items made it on time", () => {
    const curriculum: Curriculum = {
      provider: "youtube",
      fidelity: "exact",
      title: "T",
      sections: [
        { title: "Core", items: [{ kind: "lecture", title: "a", durationSeconds: 600 }] },
        {
          title: "Extra",
          items: [{ kind: "lecture", title: "b", durationSeconds: 600, optional: true }],
        },
      ],
      fetchedAt: new Date(),
    };

    const plan = pace({
      curriculum,
      rhythm: { days: [1], sessionMinutes: 10 }, // one item per weekly session
      startDate: new Date("2026-08-17T00:00:00Z"), // Monday
      timezone: "UTC",
      deadline: new Date("2026-08-18T00:00:00Z"), // Tuesday — only session 1 fits
      maxTasksPerDay: 4,
    });

    // The returned plan meets the deadline, so the warning must not claim
    // otherwise — it explains the trade, it doesn't report a failure.
    expect(plan.projectedEndDate.getTime()).toBeLessThanOrEqual(
      new Date("2026-08-18T00:00:00Z").getTime()
    );
    expect(plan.warning).toContain("Dropped 1 optional item");
    expect(plan.warning).not.toMatch(/past your deadline/);
  });

  it("suggests the day they would be adding, not one they already work", () => {
    const curriculum = oneItemSections(10);
    const deadline = new Date("2026-08-20T00:00:00Z");
    const base = {
      curriculum,
      startDate: new Date("2026-08-17T00:00:00Z"),
      timezone: "UTC",
      deadline,
      maxTasksPerDay: 1, // force one item per session so the deadline is missed
    };

    expect(pace({ ...base, rhythm: { days: [1], sessionMinutes: 30 } }).warning).toContain(
      "Add a second day"
    );
    expect(
      pace({ ...base, rhythm: { days: [1, 3, 5], sessionMinutes: 30 } }).warning
    ).toContain("Add a fourth day");
    // Already on six days — there is no seventh worth suggesting.
    expect(
      pace({ ...base, rhythm: { days: [1, 2, 3, 4, 5, 6], sessionMinutes: 30 } }).warning
    ).toContain("Move the deadline");
  });
});
