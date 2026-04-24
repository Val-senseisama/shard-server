import "dotenv/config";
import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const HEAVY_MODEL = "llama-3.3-70b-versatile";  // full reasoning — quest breakdowns
const LIGHT_MODEL = "llama-3.1-8b-instant";      // fast + cheap — nudges, summaries, tips

// Retry wrapper: retries on 429/5xx with exponential backoff
async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const isRetryable = err?.status === 429 || (err?.status >= 500 && err?.status < 600);
      if (!isRetryable || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastError;
}

import { User } from "../models/User.js";



/**
 * Check if user has sufficient AI credits
 * @param userId - User ID
 * @param tier - User subscription tier (free/pro)
 * @returns Object with limit info and canProceed flag
 */
export async function checkAIUsage(userId: string, tier: "free" | "pro"): Promise<{
  canProceed: boolean;
  limit: number;
  used: number;
  remaining: number;
}> {
  if (tier === "pro") {
    return { canProceed: true, limit: -1, used: 0, remaining: -1 };
  }
  const user = await User.findById(userId, "aiCredits");
  const credits = user?.aiCredits || 0;
  return {
    canProceed: credits > 0,
    limit: credits,
    used: 0,
    remaining: credits,
  };
}

/**
 * Atomically deduct one AI credit. Returns false if no credits remain (TOCTOU-safe).
 */
export async function trackAIUsage(userId: string, tier: "free" | "pro" = "free"): Promise<boolean> {
  if (tier === "pro") return true;

  // Atomic check-and-decrement — prevents race condition where concurrent
  // requests both see credits > 0 and both proceed
  const updated = await User.findOneAndUpdate(
    { _id: userId, aiCredits: { $gt: 0 } },
    { $inc: { aiCredits: -1 } },
    { new: true }
  );

  return !!updated;
}

/**
 * AI Safety Rules - Applied to all AI-generated content
 */
const SAFETY_RULES = `
CRITICAL SAFETY RULES:
- NEVER suggest medical diagnoses, treatments, or health advice
- NEVER provide financial investment advice or legal counsel
- NEVER include adult/NSFW content
- NEVER suggest dangerous activities (extreme sports without safety disclaimers)
- NEVER provide advice on self-harm or suicide - always suggest professional help
- NEVER affirm or reject any religion, belief system, or gender identity
- REMAIN neutral on political, religious, and social issues
- ALWAYS include safety disclaimers for physical activities
- KEEP language professional and appropriate for all ages
- RESPECT all cultures, identities, and backgrounds

If the goal requires professional expertise (health, finance, legal):
- Suggest "consult a professional" as a task
- Provide research/education tasks only
- Do not give specific actionable advice in those domains

If user mentions self-harm or crisis:
- Respond with: "Please reach out to a mental health professional"
- Include crisis hotline: "988 Suicide & Crisis Lifeline (US)"
- Do not generate tasks - suggest professional support only
`;

export interface UserContext {
  username: string;
  bio?: string;
  age?: number;
  timezone?: string;
  level: number;
  currentStreak: number;
  stats: {
    strength: number;
    intelligence: number;
    charisma: number;
    endurance: number;
    creativity: number;
  };
  preferences: {
    workloadLevel: string;
    maxTasksPerDay: number;
    preferredTaskDuration: string;
  };
}

/**
 * Quest breakdown prompt for AI
 */
