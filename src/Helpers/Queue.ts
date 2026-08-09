import { sendNotificationToUsers } from './FirebaseMessaging.js';
import SendMail from './SendMail.js';
import { logError } from './Helpers.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Outbound side-effects: push notifications and transactional email.
 *
 * These used to go through a BullMQ queue on Redis. That was removed, because on
 * this deployment the queue made delivery *less* reliable rather than more:
 *
 *  - BullMQ requires `maxmemory-policy noeviction`. The Redis Cloud free plan
 *    runs `volatile-lru` and won't let you change it, so the broker may evict
 *    queued jobs under memory pressure and BullMQ drops them with no error.
 *  - The only things queued were the signup-verification, password-reset and
 *    admin-OTP emails. Those are the worst possible jobs to lose silently: the
 *    user is left unable to verify their account or get back into it, and
 *    nothing anywhere reports a failure.
 *  - A queue buys throughput smoothing and cross-process retry. At one instance
 *    and this volume there is nothing to smooth, and the retry was the part that
 *    couldn't be trusted anyway.
 *
 * So both paths now run inline — which was already the fallback behaviour when
 * Redis was unreachable. The cost is that the three auth mutations await their
 * email (a few hundred ms) instead of returning immediately. That is the right
 * trade: the user is waiting on that email regardless, and a slightly slower
 * signup that reliably sends beats a fast one that silently doesn't.
 *
 * If you ever genuinely need a queue here, put it on a Redis with `noeviction`
 * and reintroduce it deliberately — don't just re-add BullMQ.
 */

/**
 * Send a push notification to a set of users.
 *
 * NOTE: currently unused — Helpers/Notify.ts is the single funnel for user-facing
 * notifications and calls FirebaseMessaging directly, so that budgeting and quiet
 * hours can't be bypassed. Kept because it is the correct low-level primitive;
 * prefer `notify()` for anything a user sees.
 */
export const enqueuePushNotification = async (
  recipientIds: string[],
  payload: any,
  type: string
) => {
  try {
    await sendNotificationToUsers(
      recipientIds,
      payload,
      type as "messages" | "shardInvites" | "shardUpdates" | "questDeadlines" | "friendRequests" | "achievements"
    );
  } catch (err) {
    logError('enqueuePushNotification', err);
  }
};

/**
 * Send a transactional email.
 *
 * Deliberately swallows its error rather than throwing: every caller is in the
 * middle of an auth mutation, and a mail-provider hiccup should not fail a signup
 * that has already written a user. The failure is logged for follow-up.
 */
export const enqueueEmail = async (toEmail: string, subject: string, message: string) => {
  try {
    await SendMail({ recipients: toEmail, subject, message });
  } catch (err) {
    logError('enqueueEmail', err);
  }
};

/**
 * Retained so the shutdown sequence in index.ts keeps a stable shape. There is no
 * longer a queue or worker to close, so this is a no-op.
 */
export async function closeChatQueue(): Promise<void> {
  // no-op — nothing to drain since the BullMQ queue was removed
}
