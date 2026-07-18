import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAssistantDelta,
  beginOutboundShutdown,
  closeOutboundQueue,
  dismissBubble,
  editMessageReplyMarkup,
  editPermissionMessage,
  finalizeStreamDrafts,
  getCurrentAssistantText,
  getStreamDrafts,
  resetTelegramRuntimeForTests,
  resetAndWaitForStreamDrafts,
  sendMessage,
  scheduleAssistantDeltaFlush,
  setTelegramRuntimeForTests,
  startTyping,
  stopPolling,
  trackToolCall,
  updateToolCall,
} from "./telegram.js";
import {
  clearActivePrompt,
  saveAccess,
  startActivePrompt,
} from "./state.js";
import { createTestConfig } from "./test-support.js";

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

function stubTelegramApi(calls: ApiCall[]): void {
  let messageId = 100;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const method = String(input).split("/").pop() ?? "";
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, payload });
    const result = method === "sendMessage" ? { message_id: messageId++ } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  }));
}

describe("Telegram delivery runtime", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "grok-tg-runtime-"));
  });

  afterEach(() => {
    resetTelegramRuntimeForTests();
    clearActivePrompt();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("caps retained assistant text", () => {
    const config = createTestConfig(stateDir, { ASSISTANT_TEXT_MAX_CHARS: 50 });
    setTelegramRuntimeForTests("test-token", config);
    appendAssistantDelta("x".repeat(100));
    expect(getCurrentAssistantText().length).toBeLessThanOrEqual(50);
    expect(getCurrentAssistantText()).toContain("[Response truncated by bridge]");
  });

  it("propagates a Telegram polling stop failure", async () => {
    const config = createTestConfig(stateDir);
    setTelegramRuntimeForTests("test-token", config);
    const bot = {
      stop: vi.fn(async () => { throw new Error("poller still alive"); }),
    } as unknown as Parameters<typeof stopPolling>[0];

    await expect(stopPolling(bot)).rejects.toThrow(/poller still alive/);
  });

  it("bounds a Telegram polling stop that never settles", async () => {
    vi.useFakeTimers();
    const config = createTestConfig(stateDir, { API_TIMEOUT_MS: 100 });
    setTelegramRuntimeForTests("test-token", config);
    const bot = {
      stop: vi.fn(() => new Promise<void>(() => undefined)),
    } as unknown as Parameters<typeof stopPolling>[0];

    const stopping = stopPolling(bot);
    const rejected = expect(stopping).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  });

  it("waits for an in-flight assistant draft flush before releasing turn ownership", async () => {
    const config = createTestConfig(stateDir, {
      STREAM_EDIT_INTERVAL_MS: 1,
      SEND_PACE_MS: 0,
    });
    setTelegramRuntimeForTests("test-token", config);
    let release!: () => void;
    let started = false;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      started = true;
      await blocked;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }));

    appendAssistantDelta("partial response");
    scheduleAssistantDeltaFlush([42], config);
    for (let i = 0; i < 50 && !started; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(started).toBe(true);

    let settled = false;
    const ownershipBarrier = resetAndWaitForStreamDrafts().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    release();
    await ownershipBarrier;
    expect(settled).toBe(true);
  });

  it("rejects new Telegram operations when the outbound queue is full", async () => {
    const config = createTestConfig(stateDir, { TELEGRAM_OUTBOUND_QUEUE_MAX: 1 });
    setTelegramRuntimeForTests("test-token", config);
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await blocked;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }));

    const first = sendMessage(42, "first");
    await expect(sendMessage(42, "second")).rejects.toThrow(/queue is full/);
    finish();
    await expect(first).resolves.toMatchObject({ message_id: 1 });
  });

  it("disables rate-limit retries as soon as shutdown begins", async () => {
    vi.useFakeTimers();
    const config = createTestConfig(stateDir, {
      API_TIMEOUT_MS: 100,
      TELEGRAM_RETRY_MAX: 5,
    });
    setTelegramRuntimeForTests("test-token", config);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      parameters: { retry_after: 30 },
    }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const sending = sendMessage(42, "retry me");
    const sendingRejected = expect(sending).rejects.toThrow(/shutting down|rate limited/i);
    await vi.advanceTimersByTimeAsync(0);
    beginOutboundShutdown();
    const closing = closeOutboundQueue();
    await vi.advanceTimersByTimeAsync(200);

    await sendingRejected;
    await closing;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits for the active Telegram operation while rejecting queued work on shutdown", async () => {
    const config = createTestConfig(stateDir, { TELEGRAM_OUTBOUND_QUEUE_MAX: 3 });
    setTelegramRuntimeForTests("test-token", config);
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await blocked;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }));

    const first = sendMessage(42, "first");
    const second = sendMessage(42, "second");
    const secondResult = expect(second).rejects.toThrow(/shutting down/);
    let closed = false;
    const closing = closeOutboundQueue().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    await secondResult;
    finish();
    await expect(first).resolves.toMatchObject({ message_id: 1 });
    await closing;
    expect(closed).toBe(true);
  });

  it("bounds Telegram rate-limit retries", async () => {
    const config = createTestConfig(stateDir, {
      TELEGRAM_RETRY_MAX: 2,
      API_TIMEOUT_MS: 10,
    });
    setTelegramRuntimeForTests("test-token", config);
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, parameters: { retry_after: 0 } }),
      { status: 429 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMessage(42, "retry")).rejects.toThrow(/Rate limited/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("finalizes the first chunk in the draft and sends every remaining chunk", async () => {
    vi.useFakeTimers();
    const calls: ApiCall[] = [];
    const config = createTestConfig(stateDir, {
      SEND_PACE_MS: 0,
      STREAM_EDIT_INTERVAL_MS: 1,
    });
    setTelegramRuntimeForTests("test-token", config);
    stubTelegramApi(calls);

    appendAssistantDelta("preview");
    scheduleAssistantDeltaFlush([42], config);
    await vi.advanceTimersByTimeAsync(1);

    const content = `${"a".repeat(4_096)}${"b".repeat(900)}`;
    await finalizeStreamDrafts(content, [42], config);

    const deliveries = calls.filter(({ method }) =>
      method === "sendMessage" || method === "editMessageText");
    expect(deliveries).toHaveLength(3);
    expect(deliveries[0]?.payload.text).toBe("preview");
    expect(deliveries[1]?.method).toBe("editMessageText");
    expect(deliveries[1]?.payload.text).toBe("a".repeat(4_096));
    expect(deliveries[2]?.payload.text).toBe("b".repeat(900));
  });

  it("creates, edits, and deletes a tool bubble only for the active authorized chat", async () => {
    vi.useFakeTimers();
    const calls: ApiCall[] = [];
    const config = createTestConfig(stateDir, { SEND_PACE_MS: 0 });
    setTelegramRuntimeForTests("test-token", config);
    saveAccess(config, { allowedUsers: ["42"], pending: {} });
    startActivePrompt(42, 1, 42);
    stubTelegramApi(calls);

    trackToolCall("tool-1", "Run command", { command: "npm test" });
    await vi.advanceTimersByTimeAsync(300);
    updateToolCall("tool-1", "completed");
    await vi.advanceTimersByTimeAsync(300);
    await dismissBubble();

    expect(calls.map(({ method }) => method)).toEqual([
      "sendMessage",
      "editMessageText",
      "deleteMessage",
    ]);
    expect(calls[0]?.payload.chat_id).toBe(42);
    expect(calls[0]?.payload.text).toContain("npm test");
  });

  it("replaces resolved permission cards and removes inline keyboards", async () => {
    const calls: ApiCall[] = [];
    const config = createTestConfig(stateDir, { SEND_PACE_MS: 0 });
    setTelegramRuntimeForTests("test-token", config);
    stubTelegramApi(calls);

    await editPermissionMessage(42, 7, "✅ Allowed for session\n\nEdit src/app.ts\n\nDecision recorded.");
    await editMessageReplyMarkup(42, 8, null);

    expect(calls).toEqual([
      {
        method: "editMessageText",
        payload: {
          chat_id: 42,
          message_id: 7,
          text: "✅ Allowed for session\n\nEdit src/app.ts\n\nDecision recorded.",
          reply_markup: { inline_keyboard: [] },
        },
      },
      {
        method: "editMessageReplyMarkup",
        payload: {
          chat_id: 42,
          message_id: 8,
          reply_markup: { inline_keyboard: [] },
        },
      },
    ]);
  });

  it("resets draft state when a later final chunk cannot be delivered", async () => {
    const config = createTestConfig(stateDir, { SEND_PACE_MS: 0 });
    setTelegramRuntimeForTests("test-token", config);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      callCount += 1;
      if (callCount === 2) return new Response("delivery failed", { status: 500 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }));
    }));

    await expect(finalizeStreamDrafts("x".repeat(5_000), [42], config)).rejects.toThrow(
      /Telegram API sendMessage failed/,
    );
    expect(getStreamDrafts().size).toBe(0);
    expect(errorLog).toHaveBeenCalled();
  });

  it("honors configured send pacing and typing intervals", async () => {
    vi.useFakeTimers();
    const calls: ApiCall[] = [];
    const config = createTestConfig(stateDir, {
      SEND_PACE_MS: 120,
      TYPING_INTERVAL_MS: 200,
      TYPING_DEBOUNCE_MS: 10_000,
      MAX_TYPING_SESSION_MS: 550,
    });
    setTelegramRuntimeForTests("test-token", config);
    stubTelegramApi(calls);

    const first = sendMessage(42, "one");
    const second = sendMessage(42, "two");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter(({ method }) => method === "sendMessage")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(119);
    expect(calls.filter(({ method }) => method === "sendMessage")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);

    calls.length = 0;
    startTyping([42]);
    await vi.advanceTimersByTimeAsync(600);
    expect(calls.filter(({ method }) => method === "sendChatAction")).toHaveLength(3);
  });
});
