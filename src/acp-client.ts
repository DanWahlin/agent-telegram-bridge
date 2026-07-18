import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  PermissionOption,
  PromptResponse,
  RequestPermissionResponse,
  SessionUpdate,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { Config } from "./config.js";
import { messageSafeRandom, nowIso, sleep } from "./utils.js";
import { sanitizedError, sanitizePermissionText } from "./redact.js";
import {
  takePendingPermission,
  setPendingPermission,
  updateActivePromptActivity,
  writeHealthSnapshot,
  getSessionCwd,
  type PendingPermissionState,
} from "./state.js";
import type { PromptCapabilities } from "./media.js";

export interface PermissionRequest {
  sessionId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

interface AcpHandlers {
  onSessionUpdate: (update: SessionUpdate) => void;
  onPermissionRequest: (request: PermissionRequest) => Promise<RequestPermissionResponse>;
  onEvent: (kind: string) => void;
}

export interface AcpClientHandle {
  connect: () => Promise<void>;
  sendPrompt: (prompt: string | ContentBlock | ContentBlock[]) => Promise<PromptResponse>;
  cancelCurrent: () => Promise<void>;
  waitForIdle: (timeoutMs: number) => Promise<boolean>;
  shutdown: () => Promise<void>;
  restart: () => Promise<void>;
  getSessionId: () => string | null;
  isConnected: () => boolean;
  isPromptRunning: () => boolean;
  getPromptCapabilities: () => PromptCapabilities;
  setCwd: (cwd: string) => void;
  getCwd: () => string;
}

export function buildGrokChildEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    // The bridge owns Telegram transport. Grok must not import Claude-compatible
    // MCPs/hooks, especially the root Claude Telegram plugin, or it can launch a
    // competing Bot API poller and wedge both bridges.
    GROK_CLAUDE_MCPS_ENABLED: "false",
    GROK_CLAUDE_HOOKS_ENABLED: "false",
  };
  for (const key of ["HOME", "PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) {
    const value = parentEnv[key];
    if (value) childEnv[key] = value;
  }
  return childEnv;
}

