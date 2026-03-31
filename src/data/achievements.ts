/**
 * Achievement registry — all achievements are defined here.
 * Stored as IDs in User.achievements[]. The registry is the source of truth
 * for names, descriptions, icons and unlock conditions.
 *
 * Categories:
 *   xp       – XP / level milestones
 *   streak   – daily streak milestones
 *   social   – friends / collaboration
 *   shard    – shard creation / completion
 *   quest    – task / mini-goal completion counts
 *   special  – one-off moments
 */

export type AchievementRarity = "common" | "rare" | "epic" | "legendary";
export type AchievementCategory = "xp" | "streak" | "social" | "shard" | "quest" | "special";

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;           // emoji
  category: AchievementCategory;
  rarity: AchievementRarity;
  /** Which user stat to check and what threshold triggers the unlock */
  condition: {
    stat: keyof UserStats;
    threshold: number;
  };
}

/** The subset of user stats we evaluate achievements against */
export interface UserStats {
  xp: number;
  level: number;
  currentStreak: number;
  longestStreak: number;
  friendCount: number;
  shardsCreated: number;
  shardsCompleted: number;
  tasksCompleted: number;
  miniGoalsCompleted: number;
  collaborationsJoined: number;
}

export const ACHIEVEMENTS: Achievement[] = [
  // ─── XP milestones ──────────────────────────────────────────────
  {
    id: "xp_100",
    name: "First Steps",
    description: "Earn your first 100 XP.",
    icon: "⭐",
    category: "xp",
    rarity: "common",
    condition: { stat: "xp", threshold: 100 },
  },
  {
    id: "xp_500",
    name: "Getting Started",
    description: "Earn 500 XP total.",
    icon: "🌟",
    category: "xp",
    rarity: "common",
    condition: { stat: "xp", threshold: 500 },
  },
  {
    id: "xp_1000",
    name: "On the Path",
    description: "Earn 1,000 XP.",
    icon: "✨",
    category: "xp",
    rarity: "common",
    condition: { stat: "xp", threshold: 1000 },
  },
  {
    id: "xp_5000",
    name: "Committed",
    description: "Earn 5,000 XP.",
    icon: "💫",
    category: "xp",
    rarity: "rare",
    condition: { stat: "xp", threshold: 5000 },
  },
  {
    id: "xp_10000",
    name: "Dedicated",
    description: "Earn 10,000 XP.",
    icon: "🔥",
    category: "xp",
    rarity: "rare",
    condition: { stat: "xp", threshold: 10000 },
  },
  {
    id: "xp_50000",
    name: "Unstoppable",
    description: "Earn 50,000 XP.",
    icon: "⚡",
    category: "xp",
    rarity: "epic",
    condition: { stat: "xp", threshold: 50000 },
  },
  {
    id: "xp_100000",
    name: "Legend",
    description: "Earn 100,000 XP.",
    icon: "🏆",
    category: "xp",
    rarity: "legendary",
    condition: { stat: "xp", threshold: 100000 },
  },

  // ─── Level milestones ───────────────────────────────────────────
  {
    id: "level_5",
    name: "Rising",
    description: "Reach level 5.",
    icon: "📈",
    category: "xp",
    rarity: "common",
    condition: { stat: "level", threshold: 5 },
  },
  {
    id: "level_10",
    name: "Double Digits",
    description: "Reach level 10.",
    icon: "🎯",
    category: "xp",
    rarity: "common",
    condition: { stat: "level", threshold: 10 },
  },
  {
    id: "level_25",
    name: "Veteran",
    description: "Reach level 25.",
    icon: "🛡️",
    category: "xp",
    rarity: "rare",
    condition: { stat: "level", threshold: 25 },
  },
  {
    id: "level_50",
    name: "Elite",
    description: "Reach level 50.",
    icon: "💎",
    category: "xp",
    rarity: "epic",
    condition: { stat: "level", threshold: 50 },
  },
  {
    id: "level_100",
    name: "Ascended",
    description: "Reach level 100.",
    icon: "👑",
    category: "xp",
    rarity: "legendary",
    condition: { stat: "level", threshold: 100 },
  },

  // ─── Streak milestones ──────────────────────────────────────────
  {
    id: "streak_3",
    name: "Habit Forming",
    description: "Keep a 3-day streak.",
    icon: "🔥",
    category: "streak",
    rarity: "common",
    condition: { stat: "currentStreak", threshold: 3 },
  },
  {
    id: "streak_7",
    name: "Week Warrior",
    description: "Keep a 7-day streak.",
    icon: "📅",
    category: "streak",
    rarity: "common",
    condition: { stat: "currentStreak", threshold: 7 },
  },
  {
    id: "streak_14",
    name: "Two Weeks Strong",
    description: "Keep a 14-day streak.",
    icon: "💪",
    category: "streak",
    rarity: "rare",
    condition: { stat: "currentStreak", threshold: 14 },
  },
  {
    id: "streak_30",
    name: "Monthly Grinder",
    description: "Keep a 30-day streak.",
    icon: "🗓️",
    category: "streak",
    rarity: "rare",
    condition: { stat: "currentStreak", threshold: 30 },
  },
  {
    id: "streak_60",
    name: "Relentless",
    description: "Keep a 60-day streak.",
    icon: "⚔️",
    category: "streak",
    rarity: "epic",
    condition: { stat: "currentStreak", threshold: 60 },
  },
  {
    id: "streak_100",
    name: "Century",
    description: "Keep a 100-day streak.",
    icon: "🌋",
    category: "streak",
    rarity: "epic",
    condition: { stat: "currentStreak", threshold: 100 },
  },
  {
    id: "streak_365",
    name: "Year of Discipline",
    description: "Keep a 365-day streak.",
    icon: "🌠",
    category: "streak",
    rarity: "legendary",
    condition: { stat: "currentStreak", threshold: 365 },
  },
  // Best-ever streak
  {
    id: "longest_streak_30",
    name: "Best Month Ever",
    description: "Achieve a longest streak of 30 days.",
    icon: "🏅",
    category: "streak",
    rarity: "rare",
    condition: { stat: "longestStreak", threshold: 30 },
  },

  // ─── Social milestones ──────────────────────────────────────────
  {
    id: "friends_1",
    name: "Not Alone",
    description: "Add your first friend.",
    icon: "🤝",
    category: "social",
    rarity: "common",
    condition: { stat: "friendCount", threshold: 1 },
  },
  {
    id: "friends_5",
    name: "Squad Up",
    description: "Have 5 friends.",
    icon: "👥",
    category: "social",
    rarity: "common",
    condition: { stat: "friendCount", threshold: 5 },
  },
  {
    id: "friends_10",
    name: "Social Butterfly",
    description: "Have 10 friends.",
    icon: "🦋",
    category: "social",
    rarity: "rare",
    condition: { stat: "friendCount", threshold: 10 },
  },
  {
    id: "friends_25",
    name: "Networker",
    description: "Have 25 friends.",
    icon: "🌐",
    category: "social",
    rarity: "epic",
    condition: { stat: "friendCount", threshold: 25 },
  },
  {
    id: "collab_1",
    name: "Team Player",
    description: "Join your first collaborative shard.",
    icon: "🤜",
    category: "social",
    rarity: "common",
    condition: { stat: "collaborationsJoined", threshold: 1 },
  },
  {
    id: "collab_5",
    name: "Collaborator",
    description: "Join 5 collaborative shards.",
    icon: "🧩",
    category: "social",
    rarity: "rare",
    condition: { stat: "collaborationsJoined", threshold: 5 },
  },

  // ─── Shard milestones ───────────────────────────────────────────
  {
    id: "shard_created_1",
    name: "First Shard",
    description: "Create your first shard.",
    icon: "💠",
    category: "shard",
    rarity: "common",
    condition: { stat: "shardsCreated", threshold: 1 },
  },
  {
    id: "shard_created_5",
    name: "Goal Setter",
    description: "Create 5 shards.",
    icon: "🎯",
    category: "shard",
    rarity: "common",
    condition: { stat: "shardsCreated", threshold: 5 },
  },
  {
    id: "shard_created_10",
    name: "Architect",
    description: "Create 10 shards.",
    icon: "🏗️",
    category: "shard",
    rarity: "rare",
    condition: { stat: "shardsCreated", threshold: 10 },
  },
  {
    id: "shard_created_25",
    name: "Visionary",
    description: "Create 25 shards.",
    icon: "🔭",
    category: "shard",
    rarity: "epic",
    condition: { stat: "shardsCreated", threshold: 25 },
  },
  {
    id: "shard_completed_1",
    name: "Finisher",
    description: "Complete your first shard.",
    icon: "✅",
    category: "shard",
    rarity: "common",
    condition: { stat: "shardsCompleted", threshold: 1 },
  },
  {
    id: "shard_completed_3",
    name: "Achiever",
    description: "Complete 3 shards.",
    icon: "🎖️",
    category: "shard",
    rarity: "rare",
    condition: { stat: "shardsCompleted", threshold: 3 },
  },
  {
    id: "shard_completed_10",
    name: "Master of Goals",
    description: "Complete 10 shards.",
    icon: "🏆",
    category: "shard",
    rarity: "epic",
    condition: { stat: "shardsCompleted", threshold: 10 },
  },
  {
    id: "shard_completed_25",
    name: "The Completer",
    description: "Complete 25 shards.",
    icon: "🌟",
    category: "shard",
    rarity: "legendary",
    condition: { stat: "shardsCompleted", threshold: 25 },
  },

  // ─── Task / Quest milestones ────────────────────────────────────
  {
    id: "tasks_1",
    name: "First Win",
    description: "Complete your first task.",
    icon: "☑️",
    category: "quest",
    rarity: "common",
    condition: { stat: "tasksCompleted", threshold: 1 },
  },
  {
    id: "tasks_10",
    name: "Getting Things Done",
    description: "Complete 10 tasks.",
    icon: "📝",
    category: "quest",
    rarity: "common",
    condition: { stat: "tasksCompleted", threshold: 10 },
  },
  {
    id: "tasks_50",
    name: "Productive",
    description: "Complete 50 tasks.",
    icon: "⚙️",
    category: "quest",
    rarity: "rare",
    condition: { stat: "tasksCompleted", threshold: 50 },
  },
  {
    id: "tasks_100",
    name: "Century Club",
    description: "Complete 100 tasks.",
    icon: "💯",
    category: "quest",
    rarity: "rare",
    condition: { stat: "tasksCompleted", threshold: 100 },
  },
  {
    id: "tasks_500",
    name: "Machine",
    description: "Complete 500 tasks.",
    icon: "🤖",
    category: "quest",
    rarity: "epic",
    condition: { stat: "tasksCompleted", threshold: 500 },
  },
  {
    id: "tasks_1000",
    name: "Thousand Task Titan",
    description: "Complete 1,000 tasks.",
    icon: "🦾",
    category: "quest",
    rarity: "legendary",
    condition: { stat: "tasksCompleted", threshold: 1000 },
  },
  {
    id: "minigoals_1",
    name: "Quest Complete",
    description: "Complete your first quest.",
    icon: "🗺️",
    category: "quest",
    rarity: "common",
    condition: { stat: "miniGoalsCompleted", threshold: 1 },
  },
  {
    id: "minigoals_10",
    name: "Quest Hunter",
    description: "Complete 10 quests.",
    icon: "🎪",
    category: "quest",
    rarity: "rare",
    condition: { stat: "miniGoalsCompleted", threshold: 10 },
  },
  {
    id: "minigoals_50",
    name: "Epic Questor",
    description: "Complete 50 quests.",
    icon: "⚔️",
    category: "quest",
    rarity: "epic",
    condition: { stat: "miniGoalsCompleted", threshold: 50 },
  },
];

/** Fast O(1) lookup by id */
export const ACHIEVEMENT_MAP = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
