import "dotenv/config";
import Groq from "groq-sdk";

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

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
  const user = await User.findById(userId, "aiCredits");
  const credits = user?.aiCredits || 0;

  // Pro users have unlimited credits (-1), Free users use credits
  const hasCredits = tier === "pro" || credits > 0;

  return {
    canProceed: hasCredits,
    limit: tier === "pro" ? -1 : credits, // For free users, limit is their current balance
    used: 0, // Not tracking daily usage anymore
    remaining: tier === "pro" ? -1 : credits,
  };
}

/**
 * Track AI usage (deduct credit)
 * @param userId - User ID
 */
export async function trackAIUsage(userId: string): Promise<void> {
  // Decrement credits by 1
  await User.findByIdAndUpdate(userId, {
    $inc: { aiCredits: -1 }
  });
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

If information is missing, make reasonable assumptions.

FORMAT STRICTLY AS JSON:

{
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
 * @returns Parsed quest breakdown
 */
export async function breakDownGoalWithAI(goal: string, deadline?: string): Promise<any> {
  // Prepare the prompt with goal and deadline
  const userPrompt = deadline
    ? `Goal: ${goal}\n\nDeadline: ${deadline}\n\nPlease break this down into a structured quest.`
    : `Goal: ${goal}\n\nPlease break this down into a structured quest.`;

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: QUEST_ARCHITECT_PROMPT,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      temperature: 0.7,
      max_completion_tokens: 8192,
      top_p: 1,
    });

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
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "You are a productivity coach. Provide 3-5 actionable, encouraging tips based on the user's context. Return as a JSON array of strings.",
        },
        {
          role: "user",
          content: context,
        },
      ],
      temperature: 0.7,
      max_completion_tokens: 1024,
      top_p: 1,
    });

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
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: enrichmentPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      temperature: 0.5,
      max_completion_tokens: 4096,
      top_p: 1,
    });

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

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.8,
      max_completion_tokens: 512,
      top_p: 1,
    });

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

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
      max_completion_tokens: 512,
      top_p: 1,
    });

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

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_completion_tokens: 1024,
      top_p: 1,
    });

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
