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
});