const QUEST_ARCHITECT_PROMPT = `${SAFETY_RULES}

You are the Quest Architect for Shard, a gamified goal-achievement app.

Your job is to convert a user's real-life goal into:
1️⃣ A main quest (the overall objective)
2️⃣ 3–7 mini-quests (sub-goals)
3️⃣ Each mini-quest must contain exactly 5 actionable steps
4️⃣ Optional side quests for motivation or skill improvement
5️⃣ Rewards (XP) for each step, mini-quest, and overall completion
6️⃣ Realistic timelines/durations for each mini-quest and step

Rules:
- Keep instructions realistic and achievable.
- Break down tasks in chronological order.
- Each step must be <= 20 words, action-focused, and measurable.
- Include suggested timelines based on the goal's deadline if provided.
- Timelines should be in human-readable format (e.g., "2 days", "1 week", "3 hours")
- Support any type of goal (personal, career, fitness, money, etc.)
- Output structured JSON that our app can store and render.

PERSONALIZATION (apply when a user profile is provided):
- Tailor task types to RPG stats: high Strength → physical/action tasks; high Intelligence → research/learning; high Charisma → social/networking; high Endurance → consistency habits; high Creativity → creative/innovative approaches. Stats range 1–100.
- Respect workload preference: "light" = 2–3 simple tasks per mini-quest; "medium" = 4–5 balanced tasks; "aggressive" = push harder with stretch tasks.
- Match difficulty to app level: 1–5 = beginner (simple, guided steps); 6–15 = intermediate (assumes some experience); 16+ = advanced (concise, self-directed steps).
- Mention the user by name in motivationTips to make it feel personal.
- If the user has a bio, use it to make the plan more relevant to their life.

UNREALISTIC GOAL/DEADLINE DETECTION:
- Evaluate whether the goal is genuinely achievable within the deadline.
- If clearly impossible (e.g., "get a PhD in 2 weeks", "lose 30kg in 3 days", "build a profitable startup in 1 day"), set "warning" to a short, friendly explanation and include a realistic suggested timeline. Still generate the full plan.
- If the deadline is very tight but not impossible, set "warning" to acknowledge it and note the intensity required.
- If the goal is vague, silently make it concrete — do not warn for this.
- If there are no issues, set "warning" to null.

FORMAT STRICTLY AS JSON:

{
  "warning": null,
  "mainQuest": {
    "title": "",
    "description": "",
    "deadline": "{{deadline or null}}",
    "estimatedDuration": "3 months",
    "xpReward": 200
  },
  "miniQuests": [
    {
      "title": "",
      "description": "",
      "estimatedDuration": "1 week",
      "xpReward": 100,
      "steps": [
        {"stepNumber": 1, "text": "", "estimatedDuration": "2 hours", "xpReward": 20},
        {"stepNumber": 2, "text": "", "estimatedDuration": "1 day", "xpReward": 20},
        {"stepNumber": 3, "text": "", "estimatedDuration": "3 hours", "xpReward": 20},
        {"stepNumber": 4, "text": "", "estimatedDuration": "2 days", "xpReward": 20},
        {"stepNumber": 5, "text": "", "estimatedDuration": "1 day", "xpReward": 20}
      ]
    }
  ],
  "sideQuests": [
    {
      "title": "",
      "description": "",
      "estimatedDuration": "ongoing",
      "xpReward": 50
    }
  ],
  "motivationTips": [
    ""
  ]
}

Example Goal Input:
"Start a YouTube channel about tech and hit 1000 subscribers within 3 months."`;

/**
 * Call Groq API to break down goals into quests
 * @param goal - User's goal description
 * @param deadline - Optional deadline
 * @param userContext - Optional user profile for personalisation
 * @returns Parsed quest breakdown
 */
