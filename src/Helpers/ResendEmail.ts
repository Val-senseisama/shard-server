import { Resend } from "resend";
import "dotenv/config";
import { logError } from "./Helpers.js";
import NotificationPreference from "../models/NotificationPreferences.js";
import { User } from "../models/User.js";
import { currentTimeInZone, isWithinWindow } from "./Timezone.js";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.RESEND_FROM || "Shard <shardsupportzy@zevbii.com>";

// ─── Quiet hours ──────────────────────────────────────────────────
// Uses the shared timezone-aware helper. This file used to carry its own copy
// that compared against SERVER-local time (UTC in production), so "22:00–08:00"
// was silently wrong for every user outside UTC.

function isQuietHours(preferences: any, timezone?: string): boolean {
  if (!preferences?.quietHoursEnabled) return false;
  return isWithinWindow(
    preferences.quietHoursStart || "22:00",
    preferences.quietHoursEnd || "08:00",
    currentTimeInZone(timezone)
  );
}

// ─── Per-type preference gate (mirrors shouldNotify) ──────────────

function shouldSendEmail(preferences: any, type: string): boolean {
  if (preferences.emailEnabled === false) return false;

  switch (type) {
    case "friend_request":
      return preferences.friendRequests !== false;
    case "message":
      return preferences.messages !== false;
    case "shard_invite":
      return preferences.shardInvites !== false;
    case "shard_update":
      return preferences.shardUpdates !== false;
    case "quest_deadline":
      return preferences.questDeadlines !== false;
    case "achievement":
      return preferences.achievements !== false;
    default:
      return true;
  }
}

// ─── HTML templates ────────────────────────────────────────────────

