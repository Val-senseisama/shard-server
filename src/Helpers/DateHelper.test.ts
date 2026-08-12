import { describe, it, expect } from "vitest";
import { smartSchedule, type SchedulableTask } from "./DateHelper.js";

/**
 * Regression cover for the working-day encoding.
 *
 * The client encoded Sunday as 7 while the scheduler matches on
 * `Date.prototype.getDay()`, which only ever returns 0–6. A 7 could therefore
 * never match: selecting Sunday saved successfully and then quietly did
 * nothing. `smartSchedule` now normalises at its single entry point, which
 * repairs already-stored rows as well as new writes without a migration.
 */

const task = (miniGoalIndex: number, taskIndex: number): SchedulableTask => ({
  miniGoalIndex,
  taskIndex,
  title: `task-${miniGoalIndex}-${taskIndex}`,
} as SchedulableTask);

/** A Wednesday, so a Sunday-only week has to advance to find its first slot. */
const WEDNESDAY = new Date("2026-08-12T00:00:00.000Z");

describe("smartSchedule — working day normalisation", () => {
  it("treats a legacy Sunday-as-7 the same as 0", () => {
    const legacy = smartSchedule([[task(0, 0)]], WEDNESDAY, {
      workingDays: [7],
      maxTasksPerDay: 4,
      preferredTaskDuration: "medium",
    });
    const correct = smartSchedule([[task(0, 0)]], WEDNESDAY, {
      workingDays: [0],
      maxTasksPerDay: 4,
      preferredTaskDuration: "medium",
    });

    expect(legacy).toHaveLength(1);
    expect(legacy[0].dueDate.getDay()).toBe(0);
    expect(legacy[0].dueDate.getTime()).toBe(correct[0].dueDate.getTime());
  });

  it("schedules onto Sunday when Sunday is the only working day", () => {
    const [first] = smartSchedule([[task(0, 0)]], WEDNESDAY, {
      workingDays: [0],
      maxTasksPerDay: 4,
      preferredTaskDuration: "medium",
    });

    expect(first.dueDate.getDay()).toBe(0);
  });

  it("never places work on a day outside workingDays", () => {
    const tasks = [[task(0, 0), task(0, 1), task(0, 2), task(0, 3), task(0, 4)]];
    const scheduled = smartSchedule(tasks, WEDNESDAY, {
      workingDays: [0, 6], // weekends only
      maxTasksPerDay: 1,
      preferredTaskDuration: "medium",
    });

    expect(scheduled.length).toBeGreaterThan(0);
    for (const s of scheduled) {
      expect([0, 6]).toContain(s.dueDate.getDay());
    }
  });

  it("falls back to the default week rather than scanning forever on empty input", () => {
    // An all-invalid array would otherwise normalise to [], and `nextWorkingDay`
    // would burn its 14-day scan and return a day nobody asked for.
    const scheduled = smartSchedule([[task(0, 0)]], WEDNESDAY, {
      workingDays: [99],
      maxTasksPerDay: 4,
      preferredTaskDuration: "medium",
    });

    expect(scheduled).toHaveLength(1);
    expect([1, 2, 3, 4, 5]).toContain(scheduled[0].dueDate.getDay());
  });

  it("de-duplicates when a legacy 7 and a 0 are both present", () => {
    const scheduled = smartSchedule([[task(0, 0), task(0, 1)]], WEDNESDAY, {
      workingDays: [0, 7],
      maxTasksPerDay: 1,
      preferredTaskDuration: "medium",
    });

    // Both collapse to Sunday, so with a cap of 1/day these land on
    // consecutive Sundays rather than twice on the same one.
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0].dueDate.getDay()).toBe(0);
    expect(scheduled[1].dueDate.getDay()).toBe(0);
    expect(scheduled[1].dueDate.getTime()).toBeGreaterThan(
      scheduled[0].dueDate.getTime()
    );
  });
});
