import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelegramBot, resetTelegramRuntimeForTests } from "./telegram.js";
import {
  clearActivePrompt,
  saveAccess,
  setPendingPermission,
  startActivePrompt,
} from "./state.js";
import type { Config } from "./config.js";
import { createTestConfig } from "./test-support.js";

function makeConfig(stateDir: string): Config {
  return createTestConfig(stateDir, { SEND_PACE_MS: 0 });
}

function makeDeps(config: Config) {
  return {
    config,
    onPrompt: vi.fn(async () => {}),
    onCancel: vi.fn(async () => true),
    onNewSession: vi.fn(async () => true),
    onStatus: vi.fn(async () => {}),
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
    } finally {
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
      const deps = { ...makeDeps(config), onPrompt: vi.fn(() => blocked) };
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
      release();
      resetTelegramRuntimeForTests();
    } finally {
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
        "✅ Always allowed",
        "Dan",
      );
    } finally {
      clearTimeout(timer);
      setPendingPermission(null);
      clearActivePrompt();
      resetTelegramRuntimeForTests();
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
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
