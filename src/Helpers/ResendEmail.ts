import { Resend } from "resend";
import "dotenv/config";
import { logError } from "./Helpers.js";
import NotificationPreference from "../models/NotificationPreferences.js";
import { User } from "../models/User.js";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.RESEND_FROM || "Shard <noreply@shard.app>";

// ─── Quiet hours check (mirrors Notifications.ts) ─────────────────

function isQuietHours(preferences: any): boolean {
  if (!preferences.quietHoursEnabled) return false;

  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const start = preferences.quietHoursStart || "22:00";
  const end = preferences.quietHoursEnd || "08:00";

  if (start > end) {
    // Overnight: quiet from e.g. 22:00 → 08:00
    return currentTime >= start || currentTime < end;
  } else {
    // Same-day: quiet from e.g. 09:00 → 17:00
    return currentTime >= start && currentTime < end;
  }
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

function buildTemplate(
  type: string,
  recipientName: string,
  data: TemplateData
): { subject: string; html: string } {
  switch (type) {
    case "friend_request":
      return {
        subject: `${data.actorName} sent you a friend request`,
        html: buildHtml(
          `Friend Request`,
          `<p>Hey <strong>${recipientName}</strong>,</p>
           <p><strong>${data.actorName}</strong> wants to connect with you on Shard.</p>
           <a href="${process.env.SITE_URL}" class="cta">View Request</a>`
        ),
      };

    case "shard_invite":
      return {
        subject: `You've been invited to "${data.shardTitle}"`,
        html: buildHtml(
          `Shard Invitation`,
          `<p>Hey <strong>${recipientName}</strong>,</p>
           <p><strong>${data.actorName}</strong> invited you to join the shard <strong>${data.shardTitle}</strong>.</p>
           <a href="${process.env.SITE_URL}" class="cta">View Invitation</a>`
        ),
      };

    case "shard_update":
      return {
        subject: `Update in "${data.shardTitle}"`,
        html: buildHtml(
          `Shard Update`,
          `<p>Hey <strong>${recipientName}</strong>,</p>
           <p>There's a new update in <strong>${data.shardTitle}</strong>: ${data.message || "Check it out!"}</p>
           <a href="${process.env.SITE_URL}" class="cta">Open Shard</a>`
        ),
      };

    case "quest_deadline":
      return {
        subject: `Deadline approaching: "${data.miniGoalTitle}"`,
        html: buildHtml(
          `Quest Deadline`,
          `<p>Hey <strong>${recipientName}</strong>,</p>
           <p>Your quest <strong>${data.miniGoalTitle}</strong> in <strong>${data.shardTitle}</strong> is due ${data.deadline ? `on <strong>${data.deadline}</strong>` : "soon"}.</p>
           <a href="${process.env.SITE_URL}" class="cta">View Quest</a>`
        ),
      };

    case "message":
      return {
        subject: `New message from ${data.actorName}`,
        html: buildHtml(
          `New Message`,
          `<p>Hey <strong>${recipientName}</strong>,</p>
           <p><strong>${data.actorName}</strong> sent you a message in <strong>${data.shardTitle || "a shard"}</strong>.</p>
           <a href="${process.env.SITE_URL}" class="cta">Read Message</a>`
        ),
      };

    case "achievement":
      return {
        subject: `You unlocked: ${data.achievementName}`,
        html: buildHtml(
          `Achievement Unlocked! 🏆`,
          `<p>Hey <strong>${recipientName}</strong>,</p>
           <p>You just earned the <strong>${data.achievementName}</strong> achievement. Keep it up!</p>
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
      User.findById(userId).select("email username").lean(),
      NotificationPreference.findOne({ userId }).lean(),
    ]);

    if (!user?.email) return;

    // Default preferences treat emailEnabled as false — opt-in only
    if (!preferences || preferences.emailEnabled !== true) return;
    if (!shouldSendEmail(preferences, type)) return;
    if (isQuietHours(preferences)) return;

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
