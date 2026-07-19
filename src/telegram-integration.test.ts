import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTelegramBot,
  resetTelegramRuntimeForTests,
  type PromptPayload,
} from "./telegram.js";
import {
  clearActivePrompt,
  reloadAccess,
  resetRuntimeStateForTests,
  saveAccess,
  setPendingPermission,
  startActivePrompt,
} from "./state.js";
import type { Config } from "./config.js";
import { createTestConfig } from "./test-support.js";
import { captureRootIdentity } from "./media.js";

function makeConfig(stateDir: string): Config {
  return createTestConfig(stateDir, { SEND_PACE_MS: 0 });
}

function makeDeps(config: Config) {
  const onPrompt = vi.fn(async (
    _chatId: number,
    _payload: PromptPayload,
    _userId: number,
  ) => undefined);
  return {
    config,
    getSessionRoot: () => captureRootIdentity(config.agentCwdAbs),
    onPrompt,
    onCancel: vi.fn(async () => ({ cancelled: true, queueCleared: 0 })),
    onNewSession: vi.fn(async () => true),
    onStatus: vi.fn(async () => {}),
    onRetryLast: vi.fn(async () => {}),
    onSetVerbose: vi.fn(async () => {}),
    onSetCwd: vi.fn(async () => {}),
    onStaleAction: vi.fn(async () => true),
  };
}

