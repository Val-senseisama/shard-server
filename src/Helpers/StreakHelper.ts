import { User } from "../models/User.js";

/**
 * Update user's streak when they complete a task
 * Call this after task completion
 */
export async function updateStreak(userId: string): Promise<void> {
  const user = await User.findById(userId);
  if (!user) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0); // Start of today

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  // Check last completion date
  if (!user.lastCompletionDate) {
    // First ever completion
    user.currentStreak = 1;
    user.longestStreak = 1;
    user.lastCompletionDate = today;
  } else {
    const lastDate = new Date(user.lastCompletionDate);
    lastDate.setHours(0, 0, 0, 0);

    if (lastDate.getTime() === yesterday.getTime()) {
      // Completed yesterday - continue streak
      user.currentStreak++;
      user.lastCompletionDate = today;
      
      // Update longest if needed
      if (user.currentStreak > user.longestStreak) {
        user.longestStreak = user.currentStreak;
      }
    } else if (lastDate.getTime() === today.getTime()) {
      // Already completed today - no change
      return;
    } else {
      // Streak broken - reset to 1
      user.currentStreak = 1;
      user.lastCompletionDate = today;
    }
  }

  // Also update legacy streaks field for backward compatibility
  user.streaks = user.currentStreak;

  await user.save();
}

/**
 * Check if mini-goal completed early and calculate bonus
 */
export function calculateEarlyCompletionBonus(
  dueDate: Date | undefined,
  completedDate: Date
): { isEarly: boolean; daysEarly: number; bonusXP: number } {
  if (!dueDate) {
    return { isEarly: false, daysEarly: 0, bonusXP: 0 };
  }

  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  
  const completed = new Date(completedDate);
  completed.setHours(0, 0, 0, 0);

  const diffTime = due.getTime() - completed.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays > 0) {
    // Completed early! 5 XP bonus per day
    return {
      isEarly: true,
      daysEarly: diffDays,
      bonusXP: diffDays * 5
    };
  }

  return { isEarly: false, daysEarly: 0, bonusXP: 0 };
}