const BASE_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f0f; margin: 0; padding: 0; }
  .wrap { max-width: 560px; margin: 40px auto; background: #1a1a1a; border-radius: 16px; overflow: hidden; border: 1px solid #2a2a2a; }
  .header { background: linear-gradient(135deg, #7c3aed, #6d28d9); padding: 32px 32px 24px; }
  .header h1 { margin: 0; color: #fff; font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
  .header p { margin: 6px 0 0; color: rgba(255,255,255,0.7); font-size: 13px; }
  .body { padding: 28px 32px 32px; color: #e5e5e5; font-size: 15px; line-height: 1.7; }
  .body h2 { color: #a78bfa; margin: 0 0 12px; font-size: 18px; }
  .cta { display: inline-block; margin-top: 20px; padding: 12px 24px; background: #7c3aed; color: #fff; text-decoration: none; border-radius: 10px; font-weight: 700; font-size: 14px; }
  .footer { padding: 16px 32px; border-top: 1px solid #2a2a2a; color: #555; font-size: 12px; text-align: center; }
`;

function buildHtml(subject: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${BASE_STYLE}</style></head><body>
<div class="wrap">
  <div class="header"><h1>Shard</h1><p>Level Up Your Life</p></div>
  <div class="body"><h2>${subject}</h2>${body}</div>
  <div class="footer">You're receiving this because you have a Shard account. <br/>© 2025 Shard. All rights reserved.</div>
</div></body></html>`;
}

type TemplateData = {
  actorName?: string;
  shardTitle?: string;
  miniGoalTitle?: string;
  achievementName?: string;
  message?: string;
  deadline?: string;
};

/**
 * Every caller of `sendEmailToUser` passes `{ message }` and little else, but the
 * templates below interpolate `actorName`, `shardTitle`, `miniGoalTitle` and
 * `achievementName`. Missing fields used to render the literal string
 * "undefined" straight into subject lines ("Deadline approaching:
 * \"undefined\""). These accessors keep a template readable when the caller
 * only had the message text.
 */
const field = (value: string | undefined, fallback: string): string =>
  value && value.trim() ? value : fallback;

/** A subject that degrades to the notification text rather than to "undefined". */
const subjectOr = (parts: { when: string | undefined; then: string; else: string }): string =>
  parts.when && parts.when.trim() ? parts.then : parts.else;

function buildTemplate(
  type: string,
  recipientName: string,
  data: TemplateData
): { subject: string; html: string } {
  switch (type) {
    case "friend_request":
      return {
        subject: subjectOr({ when: data.actorName, then: `${data.actorName} sent you a friend request`, else: "You have a new friend request" }),
        html: buildHtml(
          `Friend Request`,
          `<p>Hey <strong>${recipientName}</strong>,</p>
           <p><strong>${field(data.actorName, "Someone")}</strong> wants to connect with you on Shard.</p>
           <a href="${process.env.SITE_URL}" class="cta">View Request</a>`
        ),
      };

    case "shard_invite":
      return {
        subject: subjectOr({ when: data.shardTitle, then: `You've been invited to "${data.shardTitle}"`, else: "You've been invited to a quest" }),
        html: buildHtml(
          `Shard Invitation`,
          `<p>Hey <strong>${recipientName}</strong>,</p>
           <p><strong>${field(data.actorName, "Someone")}</strong> invited you to join <strong>${field(data.shardTitle, "a quest")}</strong>.</p>
           <a href="${process.env.SITE_URL}" class="cta">View Invitation</a>`
        ),
      };

    case "shard_update":
      return {
        subject: subjectOr({ when: data.shardTitle, then: `Update in "${data.shardTitle}"`, else: field(data.message, "Update on your quest") }),
        html: buildHtml(
          `Shard Update`,
          `<p>Hey <strong>${recipientName}</strong>,</p>
           <p>There's a new update in <strong>${field(data.shardTitle, "one of your quests")}</strong>: ${field(data.message, "Check it out!")}</p>
           <a href="${process.env.SITE_URL}" class="cta">Open Shard</a>`
        ),
      };

    case "quest_deadline":
      return {
        subject: subjectOr({ when: data.miniGoalTitle, then: `Deadline approaching: "${data.miniGoalTitle}"`, else: field(data.message, "A deadline is coming up") }),
        html: buildHtml(
          `Quest Deadline`,
          `<p>Hey <strong>${recipientName}</strong>,</p>
           <p>${data.miniGoalTitle ? `Your goal <strong>${data.miniGoalTitle}</strong>${data.shardTitle ? ` in <strong>${data.shardTitle}</strong>` : ""} is due ${data.deadline ? `on <strong>${data.deadline}</strong>` : "soon"}.` : field(data.message, "You have a deadline coming up.")}</p>
           <a href="${process.env.SITE_URL}" class="cta">View Quest</a>`
        ),
      };

    case "message":
      return {
        subject: subjectOr({ when: data.actorName, then: `New message from ${data.actorName}`, else: "You have a new message" }),
        html: buildHtml(
          `New Message`,
          `<p>Hey <strong>${recipientName}</strong>,</p>
           <p><strong>${field(data.actorName, "Someone")}</strong> sent you a message in <strong>${field(data.shardTitle, "a quest")}</strong>.</p>
           <a href="${process.env.SITE_URL}" class="cta">Read Message</a>`
        ),
      };

    case "achievement":
      return {
        subject: subjectOr({ when: data.achievementName, then: `You unlocked: ${data.achievementName}`, else: "Achievement unlocked" }),
        html: buildHtml(
          `Achievement Unlocked! 🏆`,
          `<p>Hey <strong>${recipientName}</strong>,</p>
           <p>${data.achievementName ? `You just earned the <strong>${data.achievementName}</strong> achievement.` : field(data.message, "You just earned an achievement.")} Keep it up!</p>
           <a href="${process.env.SITE_URL}" class="cta">View Achievements</a>`
        ),
      };

    default:
      return {
        subject: data.message || "Shard Notification",
        html: buildHtml(
          "Notification",
          `<p>Hey <strong>${recipientName}</strong>,</p><p>${data.message || "You have a new notification."}</p>`
        ),
      };
  }
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Send an email to a user if their preferences allow it (emailEnabled,
 * type preference, and quiet hours are all checked).
 */
export async function sendEmailToUser(
  userId: string,
  type: string,
  data: TemplateData = {}
): Promise<void> {
  if (!process.env.RESEND_API_KEY) return;

  try {
    const [user, preferences] = await Promise.all([
      User.findById(userId).select("email username timezone").lean(),
      NotificationPreference.findOne({ userId }).lean(),
    ]);

    if (!user?.email) return;

    // Default preferences treat emailEnabled as false — opt-in only
    if (!preferences || preferences.emailEnabled !== true) return;
    if (!shouldSendEmail(preferences, type)) return;
    if (isQuietHours(preferences, (user as any).timezone)) return;

    const recipientName = (user as any).username || "there";
    const { subject, html } = buildTemplate(type, recipientName, data);

    const { error } = await resend.emails.send({
      from: FROM,
      to: (user as any).email,
      subject,
      html,
    });

    if (error) {
      logError("sendEmailToUser", error);
    }
  } catch (err) {
    logError("sendEmailToUser", err);
  }
}