describe("Telegram authorization and prompt dispatch", () => {
  it("rejects group prompts before dispatching to ACP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-auth-"));
    try {
      const config = makeConfig(dir);
      saveAccess(config, { allowedUsers: ["42"], pending: {} });
      const deps = makeDeps(config);
      const bot = createTelegramBot(config, deps);
      (bot as any).botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      const replies: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_input: string | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as { text?: string };
        if (payload.text) replies.push(payload.text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }));

      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 0,
          text: "run tests",
          chat: { id: -10, type: "group", title: "dev" },
          from: { id: 42, is_bot: false, first_name: "Dan" },
        },
      } as any);

      expect(deps.onPrompt).not.toHaveBeenCalled();
      expect(replies).toContain("This bridge only works in private chats.");
      resetTelegramRuntimeForTests();
      resetRuntimeStateForTests();
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unauthorized media before calling Telegram getFile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-media-auth-"));
    try {
      const config = makeConfig(dir);
      saveAccess(config, { allowedUsers: ["42"], pending: {} });
      const deps = makeDeps(config);
      const bot = createTelegramBot(config, deps);
      (bot as any).botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      const methods: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
        methods.push(String(input).split("/").pop() ?? "");
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }));

      await bot.handleUpdate({
        update_id: 6,
        message: {
          message_id: 6,
          date: 0,
          photo: [{ file_id: "photo-1", file_unique_id: "unique-1", width: 10, height: 10 }],
          chat: { id: 43, type: "private", first_name: "Other" },
          from: { id: 43, is_bot: false, first_name: "Other" },
        },
      } as any);

      expect(methods).not.toContain("getFile");
      expect(deps.onPrompt).not.toHaveBeenCalled();
    } finally {
      resetTelegramRuntimeForTests();
      resetRuntimeStateForTests();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("downloads an authorized photo and forwards its caption as a prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-media-"));
    try {
      const config = makeConfig(dir);
      saveAccess(config, { allowedUsers: ["42"], pending: {} });
      const deps = makeDeps(config);
      const bot = createTelegramBot(config, deps);
      (bot as any).botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/getFile")) {
          return new Response(JSON.stringify({
            ok: true,
            result: { file_path: "photos/photo-1.jpg" },
          }));
        }
        if (url.includes("/file/bot")) {
          return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
            status: 200,
            headers: { "content-length": "4" },
          });
        }
        return new Response(JSON.stringify({ ok: true, result: true }));
      }));

      await bot.handleUpdate({
        update_id: 7,
        message: {
          message_id: 7,
          date: 0,
          caption: "What is in this photo?",
          photo: [{
            file_id: "photo-1",
            file_unique_id: "unique-1",
            file_size: 4,
            width: 10,
            height: 10,
          }],
          chat: { id: 42, type: "private", first_name: "Dan" },
          from: { id: 42, is_bot: false, first_name: "Dan" },
        },
      } as any);

      expect(deps.onPrompt).toHaveBeenCalledOnce();
      const payload = deps.onPrompt.mock.calls[0]?.[1];
      expect(payload?.text).toBe("What is in this photo?");
      expect(payload?.inboxFiles).toHaveLength(1);
      const filePath = payload?.inboxFiles[0]?.path;
      expect(filePath && existsSync(filePath)).toBe(true);
      expect(filePath ? statSync(filePath).mode & 0o777 : 0).toBe(0o600);
      if (filePath) rmSync(filePath, { force: true });
    } finally {
      resetTelegramRuntimeForTests();
      resetRuntimeStateForTests();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detaches a private prompt so later updates remain processable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-async-"));
    try {
      const config = makeConfig(dir);
      saveAccess(config, { allowedUsers: ["42"], pending: {} });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const deps = {
        ...makeDeps(config),
        onPrompt: vi.fn(async (
          _chatId: number,
          _payload: PromptPayload,
          _userId: number,
        ) => blocked),
      };
      const bot = createTelegramBot(config, deps);
      (bot as any).botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) =>
        new Response(JSON.stringify({
          ok: true,
          result: String(input).endsWith("/setMessageReaction") ? true : { message_id: 1 },
        }))));

      const handled = bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          date: 0,
          text: "long task",
          chat: { id: 42, type: "private", first_name: "Dan" },
          from: { id: 42, is_bot: false, first_name: "Dan" },
        },
      } as any);
      await expect(Promise.race([
        handled.then(() => "handled"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 250)),
      ])).resolves.toBe("handled");
      expect(deps.onPrompt).toHaveBeenCalledOnce();
      const payload = deps.onPrompt.mock.calls[0]?.[1];
      expect(payload).toMatchObject({ text: "long task" });
      release();
      resetTelegramRuntimeForTests();
      resetRuntimeStateForTests();
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queues a second prompt while one is active", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-queue-"));
    try {
      const config = makeConfig(dir);
      saveAccess(config, { allowedUsers: ["42"], pending: {} });
      startActivePrompt(42, 1, 42);
      const deps = makeDeps(config);
      const bot = createTelegramBot(config, deps);
      (bot as any).botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      const replies: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_input: string | URL, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) as { text?: string } : {};
        if (body.text) replies.push(body.text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }));

      await bot.handleUpdate({
        update_id: 5,
        message: {
          message_id: 5,
          date: 0,
          text: "second prompt",
          chat: { id: 42, type: "private", first_name: "Dan" },
          from: { id: 42, is_bot: false, first_name: "Dan" },
        },
      } as any);

      expect(deps.onPrompt).not.toHaveBeenCalled();
      expect(replies.some((r) => r.startsWith("Queued ("))).toBe(true);
      resetTelegramRuntimeForTests();
      resetRuntimeStateForTests();
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects media while busy before downloading it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-busy-media-"));
    try {
      const config = makeConfig(dir);
      saveAccess(config, { allowedUsers: ["42"], pending: {} });
      startActivePrompt(42, 1, 42);
      const deps = makeDeps(config);
      const bot = createTelegramBot(config, deps);
      (bot as any).botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      const methods: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
        methods.push(String(input).split("/").pop() ?? "");
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }));

      await bot.handleUpdate({
        update_id: 8,
        message: {
          message_id: 8,
          date: 0,
          photo: [{ file_id: "photo-2", file_unique_id: "unique-2", width: 10, height: 10 }],
          chat: { id: 42, type: "private", first_name: "Dan" },
          from: { id: 42, is_bot: false, first_name: "Dan" },
        },
      } as any);

      expect(methods).not.toContain("getFile");
      expect(deps.onPrompt).not.toHaveBeenCalled();
    } finally {
      resetTelegramRuntimeForTests();
      resetRuntimeStateForTests();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not mutate pairing state while admission is paused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-paused-pairing-"));
    try {
      const config = makeConfig(dir);
      saveAccess(config, { allowedUsers: [], pending: {} });
      const deps = { ...makeDeps(config), canAcceptPrompts: () => false };
      const bot = createTelegramBot(config, deps);
      (bot as any).botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      vi.stubGlobal("fetch", vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))));

      await bot.handleUpdate({
        update_id: 90,
        message: {
          message_id: 90,
          date: 0,
          text: "hello",
          chat: { id: 43, type: "private", first_name: "Other" },
          from: { id: 43, is_bot: false, first_name: "Other" },
        },
      } as any);

      expect(reloadAccess(config).pending).toEqual({});
      expect(deps.onPrompt).not.toHaveBeenCalled();
    } finally {
      resetTelegramRuntimeForTests();
      resetRuntimeStateForTests();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects stateful commands and callbacks while admission is paused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-paused-"));
    try {
      const config = makeConfig(dir);
      saveAccess(config, { allowedUsers: ["42"], pending: {} });
      const base = makeDeps(config);
      const deps = { ...base, canAcceptPrompts: () => false };
      const bot = createTelegramBot(config, deps);
      (bot as any).botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
        const method = String(input).split("/").pop();
        const result = method === "sendMessage" ? { message_id: 1 } : true;
        return new Response(JSON.stringify({ ok: true, result }));
      }));

      const commands = ["/cancel", "/new", "/retry last", "/verbose on", "/cwd 1"];
      for (const [index, text] of commands.entries()) {
        await bot.handleUpdate({
          update_id: 100 + index,
          message: {
            message_id: 100 + index,
            date: 0,
            text,
            entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }],
            chat: { id: 42, type: "private", first_name: "Dan" },
            from: { id: 42, is_bot: false, first_name: "Dan" },
          },
        } as any);
      }
      await bot.handleUpdate({
        update_id: 200,
        callback_query: {
          id: "paused-callback",
          from: { id: 42, is_bot: false, first_name: "Dan" },
          chat_instance: "test",
          data: "grok:s:prompt-1:cancel",
          message: {
            message_id: 200,
            date: 0,
            text: "stale",
            chat: { id: 42, type: "private", first_name: "Dan" },
          },
        },
      } as any);

      expect(deps.onCancel).not.toHaveBeenCalled();
      expect(deps.onNewSession).not.toHaveBeenCalled();
      expect(deps.onRetryLast).not.toHaveBeenCalled();
      expect(deps.onSetVerbose).not.toHaveBeenCalled();
      expect(deps.onSetCwd).not.toHaveBeenCalled();
      expect(deps.onStaleAction).not.toHaveBeenCalled();
    } finally {
      resetTelegramRuntimeForTests();
      resetRuntimeStateForTests();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forwards the exact durable permission option selected from Telegram", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-permission-"));
    const timer = setTimeout(() => undefined, 60_000);
    try {
      const config = makeConfig(dir);
      saveAccess(config, { allowedUsers: ["42"], pending: {} });
      startActivePrompt(42, 1, 42);
      setPendingPermission({
        id: "request-1",
        kind: "edit",
        summary: "Edit src/app.ts",
        startedAt: new Date().toISOString(),
        timer,
        resolve: vi.fn(),
        messages: [{ chatId: 42, messageId: 10 }],
        connectionGeneration: 1,
        promptEpoch: 1,
        rawRequest: {
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
            { optionId: "always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      const resolvePermission = vi.fn(async () => true);
      const bot = createTelegramBot(config, { ...makeDeps(config), resolvePermission });
      (bot as any).botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      vi.stubGlobal("fetch", vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, result: true }))));

      await bot.handleUpdate({
        update_id: 3,
        callback_query: {
          id: "callback-1",
          from: { id: 42, is_bot: false, first_name: "Dan" },
          chat_instance: "test",
          data: "grok:o:request-1:1",
          message: {
            message_id: 10,
            date: 0,
            text: "⚠️ Grok Build needs approval\n\nEdit src/app.ts",
            chat: { id: 42, type: "private", first_name: "Dan" },
          },
        },
      } as any);

      expect(resolvePermission).toHaveBeenCalledWith(
        { outcome: { outcome: "selected", optionId: "always" } },
        "✅ Allowed for session",
        "Dan",
      );
    } finally {
      clearTimeout(timer);
      setPendingPermission(null);
      clearActivePrompt();
      resetTelegramRuntimeForTests();
      resetRuntimeStateForTests();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks stale permission cards expired and removes their keyboard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-stale-permission-"));
    try {
      const config = makeConfig(dir);
      saveAccess(config, { allowedUsers: ["42"], pending: {} });
      const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
      const bot = createTelegramBot(config, makeDeps(config));
      (bot as any).botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
        calls.push({
          method: String(input).split("/").pop() ?? "",
          payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ ok: true, result: true }));
      }));

      await bot.handleUpdate({
        update_id: 4,
        callback_query: {
          id: "callback-stale",
          from: { id: 42, is_bot: false, first_name: "Dan" },
          chat_instance: "test",
          data: "grok:a:old-request",
          message: {
            message_id: 11,
            date: 0,
            text: "⚠️ Grok Build needs approval\n\nRun npm test\n\nTap a button or reply approve/reject.",
            chat: { id: 42, type: "private", first_name: "Dan" },
          },
        },
      } as any);

      expect(calls[0]).toEqual({
        method: "editMessageText",
        payload: {
          chat_id: 42,
          message_id: 11,
          text: "⌛ Approval expired\n\nRun npm test\n\nNo action was approved.",
          reply_markup: { inline_keyboard: [] },
        },
      });
      expect(calls[1]?.method).toBe("answerCallbackQuery");
    } finally {
      clearActivePrompt();
      setPendingPermission(null);
      resetTelegramRuntimeForTests();
      resetRuntimeStateForTests();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
