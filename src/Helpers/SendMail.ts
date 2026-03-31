import { Resend } from "resend";
import "dotenv/config";
import { logError } from "./Helpers.js";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.RESEND_FROM || "Shard <noreply@shard.app>";

const emailTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>[subject]</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f0f; margin: 0; padding: 0; }
    .wrap { max-width: 560px; margin: 40px auto; background: #1a1a1a; border-radius: 16px; overflow: hidden; border: 1px solid #2a2a2a; }
    .header { background: linear-gradient(135deg, #7c3aed, #6d28d9); padding: 32px 32px 24px; }
    .header h1 { margin: 0; color: #fff; font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
    .header p { margin: 6px 0 0; color: rgba(255,255,255,0.7); font-size: 13px; }
    .body { padding: 28px 32px 32px; color: #e5e5e5; font-size: 15px; line-height: 1.7; }
    .body h2 { color: #a78bfa; margin: 0 0 12px; font-size: 18px; }
    .footer { padding: 16px 32px; border-top: 1px solid #2a2a2a; color: #555; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header"><h1>Shard</h1><p>Level Up Your Life</p></div>
    <div class="body"><h2>[subject]</h2><p>[message]</p></div>
    <div class="footer">© 2025 Shard. All rights reserved.<br/>You're receiving this because you have a Shard account.</div>
  </div>
</body>
</html>`;

type MailInput = {
  recipients: string;
  subject: string;
  message: string;
};

async function SendMail(input: MailInput): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) {
    console.warn("⚠️ RESEND_API_KEY not set — skipping email");
    return false;
  }

  const html = emailTemplate
    .replace(/\[subject\]/g, input.subject)
    .replace(/\[message\]/g, input.message);

  const { error } = await resend.emails.send({
    from: FROM,
    to: input.recipients,
    subject: input.subject,
    html,
  });

  if (error) {
    logError("SendMail", error);
    return false;
  }

  return true;
}

export default SendMail;