export async function breakDownGoalWithAI(goal: string, deadline?: string, userContext?: UserContext): Promise<any> {
  const userProfile = userContext
    ? `\nUser Profile:
- Name: ${userContext.username}${userContext.age ? `\n- Age: ${userContext.age}` : ''}${userContext.bio ? `\n- Bio: ${userContext.bio}` : ''}${userContext.timezone ? `\n- Timezone: ${userContext.timezone}` : ''}
- App Level: ${userContext.level} | Current streak: ${userContext.currentStreak} days
- RPG Stats — Strength: ${userContext.stats.strength}, Intelligence: ${userContext.stats.intelligence}, Charisma: ${userContext.stats.charisma}, Endurance: ${userContext.stats.endurance}, Creativity: ${userContext.stats.creativity}
- Workload preference: ${userContext.preferences.workloadLevel} (max ${userContext.preferences.maxTasksPerDay} tasks/day, preferred task length: ${userContext.preferences.preferredTaskDuration})`
    : '';

  const userPrompt = `Goal: ${goal}${deadline ? `\nDeadline: ${deadline}` : ''}${userProfile}\n\nPlease break this down into a structured quest.`;

  try {
    const completion = await withRetry(() => groq.chat.completions.create({
      model: HEAVY_MODEL,
      messages: [
        { role: "system", content: QUEST_ARCHITECT_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_completion_tokens: 8192,
      top_p: 1,
    }));

    const content = completion.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("No content returned from AI");
    }

    // Extract JSON from the response (in case AI adds extra text)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No valid JSON found in AI response");
    }

    const questBreakdown = JSON.parse(jsonMatch[0]);
    return questBreakdown;
  } catch (error) {
    console.error("AI breakdown error:", error);
    throw new Error("Failed to generate quest breakdown. Please try again.");
  }
}

/**
 * Validate task content for safety
 * Filters out potentially harmful suggestions
 * @param task - Task title/description to validate
 * @returns true if safe, false if unsafe
 */
export function validateTaskSafety(task: string): boolean {
  const flaggedWords = [
    // Medical
    'diagnose', 'prescribe', 'medication', 'medical treatment', 'cure',
    // Financial/Legal
    'invest in', 'buy stocks', 'legal advice', 'lawsuit', 'sue',
    // Self-harm/Crisis
    'kill yourself', 'suicide', 'self-harm', 'end your life',
    // Adult content
    'nsfw', 'porn', 'sexual', 'explicit'
  ];
  
  const lower = task.toLowerCase();
  return !flaggedWords.some(word => lower.includes(word));
}

/**
 * Filter unsafe tasks from AI-generated list
 * @param tasks - Array of tasks to filter
 * @returns Filtered array of safe tasks
 */
export function filterUnsafeTasks(tasks: Array<{ title?: string; text?: string }>): Array<any> {
  return tasks.filter(task => {
    const content = task.title || task.text || '';
    return validateTaskSafety(content);
  });
}

/**
 * Generate AI-powered productivity tips
 */
export async function getProductivityTips(context: string): Promise<string[]> {
  try {
    const completion = await withRetry(() => groq.chat.completions.create({
      model: LIGHT_MODEL,
      messages: [
        { role: "system", content: "You are a productivity coach. Provide 3-5 actionable, encouraging tips based on the user's context. Return as a JSON array of strings." },
        { role: "user", content: context },
      ],
      temperature: 0.7,
      max_completion_tokens: 512,
      top_p: 1,
    }));

    const content = completion.choices?.[0]?.message?.content;

    if (!content) {
      return [];
    }

    // Try to parse as JSON array
    try {
      return JSON.parse(content);
    } catch {
      // If not JSON, split by newlines
      return content.split('\n').filter(line => line.trim());
    }
  } catch (error) {
    console.error("Productivity tips error:", error);
    return [];
  }
}

/**
 * Enrich manual shard with AI-generated rewards and timelines
 * Does NOT break down the shard, only adds metadata
 * @param shardData - Manual shard data (title, description, miniGoals)
 * @param deadline - Optional deadline
 * @returns Enriched shard with rewards and timelines
 */
