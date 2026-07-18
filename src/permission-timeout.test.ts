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
} from "./state.js";
import { createTestConfig } from "./test-support.js";

describe("permission timeout handling", () => {
  afterEach(() => {
    setPendingPermission(null);
    vi.useRealTimers();
  });

  it("marks the card expired before cancelling the ACP request", async () => {
    vi.useFakeTimers();
    const stateDir = mkdtempSync(join(tmpdir(), "grok-tg-permission-timeout-"));
    try {
      const config = createTestConfig(stateDir, {
        PERMISSION_TIMEOUT_MS: 100,
      });
      const request: PermissionRequest = {
        sessionId: "session-1",
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
      expect(expire.mock.invocationCallOrder[0]).toBeLessThan(resolve.mock.invocationCallOrder[0] ?? 0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
