import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "grammy";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { createBridge } from "./bridge.js";
import type { AcpClientHandle } from "./acp-client.js";
import type { TelegramDeps } from "./telegram.js";
import {
  resetTelegramRuntimeForTests,
  setTelegramRuntimeForTests,
} from "./telegram.js";
import {
  clearActivePrompt,
  getActivePrompt,
  readLock,
  setPendingPermission,
  startActivePrompt,
} from "./state.js";
import { createTestConfig } from "./test-support.js";

function fakeBot(): Bot {
  return {
    stop: vi.fn(async () => undefined),
  } as unknown as Bot;
}

function requireTelegramDeps(value: TelegramDeps | null): TelegramDeps {
  if (!value) throw new Error("Telegram dependencies were not captured");
  return value;
}

function idleAcp(config: ReturnType<typeof createTestConfig>): AcpClientHandle {
  return {
    connect: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async () => ({ stopReason: "end_turn" } as PromptResponse)),
    cancelCurrent: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => true),
    shutdown: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    getSessionId: () => "test-session",
    isConnected: () => true,
    isPromptRunning: () => false,
    getPromptCapabilities: () => ({}),
    setCwd: vi.fn(),
    getCwd: () => config.agentCwdAbs,
  };
}

describe("bridge lifecycle transitions", () => {
  let stateDir = "";

  afterEach(() => {
    clearActivePrompt();
    resetTelegramRuntimeForTests();
    vi.restoreAllMocks();
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it("terminates and awaits the exact old prompt before creating a new ACP session", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "grok-tg-bridge-life-"));
    const config = createTestConfig(stateDir, {
      CANCEL_WAIT_MS: 5,
      API_TIMEOUT_MS: 25,
    });
    setTelegramRuntimeForTests("test-token", config);

    const events: string[] = [];
    let promptRunning = false;
    let rejectPrompt: ((reason: Error) => void) | null = null;
    let capturedDeps: TelegramDeps | null = null;
    let shutdownCount = 0;

    const handle: AcpClientHandle = {
      connect: vi.fn(async () => { events.push("connect"); }),
      sendPrompt: vi.fn(async () => {
        promptRunning = true;
        events.push("prompt-start");
        return new Promise<PromptResponse>((_resolve, reject) => {
          rejectPrompt = reject;
        }).finally(() => {
          promptRunning = false;
          events.push("prompt-settled");
        });
      }),
      cancelCurrent: vi.fn(async () => { events.push("cancel"); }),
      waitForIdle: vi.fn(async () => !promptRunning),
      shutdown: vi.fn(async () => {
        shutdownCount += 1;
        events.push(`shutdown-${shutdownCount}`);
        const reject = rejectPrompt;
        rejectPrompt = null;
        reject?.(new Error("old ACP terminated"));
      }),
      restart: vi.fn(async () => { events.push("restart"); }),
      getSessionId: () => "test-session",
      isConnected: () => true,
      isPromptRunning: () => promptRunning,
      getPromptCapabilities: () => ({ image: true, audio: true, embeddedContext: true }),
      setCwd: vi.fn(),
      getCwd: () => config.agentCwdAbs,
    };

    const bridge = createBridge(config, {
      createAcpClient: () => handle,
      createTelegramBot: (_config, deps) => {
        capturedDeps = deps;
        return fakeBot();
      },
    });

    try {
      const deps = requireTelegramDeps(capturedDeps);
      startActivePrompt(42, 100, 7);
      const oldPrompt = deps.onPrompt(42, {
        text: "long-running request",
        replyContext: null,
        inboxFiles: [],
      }, 7);

      for (let i = 0; i < 20 && !promptRunning; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(promptRunning).toBe(true);

      await expect(deps.onNewSession(42, 7)).resolves.toBe(true);
      await oldPrompt;

      const settledAt = events.indexOf("prompt-settled");
      const finalConnectAt = events.lastIndexOf("connect");
      expect(settledAt).toBeGreaterThan(events.indexOf("shutdown-1"));
      expect(finalConnectAt).toBeGreaterThan(settledAt);
      expect(events).not.toContain("restart");
      expect(getActivePrompt()).toBeNull();
    } finally {
      await bridge.shutdown();
    }
  });

  it("keeps prompt ownership until final Telegram delivery settles", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "grok-tg-bridge-delivery-"));
    const config = createTestConfig(stateDir, { API_TIMEOUT_MS: 100 });
    setTelegramRuntimeForTests("test-token", config);
    let capturedDeps: TelegramDeps | null = null;
    let finish!: () => void;
    let deliveryStarted = false;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      deliveryStarted = true;
      await blocked;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }));

    const handle: AcpClientHandle = {
      connect: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => ({ stopReason: "end_turn" }) as PromptResponse),
      cancelCurrent: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => true),
      shutdown: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      getSessionId: () => "test-session",
      isConnected: () => true,
      isPromptRunning: () => false,
      getPromptCapabilities: () => ({}),
      setCwd: vi.fn(),
      getCwd: () => config.agentCwdAbs,
    };
    const bridge = createBridge(config, {
      createAcpClient: () => handle,
      createTelegramBot: (_config, deps) => {
        capturedDeps = deps;
        return fakeBot();
      },
    });

    try {
      const deps = requireTelegramDeps(capturedDeps);
      const active = startActivePrompt(42, 102, 7);
      const prompt = deps.onPrompt(42, {
        text: "quick request",
        replyContext: null,
        inboxFiles: [],
      }, 7);
      for (let i = 0; i < 20 && !deliveryStarted; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(deliveryStarted).toBe(true);
      expect(getActivePrompt()?.id).toBe(active.id);

      finish();
      await prompt;
      expect(getActivePrompt()).toBeNull();
      const persistedHealth = JSON.parse(
        readFileSync(join(stateDir, "health.json"), "utf8"),
      ) as { activePrompt: unknown; likelyState: string; reason: string };
      expect(persistedHealth.activePrompt).toBeNull();
      expect(persistedHealth.likelyState).not.toBe("waiting for ACP response");
      expect(persistedHealth.reason).toBe("prompt-idle");
    } finally {
      await bridge.shutdown();
    }
  });

  it("does not release the poller lock until an active prompt settles during shutdown", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "grok-tg-bridge-stop-"));
    const config = createTestConfig(stateDir, {
      CANCEL_WAIT_MS: 5,
      API_TIMEOUT_MS: 25,
    });
    setTelegramRuntimeForTests("test-token", config);

    const events: string[] = [];
    let promptRunning = false;
    let rejectPrompt: ((reason: Error) => void) | null = null;
    let capturedDeps: TelegramDeps | null = null;

    const handle: AcpClientHandle = {
      connect: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => {
        promptRunning = true;
        return new Promise<PromptResponse>((_resolve, reject) => {
          rejectPrompt = reject;
        }).finally(() => {
          promptRunning = false;
          events.push("prompt-settled");
        });
      }),
      cancelCurrent: vi.fn(async () => { events.push("cancel"); }),
      waitForIdle: vi.fn(async () => !promptRunning),
      shutdown: vi.fn(async () => {
        events.push("acp-shutdown");
        const reject = rejectPrompt;
        rejectPrompt = null;
        reject?.(new Error("shutdown"));
      }),
      restart: vi.fn(async () => undefined),
      getSessionId: () => "test-session",
      isConnected: () => true,
      isPromptRunning: () => promptRunning,
      getPromptCapabilities: () => ({ image: true }),
      setCwd: vi.fn(),
      getCwd: () => config.agentCwdAbs,
    };

    const bridge = createBridge(config, {
      createAcpClient: () => handle,
      createTelegramBot: (_config, deps) => {
        capturedDeps = deps;
        return fakeBot();
      },
    });

    const deps = requireTelegramDeps(capturedDeps);
    expect(readLock(config)).not.toBeNull();
    startActivePrompt(42, 101, 7);
    const oldPrompt = deps.onPrompt(42, {
      text: "active during shutdown",
      replyContext: null,
      inboxFiles: [],
    }, 7);
    for (let i = 0; i < 20 && !promptRunning; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(promptRunning).toBe(true);

    await bridge.shutdown();
    events.push("bridge-shutdown-done");
    await oldPrompt;

    expect(events.indexOf("prompt-settled")).toBeGreaterThan(events.indexOf("acp-shutdown"));
    expect(events.indexOf("bridge-shutdown-done")).toBeGreaterThan(events.indexOf("prompt-settled"));
    expect(readLock(config)).toBeNull();
    expect(getActivePrompt()).toBeNull();
  });

  it("acquires the poller lock before touching an existing inbox", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "grok-tg-lock-before-inbox-"));
    const config = createTestConfig(stateDir);
    setTelegramRuntimeForTests("test-token", config);
    const handle = idleAcp(config);
    const bridge = createBridge(config, {
      createAcpClient: () => handle,
      createTelegramBot: () => fakeBot(),
    });
    const inbox = join(stateDir, ".tg-inbox");
    const activeFile = join(inbox, "active-attachment");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(activeFile, "live");
    chmodSync(inbox, 0o777);

    expect(() => createBridge(config, {
      createAcpClient: () => idleAcp(config),
      createTelegramBot: () => fakeBot(),
    })).toThrow(/lock|instance|running/i);
    expect(existsSync(activeFile)).toBe(true);
    expect(statSync(inbox).mode & 0o777).toBe(0o777);

    await bridge.shutdown();
  });

  it("still proves ACP shutdown when Telegram polling shutdown fails", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "grok-tg-polling-failure-"));
    const config = createTestConfig(stateDir);
    setTelegramRuntimeForTests("test-token", config);
    const handle = idleAcp(config);
    const bridge = createBridge(config, {
      createAcpClient: () => handle,
      createTelegramBot: () => fakeBot(),
      stopPolling: vi.fn(async () => { throw new Error("handlers stuck"); }),
    });

    await expect(bridge.shutdown()).rejects.toThrow(/did not complete safely/);
    expect(handle.shutdown).toHaveBeenCalledTimes(2);
    expect(readLock(config)).not.toBeNull();
  });

  it("closes prompt admission before no-active cancel awaits permission cleanup", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "grok-tg-cancel-gate-"));
    const config = createTestConfig(stateDir);
    setTelegramRuntimeForTests("test-token", config);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await blocked;
      return new Response(JSON.stringify({ ok: true, result: true }));
    }));
    let capturedDeps: TelegramDeps | null = null;
    createBridge(config, {
      createAcpClient: () => idleAcp(config),
      createTelegramBot: (_config, deps) => {
        capturedDeps = deps;
        return fakeBot();
      },
    });
    setPendingPermission({
      id: "permission-1",
      kind: "edit",
      summary: "Edit file",
      startedAt: new Date().toISOString(),
      timer: setTimeout(() => undefined, 60_000),
      resolve: vi.fn(),
      messages: [{ chatId: 42, messageId: 9 }],
      connectionGeneration: 1,
      promptEpoch: 1,
    });

    const deps = requireTelegramDeps(capturedDeps);
    const cancelling = deps.onCancel(42, 7, false);
    expect(deps.canAcceptPrompts?.()).toBe(false);
    release();
    await cancelling;
    expect(deps.canAcceptPrompts?.()).toBe(true);
  });

  it("keeps admission closed when a terminated prompt task still cannot settle", async () => {
    vi.useFakeTimers();
    stateDir = mkdtempSync(join(tmpdir(), "grok-tg-unsettled-prompt-"));
    const config = createTestConfig(stateDir, {
      CANCEL_WAIT_MS: 10,
      API_TIMEOUT_MS: 10,
    });
    setTelegramRuntimeForTests("test-token", config);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: { message_id: 1 },
    }))));
    let capturedDeps: TelegramDeps | null = null;
    const handle = idleAcp(config);
    handle.sendPrompt = vi.fn(() => new Promise<PromptResponse>(() => undefined));
    handle.isPromptRunning = () => true;
    createBridge(config, {
      createAcpClient: () => handle,
      createTelegramBot: (_config, deps) => {
        capturedDeps = deps;
        return fakeBot();
      },
    });

    const deps = requireTelegramDeps(capturedDeps);
    startActivePrompt(42, 101, 7);
    void deps.onPrompt(42, {
      text: "never settles",
      inboxFiles: [],
      replyContext: null,
    }, 7).catch(() => undefined);
    await Promise.resolve();
    const cancelling = deps.onCancel(42, 7, false);
    await vi.advanceTimersByTimeAsync(6_000);
    await cancelling;

    expect(deps.canAcceptPrompts?.()).toBe(false);
    expect(readLock(config)).not.toBeNull();
  });

  it("keeps admission closed when ACP ownership termination cannot be proven", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "grok-tg-bridge-compromised-"));
    const config = createTestConfig(stateDir);
    setTelegramRuntimeForTests("test-token", config);
    let capturedDeps: TelegramDeps | null = null;
    let shutdownCalls = 0;
    const handle: AcpClientHandle = {
      connect: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => ({ stopReason: "end_turn" } as PromptResponse)),
      cancelCurrent: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => true),
      shutdown: vi.fn(async () => {
        shutdownCalls += 1;
        if (shutdownCalls === 1) throw new Error("child exit unproven");
      }),
      restart: vi.fn(async () => undefined),
      getSessionId: () => "test-session",
      isConnected: () => true,
      isPromptRunning: () => false,
      getPromptCapabilities: () => ({}),
      setCwd: vi.fn(),
      getCwd: () => config.agentCwdAbs,
    };
    const bridge = createBridge(config, {
      createAcpClient: () => handle,
      createTelegramBot: (_config, deps) => {
        capturedDeps = deps;
        return fakeBot();
      },
    });

    const deps = requireTelegramDeps(capturedDeps);
    await expect(deps.onNewSession(42, 7)).rejects.toThrow(/child exit unproven/);
    expect(deps.canAcceptPrompts?.()).toBe(false);
    expect(handle.connect).not.toHaveBeenCalled();
    expect(readLock(config)).not.toBeNull();

    await bridge.shutdown();
    expect(readLock(config)).toBeNull();
  });
});
