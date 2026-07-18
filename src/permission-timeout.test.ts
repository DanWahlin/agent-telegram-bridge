import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handlePermissionForward,
  type PermissionRequest,
} from "./acp-client.js";
import {
  getPendingPermission,
  setPendingPermission,
  cancelPendingPermissionState,
} from "./state.js";
import { createTestConfig } from "./test-support.js";

describe("permission timeout handling", () => {
  afterEach(() => {
    setPendingPermission(null);
    vi.useRealTimers();
  });

  it("registers permission state before card delivery and cancels a late card", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "grok-tg-permission-race-"));
    try {
      const config = createTestConfig(stateDir);
      const request: PermissionRequest = {
        sessionId: "session-1",
        connectionGeneration: 1,
        promptEpoch: 1,
        toolCall: { toolCallId: "tool-1", kind: "edit", title: "Edit file" },
        options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
      };
      let finishDelivery!: (messages: Array<{ chatId: number; messageId: number }>) => void;
      const delivery = new Promise<Array<{ chatId: number; messageId: number }>>((resolve) => {
        finishDelivery = resolve;
      });
      const resolve = vi.fn();
      const expire = vi.fn(async () => undefined);

      const forwarding = handlePermissionForward(
        config,
        request,
        vi.fn(async () => delivery),
        resolve,
        expire,
      );
      await Promise.resolve();
      expect(getPendingPermission()).not.toBeNull();

      cancelPendingPermissionState();
      finishDelivery([{ chatId: 42, messageId: 9 }]);
      await forwarding;

      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith({ outcome: { outcome: "cancelled" } });
      expect(expire).toHaveBeenCalledWith("Edit file", [{ chatId: 42, messageId: 9 }]);
      expect(getPendingPermission()).toBeNull();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("cancels the ACP request before slow card expiry cleanup", async () => {
    vi.useFakeTimers();
    const stateDir = mkdtempSync(join(tmpdir(), "grok-tg-permission-timeout-"));
    try {
      const config = createTestConfig(stateDir, {
        PERMISSION_TIMEOUT_MS: 100,
      });
      const request: PermissionRequest = {
        sessionId: "session-1",
        connectionGeneration: 1,
        promptEpoch: 1,
        toolCall: {
          toolCallId: "tool-1",
          kind: "edit",
          title: "Edit src/app.ts",
        },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
        ],
      };
      const resolve = vi.fn();
      const expire = vi.fn(async () => undefined);

      await handlePermissionForward(
        config,
        request,
        vi.fn(async () => [{ chatId: 42, messageId: 7 }]),
        resolve,
        expire,
      );
      expect(getPendingPermission()).not.toBeNull();

      await vi.advanceTimersByTimeAsync(100);

      expect(expire).toHaveBeenCalledWith(
        "Edit src/app.ts",
        [{ chatId: 42, messageId: 7 }],
      );
      expect(resolve).toHaveBeenCalledWith({ outcome: { outcome: "cancelled" } });
      expect(getPendingPermission()).toBeNull();
      expect(resolve.mock.invocationCallOrder[0]).toBeLessThan(expire.mock.invocationCallOrder[0] ?? 0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
