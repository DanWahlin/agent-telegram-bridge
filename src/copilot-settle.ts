import type { SessionUpdate } from "@agentclientprotocol/sdk";

export interface CopilotSettleWatchdog {
  recordUpdate: (update: SessionUpdate) => void;
  dispose: () => void;
}

export interface CopilotSettleOptions {
  graceMs: number;
  hasPendingPermission: () => boolean;
  onSettle: () => Promise<void> | void;
  onError?: (error: unknown) => void;
}

/**
 * Copilot CLI can stream a complete answer and become internally idle without
 * resolving its ACP session/prompt request. Once text has been produced, this
 * watchdog requests protocol cancellation only after a quiet grace period and
 * only when no tool or permission is active. The streamed text remains the
 * turn's final response.
 */
export function createCopilotSettleWatchdog(
  options: CopilotSettleOptions,
): CopilotSettleWatchdog {
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;
  let sawAssistantText = false;
  const activeTools = new Set<string>();

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule(): void {
    clearTimer();
    if (disposed || !sawAssistantText || activeTools.size > 0) return;
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      if (activeTools.size > 0 || options.hasPendingPermission()) {
        schedule();
        return;
      }
      Promise.resolve(options.onSettle()).catch((error: unknown) => {
        options.onError?.(error);
      });
    }, options.graceMs);
    timer.unref();
  }

  function recordUpdate(update: SessionUpdate): void {
    clearTimer();
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text" && update.content.text.trim()) {
          sawAssistantText = true;
        }
        break;
      case "tool_call":
        activeTools.add(update.toolCallId);
        break;
      case "tool_call_update":
        if (update.status === "completed" || update.status === "failed") {
          activeTools.delete(update.toolCallId);
        }
        break;
      default:
        break;
    }
    schedule();
  }

  return {
    recordUpdate,
    dispose: () => {
      disposed = true;
      clearTimer();
      activeTools.clear();
    },
  };
}
