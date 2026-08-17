import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const notify = vi.fn(async () => ({ delivered: true, recorded: true }));

vi.mock("./Notify.js", () => ({ notify: (...args: any[]) => notify(...args) }));
vi.mock("./Helpers.js", () => ({ logError: vi.fn() }));

import {
  notifyChatMessage,
  __resetMessagePushState,
  BUNDLE_WINDOW_MS,
} from "./MessagePush.js";

const send = (over: Partial<Parameters<typeof notifyChatMessage>[0]> = {}) =>
  notifyChatMessage({
    userIds: ["u1"],
    chatId: "c1",
    senderName: "alice",
    preview: "hello there",
    ...over,
  });

/** Every notify() call made for a given user. */
const callsFor = (userId: string) =>
  notify.mock.calls.map((c) => c[0] as any).filter((a) => a.userId === userId);

beforeEach(() => {
  vi.useFakeTimers();
  notify.mockClear();
  __resetMessagePushState();
});

afterEach(() => {
  __resetMessagePushState();
  vi.useRealTimers();
});

describe("chat push coalescing", () => {
  it("delivers the first message immediately", () => {
    send();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(callsFor("u1")[0]).toMatchObject({
      kind: "message",
      title: "New message from alice",
      body: "hello there",
      // Per-conversation, never per-day: the default dedupe would collapse
      // every chat a user has into one notification.
      dedupeKey: null,
      collapseKey: "chat:c1",
    });
  });

  it("folds a burst into one summary instead of one push per message", () => {
    send();
    expect(notify).toHaveBeenCalledTimes(1);

    // Four more inside the window — none of these should buzz.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(1_000);
      send({ preview: `message ${i}` });
    }
    expect(notify).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(BUNDLE_WINDOW_MS);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(callsFor("u1")[1]).toMatchObject({
      title: "4 new messages from alice",
      body: "alice: message 3",
    });
  });

  it("names the group and its speakers when a shard chat gets busy", () => {
    send({ chatName: "Ship the app", userIds: ["u1"] });
    vi.advanceTimersByTime(1_000);
    send({ chatName: "Ship the app", senderName: "bob" });
    vi.advanceTimersByTime(1_000);
    send({ chatName: "Ship the app", senderName: "carol" });

    vi.advanceTimersByTime(BUNDLE_WINDOW_MS);

    expect(callsFor("u1")[1]).toMatchObject({
      title: "2 new messages in Ship the app",
      body: "bob, carol",
    });
  });

  it("delivers again once the window has passed", () => {
    send();
    vi.advanceTimersByTime(BUNDLE_WINDOW_MS + 1);
    send({ preview: "second wave" });

    expect(notify).toHaveBeenCalledTimes(2);
    expect(callsFor("u1")[1]).toMatchObject({
      title: "New message from alice",
      body: "second wave",
    });
  });

  it("lets a mention cut through an open window", () => {
    send();
    vi.advanceTimersByTime(1_000);
    send({ senderName: "bob", preview: "@u1 can you look at this", isMention: true });

    expect(notify).toHaveBeenCalledTimes(2);
    expect(callsFor("u1")[1]).toMatchObject({
      title: "@bob mentioned you",
      data: expect.objectContaining({ isMention: "true" }),
    });
  });

  it("absorbs pending messages into the mention rather than trailing a summary", () => {
    send();
    vi.advanceTimersByTime(1_000);
    send({ preview: "and another" }); // folded, flush scheduled
    vi.advanceTimersByTime(1_000);
    send({ preview: "@u1 hey", isMention: true });

    expect(notify).toHaveBeenCalledTimes(2);

    // The scheduled flush must not fire a third, redundant push.
    vi.advanceTimersByTime(BUNDLE_WINDOW_MS * 2);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("tracks each recipient separately", () => {
    send({ userIds: ["u1"] });
    vi.advanceTimersByTime(1_000);

    // u2 is new to this conversation — their first message is immediate even
    // though u1 is mid-window.
    send({ userIds: ["u1", "u2"], preview: "second" });

    expect(callsFor("u1")).toHaveLength(1);
    expect(callsFor("u2")).toHaveLength(1);

    vi.advanceTimersByTime(BUNDLE_WINDOW_MS);
    expect(callsFor("u1")).toHaveLength(2); // summary for the folded message
    expect(callsFor("u2")).toHaveLength(1); // nothing was folded
  });

  it("keeps windows separate per chat", () => {
    send({ chatId: "c1" });
    send({ chatId: "c2" });

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.map((c) => (c[0] as any).collapseKey)).toEqual([
      "chat:c1",
      "chat:c2",
    ]);
  });

  it("does not push to a caller-filtered empty recipient list", () => {
    send({ userIds: [] });
    vi.advanceTimersByTime(BUNDLE_WINDOW_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("describes an attachment rather than sending an empty body", () => {
    send({ preview: "   " });
    expect(callsFor("u1")[0]).toMatchObject({ body: "Sent an attachment" });
  });

  it("truncates a long message to a notification-sized preview", () => {
    send({ preview: "x".repeat(500) });
    expect((callsFor("u1")[0] as any).body).toHaveLength(120);
  });
});