export async function enrichManualShard(shardData: {
  title: string;
  description: string;
  miniGoals: Array<{ title: string; tasks: Array<{ title: string }> }>;
  deadline?: string;
}): Promise<any> {
  const enrichmentPrompt = `${SAFETY_RULES}

You are the Quest Architect for Shard. 

The user has manually created a quest with mini-goals and tasks. Your job is to:
1. Suggest realistic XP rewards for the main quest, each mini-goal, and each task
2. Estimate realistic timelines/durations for each mini-goal and task
3. DO NOT change or break down the existing structure
4. DO NOT add new mini-goals or tasks

Timelines should be in human-readable format (e.g., "2 days", "1 week", "3 hours")

Return ONLY valid JSON in this exact format:

{
  "mainQuestXP": 200,
  "estimatedDuration": "3 months",
  "miniGoals": [
    {
      "xpReward": 100,
      "estimatedDuration": "1 week",
      "tasks": [
        {"xpReward": 20, "estimatedDuration": "2 hours"},
        {"xpReward": 20, "estimatedDuration": "1 day"}
      ]
    }
  ]
}`;

  const userPrompt = `Quest Title: ${shardData.title}
Description: ${shardData.description}
${shardData.deadline ? `Deadline: ${shardData.deadline}\n` : ''}\nMini-Goals:\n${shardData.miniGoals.map((mg, i) => `${i + 1}. ${mg.title}\n   Tasks: ${mg.tasks.map(t => t.title).join(', ')}`).join('\n')}

Please suggest XP rewards and timelines for this quest structure.`;

  try {
    const completion = await withRetry(() => groq.chat.completions.create({
      model: LIGHT_MODEL,
      messages: [
        { role: "system", content: enrichmentPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.5,
      max_completion_tokens: 2048,
      top_p: 1,
    }));

    const content = completion.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("No content returned from AI");
    }

    // Extract JSON from the response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No valid JSON found in AI response");
    }

    const enrichment = JSON.parse(jsonMatch[0]);
    return enrichment;
  } catch (error) {
    console.error("AI enrichment error:", error);
    // Return default values if AI fails
    return {
      mainQuestXP: 200,
      estimatedDuration: "1 month",
      miniGoals: shardData.miniGoals.map(mg => ({
        xpReward: 100,
        estimatedDuration: "1 week",
        tasks: mg.tasks.map(() => ({
          xpReward: 20,
          estimatedDuration: "1 day",
        })),
      })),
    };
  }
}


/**
 * Generate AI-personalized productivity insights
 * Wraps raw stats into friendly, emoji-rich coach messages
 */
export async function generateProductivityInsights(stats: {
  completionRate: number;
  tasksThisWeek: number;
  streakCount: number;
  struggleAreas: string[];
  weeklyXP: number;
}): Promise<string[]> {
  try {
    const prompt = `You are a friendly productivity coach for a gamified goal app called Shard.

Given these user stats, write 3-5 short, encouraging insight messages (max 90 characters each).
Use emojis. Be specific and personalized. Vary tone between celebratory, motivating, and advisory.

Stats:
- Completion rate: ${stats.completionRate}%
- Tasks completed this week: ${stats.tasksThisWeek}
- Current streak: ${stats.streakCount} days
- Struggle areas: ${stats.struggleAreas.length > 0 ? stats.struggleAreas.join(', ') : 'none'}
- XP earned this week: ${stats.weeklyXP}

Return ONLY a JSON array of strings. No extra text.
Example: ["🔥 You're on a 5-day streak — don't break it now!", "📈 Completion up 12% vs last week!"]`;

    const completion = await withRetry(() => groq.chat.completions.create({
      model: LIGHT_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.8,
      max_completion_tokens: 512,
      top_p: 1,
    }));

    const content = completion.choices?.[0]?.message?.content;
    if (!content) return [];

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const insights = JSON.parse(jsonMatch[0]);
    return Array.isArray(insights) ? insights.slice(0, 5) : [];
  } catch (error) {
    console.error("Productivity insights error:", error);
    return [];
  }
}

/**
 * Generate a reflection side-quest when a shard is completed
 */
