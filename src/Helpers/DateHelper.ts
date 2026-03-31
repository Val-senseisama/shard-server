/**
 * Smart Task Scheduling
 *
 * Schedules tasks onto working days respecting:
 * - User's working days (e.g. Mon–Fri)
 * - Max tasks per day
 * - Task order within each mini-goal (sequential, never scrambled)
 * - Related/prerequisite tasks stay on same or adjacent days
 * - Never stretches unnecessarily — packs tightly from start date
 */

export interface UserSchedulePrefs {
  workingDays: number[];          // 0=Sun … 6=Sat — default [1,2,3,4,5]
  maxTasksPerDay: number;         // default 4
  preferredTaskDuration: 'short' | 'medium' | 'long'; // affects tasks-per-day cap
}

export interface SchedulableTask {
  miniGoalIndex: number;
  taskIndex: number;
  title: string;
  existing?: boolean;             // already has a dueDate
  existingDate?: Date;
}

export interface ScheduledTask {
  miniGoalIndex: number;
  taskIndex: number;
  dueDate: Date;
}

const DEFAULT_PREFS: UserSchedulePrefs = {
  workingDays: [1, 2, 3, 4, 5],
  maxTasksPerDay: 4,
  preferredTaskDuration: 'medium',
};

/**
 * Get effective max tasks per day based on preferred duration.
 * short tasks → user can handle more per day
 * long tasks → fewer per day
 */
function effectiveMaxTasks(prefs: UserSchedulePrefs): number {
  const base = prefs.maxTasksPerDay;
  switch (prefs.preferredTaskDuration) {
    case 'short':  return Math.min(base + 2, 10);
    case 'long':   return Math.max(base - 1, 1);
    default:       return base;
  }
}

/**
 * Advance a date to the next working day (inclusive).
 * If `date` already falls on a working day, returns it unchanged.
 */
function nextWorkingDay(date: Date, workingDays: number[]): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0); // normalise to start of day (date only, no time)
  for (let i = 0; i < 14; i++) { // max 2-week scan
    if (workingDays.includes(d.getDay())) return d;
    d.setDate(d.getDate() + 1);
  }
  return d; // fallback — shouldn't happen
}

/**
 * Get the next working day strictly after `date`.
 */
function followingWorkingDay(date: Date, workingDays: number[]): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  return nextWorkingDay(next, workingDays);
}

/**
 * Smart-schedule an ordered list of tasks onto calendar days.
 *
 * Tasks are provided grouped by mini-goal (already ordered).
 * The scheduler assigns dates so that:
 *  1. Tasks within one mini-goal are on the same or consecutive working days
 *  2. A new mini-goal starts on the day after the previous one finishes
 *  3. No day exceeds maxTasksPerDay
 *  4. Only working days are used
 *  5. An optional hard deadline caps the end date
 */
export function smartSchedule(
  tasksByGoal: SchedulableTask[][],
  startDate: Date,
  prefs: Partial<UserSchedulePrefs> = {},
  deadline?: Date,
): ScheduledTask[] {
  const p: UserSchedulePrefs = { ...DEFAULT_PREFS, ...prefs };
  const maxPerDay = effectiveMaxTasks(p);
  const results: ScheduledTask[] = [];

  let currentDay = nextWorkingDay(startDate, p.workingDays);
  let slotsUsedToday = 0;

  for (const goalTasks of tasksByGoal) {
    for (const task of goalTasks) {
      // If this task already has a date, keep it
      if (task.existing && task.existingDate) {
        results.push({
          miniGoalIndex: task.miniGoalIndex,
          taskIndex: task.taskIndex,
          dueDate: task.existingDate,
        });
        continue;
      }

      // If today is full, advance to next working day
      if (slotsUsedToday >= maxPerDay) {
        currentDay = followingWorkingDay(currentDay, p.workingDays);
        slotsUsedToday = 0;
      }

      // Cap at deadline if provided
      let assignDate = new Date(currentDay);
      if (deadline && assignDate > deadline) {
        assignDate = new Date(deadline);
      }

      results.push({
        miniGoalIndex: task.miniGoalIndex,
        taskIndex: task.taskIndex,
        dueDate: assignDate,
      });
      slotsUsedToday++;
    }

    // After finishing a mini-goal, advance to next working day
    // so the next goal starts fresh (unless we're still on the same goal)
    if (goalTasks.length > 0) {
      currentDay = followingWorkingDay(currentDay, p.workingDays);
      slotsUsedToday = 0;
    }
  }

  return results;
}

// ─── Legacy helpers (kept for backward compat) ──────────────────────

export function parseDurationToMs(duration: string): number {
  const match = duration.match(/(\d+)\s*(hour|day|week|month|year|minute)s?/i);
  if (!match) return 24 * 60 * 60 * 1000;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  const msMap: Record<string, number> = {
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
  };

  return value * (msMap[unit] || msMap.day);
}

export function calculateDueDate(startDate: Date, duration: string): Date {
  const ms = parseDurationToMs(duration);
  return new Date(startDate.getTime() + ms);
}

export function distributeDatesEvenly(
  startDate: Date,
  endDate: Date,
  count: number,
): Date[] {
  const totalMs = endDate.getTime() - startDate.getTime();
  const intervalMs = totalMs / count;
  return Array.from({ length: count }, (_, i) =>
    new Date(startDate.getTime() + intervalMs * (i + 1)),
  );
}