export function createAcpClient(config: Config, handlers: AcpHandlers): AcpClientHandle {
  let child: ChildProcess | null = null;
  let childExit: Promise<void> | null = null;
  let connection: acp.ClientConnection | null = null;
  let context: acp.ClientContext | null = null;
  let session: acp.ActiveSession | null = null;
  let sessionId: string | null = null;
  let connected = false;
  let promptRunning = false;
  let promptCapabilities: PromptCapabilities = {};
  let sessionCwd = getSessionCwd(config.grokCwdAbs);

  async function stopChild(): Promise<void> {
    const running = child;
    const exited = childExit;
    child = null;
    childExit = null;
    if (!running) return;
    try {
      running.kill("SIGTERM");
    } catch (error: unknown) {
      console.warn(`[ACP] Failed to terminate Grok process: ${sanitizedError(error)}`);
    }
    if (exited) {
      const graceful = await Promise.race([exited.then(() => true), sleep(3000).then(() => false)]);
      if (!graceful) {
        try {
          running.kill("SIGKILL");
        } catch (error: unknown) {
          console.warn(`[ACP] Failed to kill unresponsive Grok process: ${sanitizedError(error)}`);
        }
        await Promise.race([exited, sleep(1000)]);
      }
    }
  }

  async function connect(): Promise<void> {
    if (connected && session && context) return;
    await shutdown();

    const args = ["agent", "--model", config.GROK_MODEL];
    if (config.GROK_ALWAYS_APPROVE) args.push("--always-approve");
    args.push("stdio");

    const childEnv = buildGrokChildEnv(process.env);
    child = spawn(config.grokBin, args, {
      cwd: sessionCwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      shell: false,
    });
    childExit = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child.stderr?.on("data", (chunk: Buffer) => {
      const line = sanitizePermissionText(chunk.toString("utf8"), 1000);
      if (line) console.error(`[GROK] ${line}`);
    });
    child.once("exit", (code, signal) => {
      connected = false;
      session = null;
      context = null;
      sessionId = null;
      handlers.onEvent(`process.exit:${code ?? signal ?? "unknown"}`);
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!),
      Readable.toWeb(child.stdout!),
    );
    const app = acp
      .client({ name: "grok-build-telegram" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        handlers.onEvent("permission.request");
        return handlers.onPermissionRequest(params);
      });

    connection = app.connect(stream);
    context = connection.agent;
    const initialized = await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "grok-build-telegram", version: "0.1.0" },
    });
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(`Unsupported ACP protocol ${initialized.protocolVersion}`);
    }
    const caps = initialized.agentCapabilities?.promptCapabilities;
    promptCapabilities = {
      image: caps?.image === true,
      audio: caps?.audio === true,
      embeddedContext: caps?.embeddedContext === true,
    };
    session = await context.buildSession(sessionCwd).start();
    sessionId = session.sessionId;
    connected = true;
    console.log(
      `[ACP] Grok session ${sessionId} connected with model ${config.GROK_MODEL} cwd=${sessionCwd} caps=${JSON.stringify(promptCapabilities)}`,
    );
    writeHealthSnapshot(config, "acp-session-created", {
      connected: true,
      acpSessionId: sessionId,
    }, { force: true });
  }

  async function sendPrompt(
    prompt: string | ContentBlock | ContentBlock[],
  ): Promise<PromptResponse> {
    await connect();
    if (!session || promptRunning) {
      throw new Error(promptRunning ? "A prompt is already active" : "No ACP session");
    }
    promptRunning = true;
    try {
      handlers.onEvent("prompt.sent");
      const completion = session.prompt(prompt);
      for (;;) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") {
          handlers.onEvent(`prompt.stop:${message.stopReason}`);
          break;
        }
        handlers.onSessionUpdate(message.update);
        const kind = message.update.sessionUpdate;
        handlers.onEvent(kind === "tool_call" || kind === "tool_call_update" ? "tool" : kind);
        updateActivePromptActivity();
      }
      return await completion;
    } finally {
      promptRunning = false;
    }
  }

  async function cancelCurrent(): Promise<void> {
    if (!context || !sessionId || !promptRunning) return;
    await context.notify(acp.methods.agent.session.cancel, { sessionId });
    handlers.onEvent("prompt.cancelled");
  }

  async function waitForIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (promptRunning && Date.now() < deadline) {
      await sleep(100);
    }
    return !promptRunning;
  }

  async function shutdown(): Promise<void> {
    connected = false;
    promptRunning = false;
    try {
      session?.dispose();
    } catch (error: unknown) {
      console.warn(`[ACP] Failed to dispose session: ${sanitizedError(error)}`);
    }
    session = null;
    sessionId = null;
    context = null;
    connection?.close();
    connection = null;
    await stopChild();
  }

  async function restart(): Promise<void> {
    await shutdown();
    await sleep(200);
    await connect();
  }

  return {
    connect,
    sendPrompt,
    cancelCurrent,
    waitForIdle,
    shutdown,
    restart,
    getSessionId: () => sessionId,
    isConnected: () => connected,
    isPromptRunning: () => promptRunning,
    getPromptCapabilities: () => promptCapabilities,
    setCwd: (cwd: string) => {
      sessionCwd = cwd;
    },
    getCwd: () => sessionCwd,
  };
}

export async function handlePermissionForward(
  config: Config,
  request: PermissionRequest,
  sendPermissionCard: (
    summary: string,
    id: string,
    options: PermissionOption[],
  ) => Promise<Array<{ chatId: number; messageId: number }>>,
  resolve: (outcome: RequestPermissionResponse) => void,
  expirePermissionCards?: (
    summary: string,
    messages: Array<{ chatId: number; messageId: number }>,
  ) => Promise<void>,
): Promise<void> {
  const summary = sanitizePermissionText(
    request.toolCall.title
      ?? JSON.stringify(request.toolCall.rawInput ?? "permission request"),
    config.PERMISSION_SUMMARY_MAX,
  );
  const id = messageSafeRandom();
  const messages = await sendPermissionCard(summary, id, request.options);

  const timer = setTimeout(() => {
    const current = takePendingPermission(id);
    if (!current) return;
    void (async () => {
      if (expirePermissionCards) {
        try {
          await expirePermissionCards(current.summary, current.messages);
        } catch (error: unknown) {
          console.warn(`[TG] Permission expiry cleanup failed: ${sanitizedError(error)}`);
        }
      }
      writeHealthSnapshot(config, "permission-timeout", { connected: true }, { force: true });
      current.resolve({ outcome: { outcome: "cancelled" } });
    })();
  }, config.PERMISSION_TIMEOUT_MS);
  timer.unref();

  const pending: PendingPermissionState = {
    id,
    kind: request.toolCall.kind ?? "tool",
    summary,
    startedAt: nowIso(),
    timer,
    resolve: (outcome) => {
      clearTimeout(timer);
      setPendingPermission(null);
      resolve(outcome);
    },
    messages,
    rawRequest: request,
  };
  setPendingPermission(pending);
  writeHealthSnapshot(config, "permission-requested", {
    connected: true,
  }, { force: true });
}