export async function generateReflectionMission(shardTitle: string, completionRate: number): Promise<{
  title: string;
  description: string;
  tasks: Array<{ title: string }>;
  xpReward: number;
} | null> {
  try {
    const prompt = `${SAFETY_RULES}

A user just completed their quest "${shardTitle}" at ${completionRate}% completion.
Generate a short reflection side-quest to help them internalize what they learned.

Return ONLY valid JSON:
{
  "title": "Quest Reflection: ...",
  "description": "...",
  "tasks": [
    {"title": "What was your biggest win from this quest?"},
    {"title": "What would you do differently next time?"},
    {"title": "Write down one skill you gained from this quest"}
  ],
  "xpReward": 30
}`;

    const completion = await withRetry(() => groq.chat.completions.create({
      model: LIGHT_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
      max_completion_tokens: 512,
      top_p: 1,
    }));

    const content = completion.choices?.[0]?.message?.content;
    if (!content) return null;

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error("Reflection mission error:", error);
    return null;
  }
}

/**
 * Generate weekly tasks for a mini-goal
 * Creates 3-5 simple, actionable daily tasks for one week
 */
export async function generateWeeklyTasks(
  miniGoalTitle: string,
  miniGoalDescription: string,
  weekNumber: number
): Promise<Array<{ title: string; estimatedTime: string }>> {
  try {
    const prompt = `${SAFETY_RULES}

Generate 3-5 actionable tasks for "${miniGoalTitle}" for week ${weekNumber}.

Context: ${miniGoalDescription || 'No additional context'}

Requirements:
- Each task should be specific and take 30-60 minutes
- Tasks should build progressively (easier to harder)
- Keep tasks simple and clear
- Match the nature of the goal (fitness, creative, business, learning, etc.)

Return ONLY a JSON array in this exact format:
[
  {"title": "Task description", "estimatedTime": "30 min"},
  {"title": "Task description", "estimatedTime": "45 min"}
]

No additional text, just the JSON array.`;

    const completion = await withRetry(() => groq.chat.completions.create({
      model: LIGHT_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_completion_tokens: 1024,
      top_p: 1,
    }));

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content returned from AI");
    }

    // Extract JSON array from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error("No valid JSON array found in AI response");
    }

    const tasks = JSON.parse(jsonMatch[0]);
    
    // Validate and limit to 5 tasks
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error("Invalid tasks format from AI");
    }

    return tasks.slice(0, 5); // Max 5 tasks per week
  } catch (error) {
    console.error("Weekly task generation error:", error);
    // Return default tasks if AI fails
    return [
      { title: `Study ${miniGoalTitle} - Day 1`, estimatedTime: "30 min" },
      { title: `Practice ${miniGoalTitle} exercises`, estimatedTime: "45 min" },
      { title: `Review ${miniGoalTitle} concepts`, estimatedTime: "30 min" },
    ];
  }
}

// ─── AI Quest Coach ────────────────────────────────────────────────────────────

/** Global daily AI call counter — resets at midnight. */
let _aiCoachCallsToday = 0;
let _aiCoachResetDate = new Date().toDateString();

export function canMakeCoachAICall(): boolean {
  const today = new Date().toDateString();
  if (today !== _aiCoachResetDate) {
    _aiCoachCallsToday = 0;
    _aiCoachResetDate = today;
  }
  const cap = parseInt(process.env.AI_COACH_DAILY_CAP || "50", 10);
  return _aiCoachCallsToday < cap;
}

export function incrementCoachAICounter(): void {
  _aiCoachCallsToday++;
}

/** Pre-written fallback templates — zero AI cost. Used for free users or when cap is hit. */
export const COACH_TEMPLATES = {
  inactivity: (shardTitle: string) =>
    `Your quest "${shardTitle}" is waiting for you! Even one small task today keeps the momentum going. 💪`,
  streakBreak: (shardTitle: string) =>
    `Streak reset on "${shardTitle}" — but every champion bounces back. Let's restart! 🔄`,
  milestone: (streak: number) =>
    `🔥 ${streak}-day streak! You're on fire — ready to add a new challenge?`,
};

