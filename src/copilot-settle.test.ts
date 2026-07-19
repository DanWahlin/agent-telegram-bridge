import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { createCopilotSettleWatchdog } from "./copilot-settle.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Copilot ACP settle watchdog", () => {
  it("settles after assistant text remains quiet for the grace period", async () => {
    vi.useFakeTimers();
    const onSettle = vi.fn(async () => undefined);
    const watchdog = createCopilotSettleWatchdog({
      graceMs: 30_000,
      hasPendingPermission: () => false,
      onSettle,
    });

    watchdog.recordUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Done" },
    } as SessionUpdate);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(onSettle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSettle).toHaveBeenCalledOnce();
    watchdog.dispose();
  });

  it("does not settle while a tool is active and rearms after completion", async () => {
    vi.useFakeTimers();
    const onSettle = vi.fn(async () => undefined);
    const watchdog = createCopilotSettleWatchdog({
      graceMs: 30_000,
      hasPendingPermission: () => false,
      onSettle,
    });

    watchdog.recordUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Checking" },
    } as SessionUpdate);
    watchdog.recordUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Run tests",
      kind: "execute",
    } as SessionUpdate);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSettle).not.toHaveBeenCalled();

    watchdog.recordUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
    } as SessionUpdate);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onSettle).toHaveBeenCalledOnce();
    watchdog.dispose();
  });

  it("defers settlement while a permission is pending", async () => {
    vi.useFakeTimers();
    let pending = true;
    const onSettle = vi.fn(async () => undefined);
    const watchdog = createCopilotSettleWatchdog({
      graceMs: 30_000,
      hasPendingPermission: () => pending,
      onSettle,
    });

    watchdog.recordUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Ready" },
    } as SessionUpdate);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onSettle).not.toHaveBeenCalled();
    pending = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onSettle).toHaveBeenCalledOnce();
    watchdog.dispose();
  });
});
