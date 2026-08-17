/**
 * Chat push coalescing.
 *
 * Chat is the one notification type with no budget — `kind: "message"` is
 * transactional, so `notify()` deliberately lets every message through. That is
 * right for a single message and wrong for a conversation: an active group shard
 * sending twenty messages in a minute meant twenty pushes, twenty buzzes and
 * twenty rows in the bell, which is precisely how a user ends up turning
 * notifications off entirely — and a user with push disabled is the hardest kind
 * to bring back.
 *
 * The rule here is: the FIRST message in a conversation reaches you immediately,
 * and anything that lands in the next window is folded into one summary. Chat is
 * latency-sensitive, so nothing is ever delayed just to see whether more will
 * arrive — the delay only ever applies to messages that were already going to be
 * redundant.
 *
 * Mentions bypass the fold entirely. Being named is a different signal from the
 * room being busy.
 *
 * State is in-process. With several server instances a user's bundle can split
 * across them, which costs an extra push — never a lost one. Redis is the fix if
 * that becomes visible; a timer has to live in a process either way.
 */

import { notify, type NotifyResult } from "./Notify.js";
import { logError } from "./Helpers.js";

/**
 * How long one push suppresses the next for the same (user, chat).
 *
 * 45s is roughly a conversational turn: long enough to fold a burst of rapid
 * messages, short enough that a reply arriving after a genuine pause still feels
 * immediate.
 */
export const BUNDLE_WINDOW_MS = 45_000;

/** Trim the map when it has clearly outgrown the live conversations. */
const SWEEP_THRESHOLD = 5_000;
const STALE_AFTER_MS = BUNDLE_WINDOW_MS * 10;

interface BundleState {
  /** When we last actually pushed for this (user, chat). */
  lastPushAt: number;
  /** Messages folded in since then. */
  pending: number;
  /** Distinct senders in the pending set, in arrival order. */
  senders: string[];
  /** Most recent message preview — what the summary shows if there's only one. */
  latestPreview: string;
  /** Pending flush, if one is scheduled. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Deep-link payload to attach to the summary. */
  data: Record<string, string>;
  /** Group chat name, when the chat has one. */
  chatName?: string;
}

const bundles = new Map<string, BundleState>();

const keyFor = (userId: string, chatId: string) => `${userId}:${chatId}`;

/** Tray grouping key — one live notification per chat, per device. */
const collapseKeyFor = (chatId: string) => `chat:${chatId}`;

function sweep() {
  if (bundles.size <= SWEEP_THRESHOLD) return;
  const now = Date.now();
  for (const [key, state] of bundles) {
    if (!state.timer && now - state.lastPushAt > STALE_AFTER_MS) bundles.delete(key);
  }
}

export interface ChatMessagePushInput {
  /** Recipients, already filtered for senders and for anyone actively viewing. */
  userIds: string[];
  /** The chat document's own id — NOT the shard id. */
  chatId: string;
  senderName: string;
  /** Raw message content; truncated here so callers don't each do it differently. */
  preview: string;
  /** Group/shard chat name, when there is one. Absent for direct chats. */
  chatName?: string;
  /** Deep-link payload merged into the push data. */
  data?: Record<string, string>;
  /**
   * A mention delivers immediately and is never folded into a summary, but still
   * resets the window so the same message doesn't also arrive as a generic
   * "new message" moments later.
   */
  isMention?: boolean;
}

/** One-line preview, sized for a notification body. */
function truncate(text: string, max: number): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "Sent an attachment";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Title and body for a fold of `pending` messages.
 *
 * Reads as a summary of what the user missed rather than a copy of the last
 * message — "4 new messages" is the useful fact; the newest line is context.
 */
function summaryCopy(state: BundleState): { title: string; body: string } {
  const { pending, senders, chatName, latestPreview } = state;
  const uniqueSenders = [...new Set(senders)];

  const title = chatName
    ? `${pending} new messages in ${chatName}`
    : `${pending} new messages from ${uniqueSenders[0] ?? "Someone"}`;

  // In a group, who is talking matters more than what the newest line says.
  const body =
    uniqueSenders.length > 1
      ? `${uniqueSenders.slice(0, 3).join(", ")}${
          uniqueSenders.length > 3 ? ` and ${uniqueSenders.length - 3} others` : ""
        }`
      : `${uniqueSenders[0] ?? "Someone"}: ${latestPreview}`;

  return { title, body };
}

function flush(userId: string, chatId: string): void {
  const key = keyFor(userId, chatId);
  const state = bundles.get(key);
  if (!state) return;

  state.timer = null;
  if (state.pending === 0) return;

  const { title, body } = summaryCopy(state);

  state.lastPushAt = Date.now();
  state.pending = 0;
  state.senders = [];

  notify({
    userId,
    kind: "message",
    title,
    body,
    data: state.data,
    collapseKey: collapseKeyFor(chatId),
    // Chat is per-conversation, not per-day: the daily dedupe default would
    // collapse every conversation a user has into a single notification.
    dedupeKey: null,
  }).catch((e) => logError("notifyChatMessage:flush", e));
}

/**
 * Push a chat message to recipients, folding bursts into one notification.
 *
 * Fire-and-forget: a notification must never fail the send that triggered it.
 */
export function notifyChatMessage(input: ChatMessagePushInput): void {
  const {
    userIds,
    chatId,
    senderName,
    chatName,
    isMention = false,
  } = input;
  if (userIds.length === 0) return;

  const preview = truncate(input.preview, 120);
  const now = Date.now();
  const data = {
    ...(input.data ?? {}),
    chatId,
    ...(isMention ? { isMention: "true" } : {}),
  };

  sweep();

  for (const userId of [...new Set(userIds)]) {
    const key = keyFor(userId, chatId);
    let state = bundles.get(key);

    if (!state) {
      state = {
        lastPushAt: 0,
        pending: 0,
        senders: [],
        latestPreview: preview,
        timer: null,
        data,
        chatName,
      };
      bundles.set(key, state);
    }

    // Keep the deep-link and preview current so a flush describes the newest
    // message rather than whichever one opened the window.
    state.latestPreview = preview;
    state.data = data;
    state.chatName = chatName;

    const windowOpen = now - state.lastPushAt < BUNDLE_WINDOW_MS;

    if (!windowOpen || isMention) {
      // Deliver now. A mention that interrupts an open window also absorbs
      // whatever was pending — the user is about to open the chat anyway, and
      // a summary arriving seconds later would be noise.
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      state.pending = 0;
      state.senders = [];
      state.lastPushAt = now;

      const push: Promise<NotifyResult> = notify({
        userId,
        kind: "message",
        title: isMention
          ? `@${senderName} mentioned you`
          : chatName
            ? `${senderName} in ${chatName}`
            : `New message from ${senderName}`,
        body: preview,
        data,
        emailData: { actorName: senderName },
        collapseKey: collapseKeyFor(chatId),
        dedupeKey: null,
      });
      push.catch((e) => logError("notifyChatMessage", e));
      continue;
    }

    // Inside the window — fold, and make sure a flush is scheduled for the
    // moment it closes.
    state.pending += 1;
    state.senders.push(senderName);

    if (!state.timer) {
      const delay = Math.max(0, state.lastPushAt + BUNDLE_WINDOW_MS - now);
      state.timer = setTimeout(() => flush(userId, chatId), delay);
      // A pending summary must never hold the process open on shutdown.
      state.timer.unref?.();
    }
  }
}

/** Test seam — drops all pending bundles and their timers. */
export function __resetMessagePushState(): void {
  for (const state of bundles.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  bundles.clear();
}