/**
 * Generate a short inactivity nudge. Max 256 tokens.
 */
export async function generateInactivityNudge(
  shardTitle: string,
  staleDays: number
): Promise<string> {
  try {
    const completion = await withRetry(() => groq.chat.completions.create({
      model: LIGHT_MODEL,
      messages: [{
        role: "user",
        content: `A user hasn't worked on their quest "${shardTitle}" in ${staleDays} days. Write ONE motivational nudge (max 2 sentences, friendly, gamified tone, one emoji). No greetings.`,
      }],
      temperature: 0.8,
      max_completion_tokens: 256,
      top_p: 1,
    }));
    return completion.choices[0]?.message?.content?.trim() || COACH_TEMPLATES.inactivity(shardTitle);
  } catch {
    return COACH_TEMPLATES.inactivity(shardTitle);
  }
}

/**
 * Rewrite incomplete tasks into simpler micro-steps after a streak break.
 * Returns max 5 task title strings.
 */
export async function generateSimplifiedTasks(
  shardTitle: string,
  incompleteTasks: string[]
): Promise<string[]> {
  try {
    const taskList = incompleteTasks.slice(0, 5).join(", ");
    const completion = await withRetry(() => groq.chat.completions.create({
      model: LIGHT_MODEL,
      messages: [{
        role: "user",
        content: `The user lost their streak on "${shardTitle}". Incomplete tasks: ${taskList}. Rewrite as 3–5 simpler micro-tasks (max 10 words each) to help them restart. Return ONLY a JSON array of strings.`,
      }],
      temperature: 0.7,
      max_completion_tokens: 256,
      top_p: 1,
    }));
    const content = completion.choices[0]?.message?.content || "";
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

/**
 * Suggest a bonus stretch goal for a streak milestone.
 */
export async function generateStretchGoal(
  shardTitle: string,
  streak: number
): Promise<string> {
  try {
    const completion = await withRetry(() => groq.chat.completions.create({
      model: LIGHT_MODEL,
      messages: [{
        role: "user",
        content: `User hit a ${streak}-day streak on "${shardTitle}". Suggest ONE exciting bonus challenge they could add (max 15 words, action-oriented). No preamble.`,
      }],
      temperature: 0.8,
      max_completion_tokens: 128,
      top_p: 1,
    }));
    return completion.choices[0]?.message?.content?.trim() || COACH_TEMPLATES.milestone(streak);
  } catch {
    return COACH_TEMPLATES.milestone(streak);
  }
}

/**
 * Generate a real AI summary of a chat's recent messages.
 * Used by the summonSummary mutation.
 */
export async function generateChatSummary(
  messageHistory: string,
  shardTitle?: string,
  shardProgress?: number
): Promise<string> {
  try {
    const completion = await withRetry(() => groq.chat.completions.create({
      model: LIGHT_MODEL,
      messages: [{
        role: "user",
        content: `You are an AI assistant for Shard, a collaborative goal-achievement app.

Analyze this chat conversation from the "${shardTitle || 'shard'}" quest (${shardProgress ?? 0}% complete) and write a concise progress summary.

Focus on:
- Key decisions made
- Progress discussed
- Action items or blockers mentioned
- Team momentum

Chat history (most recent messages):
${messageHistory || '(no messages yet)'}

Write 2-4 sentences in a friendly, motivating tone. Start with a relevant emoji. Be specific about what was discussed — never generic.`,
      }],
      temperature: 0.6,
      max_completion_tokens: 256,
      top_p: 1,
    }));

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) throw new Error("No content");
    return content;
  } catch (error) {
    console.error("Chat summary generation error:", error);
    return `📊 Summary for "${shardTitle || 'this shard'}": Your team has been active. ${shardProgress ? `You're ${shardProgress}% of the way there —` : ''} keep the momentum going! 💪`;
  }
}
