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
import { buildAgentLaunch } from "./agent-launch.js";
import { messageSafeRandom, nowIso, sleep } from "./utils.js";
import { sanitizedError, sanitizePermissionText } from "./redact.js";
import {
  takePendingPermission,
  cancelPendingPermissionState,
  getPendingPermission,
  setPendingPermission,
  updateActivePromptActivity,
  writeHealthSnapshot,
  getSessionCwd,
  type PendingPermissionState,
} from "./state.js";
import type { PromptCapabilities, RootIdentity } from "./media.js";
import { verifyProcessCwdIdentity } from "./platform-security.js";

export { verifyProcessCwdIdentity } from "./platform-security.js";

export interface PermissionRequest {
  sessionId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
  connectionGeneration: number;
  promptEpoch: number;
}

interface AcpHandlers {
  onSessionUpdate: (update: SessionUpdate) => void;
  onPermissionRequest: (request: PermissionRequest) => Promise<RequestPermissionResponse>;
  onEvent: (kind: string) => void;
  getExpectedRootIdentity: () => RootIdentity;
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

async function exitsWithin(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    exited.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

export function childExitBarrier(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

export async function terminateChildProcess(
  running: Pick<ChildProcess, "kill">,
  exited: Promise<void>,
  graceMs = 3_000,
  killWaitMs = 3_000,
): Promise<void> {
  try {
    running.kill("SIGTERM");
  } catch (error: unknown) {
    console.warn(`[ACP] Failed to terminate agent process: ${sanitizedError(error)}`);
  }
  let provenExited = await exitsWithin(exited, graceMs);
  if (!provenExited) {
    try {
      running.kill("SIGKILL");
    } catch (error: unknown) {
      console.warn(`[ACP] Failed to kill unresponsive agent process: ${sanitizedError(error)}`);
    }
    provenExited = await exitsWithin(exited, killWaitMs);
  }
  if (!provenExited) throw new Error("ACP child process did not exit after SIGKILL");
}

export interface AcpRuntimeHooks {
  beforeSpawn?: () => Promise<void>;
  spawn?: typeof spawn;
}

export function createAcpClient(
  config: Config,
  handlers: AcpHandlers,
  runtime: AcpRuntimeHooks = {},
): AcpClientHandle {
  let child: ChildProcess | null = null;
  let childExit: Promise<void> | null = null;
  let connection: acp.ClientConnection | null = null;
  let context: acp.ClientContext | null = null;
  let session: acp.ActiveSession | null = null;
  let sessionId: string | null = null;
  let connected = false;
  let generation = 0;
  let promptEpoch = 0;
  let activePromptGeneration: number | null = null;
  let activePromptEpoch: number | null = null;
  let promptCapabilities: PromptCapabilities = {};
  let sessionCwd = getSessionCwd(config.agentCwdAbs);
  let lifecycleEpoch = 0;
  let lifecycleTail: Promise<void> = Promise.resolve();

  function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = lifecycleTail.then(operation);
    lifecycleTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function withSetupTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), config.API_TIMEOUT_MS);
      timer.unref();
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function stopChild(): Promise<void> {
    const running = child;
    const exited = childExit;
    if (!running) return;
    if (!exited) throw new Error("ACP child exit monitor is unavailable");

    if (running.pid) {
      await terminateChildProcess(running, exited);
    } else {
      await exited;
    }
    if (child === running) child = null;
    if (childExit === exited) childExit = null;
  }

  async function connectUnlocked(expectedLifecycleEpoch: number): Promise<void> {
    if (expectedLifecycleEpoch !== lifecycleEpoch) {
      throw new Error("ACP connection attempt was superseded by shutdown");
    }
    if (connected && session && context) return;
    await shutdownUnlocked();
    if (expectedLifecycleEpoch !== lifecycleEpoch) {
      throw new Error("ACP connection attempt was superseded by shutdown");
    }
    if (activePromptGeneration !== null) {
      throw new Error("Previous ACP prompt task has not settled");
    }

    const launch = buildAgentLaunch(config, sessionCwd);
    const expectedRoot = handlers.getExpectedRootIdentity();
    if (expectedRoot.path !== sessionCwd) {
      throw new Error("ACP CWD path does not match its authorized root identity");
    }
    await runtime.beforeSpawn?.();
    if (expectedLifecycleEpoch !== lifecycleEpoch) {
      throw new Error("ACP connection attempt was superseded by shutdown");
    }
    const spawned = (runtime.spawn ?? spawn)(launch.command, launch.args, {
      cwd: sessionCwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env,
      shell: false,
    });
    const connectionGeneration = ++generation;
    child = spawned;
    const exited = childExitBarrier(spawned);
    const spawnReady = new Promise<void>((resolve, reject) => {
      spawned.once("spawn", () => resolve());
      spawned.once("error", reject);
    });
    childExit = exited;
    spawned.on("error", (error: Error) => {
      handlers.onEvent(`process.error:${sanitizedError(error, 200)}`);
    });
    spawned.stderr?.on("data", (chunk: Buffer) => {
      const line = sanitizePermissionText(chunk.toString("utf8"), 1000);
      if (line) console.error(`[${config.agentProvider.toUpperCase()}] ${line}`);
    });
    spawned.once("exit", (code, signal) => {
      if (child === spawned && generation === connectionGeneration) {
        connected = false;
        session = null;
        context = null;
        sessionId = null;
        connection = null;
      }
      handlers.onEvent(`process.exit:${code ?? signal ?? "unknown"}`);
    });

    try {
      await spawnReady;
      if (expectedLifecycleEpoch !== lifecycleEpoch) {
        throw new Error("ACP connection attempt was superseded by shutdown");
      }
      verifyProcessCwdIdentity(spawned.pid, expectedRoot);
    } catch (error: unknown) {
      if (spawned.pid) {
        await stopChild();
      } else if (child === spawned) {
        child = null;
        childExit = null;
        generation += 1;
      }
      throw error;
    }

    let setupConnection: acp.ClientConnection | null = null;
    try {
      const stream = acp.ndJsonStream(
      Writable.toWeb(spawned.stdin!),
      Readable.toWeb(spawned.stdout!),
    );
    const app = acp
      .client({ name: "agent-telegram-bridge" })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        handlers.onEvent("permission.request");
        const requestPromptEpoch = activePromptEpoch;
        if (generation !== connectionGeneration
          || activePromptGeneration !== connectionGeneration
          || requestPromptEpoch === null) {
          return { outcome: { outcome: "cancelled" } };
        }
        const response = await handlers.onPermissionRequest({
          ...params,
          connectionGeneration,
          promptEpoch: requestPromptEpoch,
        });
        if (generation !== connectionGeneration
          || activePromptGeneration !== connectionGeneration
          || activePromptEpoch !== requestPromptEpoch) {
          cancelPendingPermissionState(connectionGeneration, requestPromptEpoch);
          return { outcome: { outcome: "cancelled" } };
        }
        return response;
      });

    const nextConnection = app.connect(stream);
    setupConnection = nextConnection;
    const nextContext = nextConnection.agent;
    if (!nextContext) throw new Error("ACP agent connection unavailable");
    const initialized = await withSetupTimeout(
      nextContext.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "agent-telegram-bridge", version: "0.1.0" },
      }),
      "ACP initialize",
    );
    if (child !== spawned || generation !== connectionGeneration
      || expectedLifecycleEpoch !== lifecycleEpoch) {
      throw new Error("ACP connection attempt was superseded during initialization");
    }
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(`Unsupported ACP protocol ${initialized.protocolVersion}`);
    }
    const caps = initialized.agentCapabilities?.promptCapabilities;
    promptCapabilities = {
      image: caps?.image === true,
      audio: caps?.audio === true,
      embeddedContext: caps?.embeddedContext === true,
    };
    const nextSession = await withSetupTimeout(
      nextContext.buildSession(sessionCwd).start(),
      "ACP session start",
    );
    if (child !== spawned || generation !== connectionGeneration
      || expectedLifecycleEpoch !== lifecycleEpoch) {
      nextSession.dispose();
      nextConnection.close();
      throw new Error("ACP process exited during connection setup");
    }
    connection = nextConnection;
    context = nextContext;
    session = nextSession;
    sessionId = nextSession.sessionId;
    connected = true;
    console.log(
      `[ACP] ${config.agentDisplayName} session ${sessionId} connected (provider=${config.agentProvider}) cwd=${sessionCwd} caps=${JSON.stringify(promptCapabilities)}`,
    );
    writeHealthSnapshot(config, "acp-session-created", {
      connected: true,
      acpSessionId: sessionId,
    }, { force: true });
    } catch (error: unknown) {
      try {
        setupConnection?.close();
      } catch (closeError: unknown) {
        console.warn(`[ACP] Failed to close incomplete connection: ${sanitizedError(closeError)}`);
      }
      connected = false;
      connection = null;
      context = null;
      session = null;
      sessionId = null;
      await stopChild();
      throw error;
    }
  }

  async function sendPrompt(
    prompt: string | ContentBlock | ContentBlock[],
  ): Promise<PromptResponse> {
    await connect();
    const promptSession = session;
    const promptGeneration = generation;
    if (!promptSession || activePromptGeneration !== null) {
      throw new Error(activePromptGeneration !== null ? "A prompt is already active" : "No ACP session");
    }
    const currentPromptEpoch = ++promptEpoch;
    activePromptGeneration = promptGeneration;
    activePromptEpoch = currentPromptEpoch;
    try {
      handlers.onEvent("prompt.sent");
      const completion = promptSession.prompt(prompt);
      for (;;) {
        const message = await promptSession.nextUpdate();
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
      if (activePromptGeneration === promptGeneration) activePromptGeneration = null;
      if (activePromptEpoch === currentPromptEpoch) activePromptEpoch = null;
    }
  }

  async function cancelCurrent(): Promise<void> {
    const currentContext = context;
    const currentSessionId = sessionId;
    if (!currentContext || !currentSessionId || activePromptGeneration === null) return;
    await withSetupTimeout(
      currentContext.notify(acp.methods.agent.session.cancel, { sessionId: currentSessionId }),
      "ACP cancel",
    );
    handlers.onEvent("prompt.cancelled");
  }

  async function waitForIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (activePromptGeneration !== null && Date.now() < deadline) {
      await sleep(100);
    }
    return activePromptGeneration === null;
  }

  async function shutdownUnlocked(): Promise<void> {
    connected = false;
    const closingSession = session;
    const closingConnection = connection;
    session = null;
    sessionId = null;
    context = null;
    connection = null;
    generation += 1;
    try {
      closingSession?.dispose();
    } catch (error: unknown) {
      console.warn(`[ACP] Failed to dispose session: ${sanitizedError(error)}`);
    }
    try {
      closingConnection?.close();
    } catch (error: unknown) {
      console.warn(`[ACP] Failed to close connection: ${sanitizedError(error)}`);
    }
    await stopChild();
  }

  function connect(): Promise<void> {
    const expectedLifecycleEpoch = lifecycleEpoch;
    return serializeLifecycle(() => connectUnlocked(expectedLifecycleEpoch));
  }

  function shutdown(): Promise<void> {
    lifecycleEpoch += 1;
    return serializeLifecycle(shutdownUnlocked);
  }

  function restart(): Promise<void> {
    const expectedLifecycleEpoch = ++lifecycleEpoch;
    return serializeLifecycle(async () => {
      await shutdownUnlocked();
      if (activePromptGeneration !== null) {
        throw new Error("Cannot restart ACP before the active prompt task settles");
      }
      await sleep(200);
      await connectUnlocked(expectedLifecycleEpoch);
    });
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
    isPromptRunning: () => activePromptGeneration !== null,
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
  if (getPendingPermission()) {
    resolve({ outcome: { outcome: "cancelled" } });
    throw new Error("A permission request is already pending");
  }

  let resolved = false;
  const finish = (outcome: RequestPermissionResponse) => {
    if (resolved) return;
    resolved = true;
    resolve(outcome);
  };
  const timer = setTimeout(() => {
    const current = takePendingPermission(id);
    if (!current) return;
    current.resolve({ outcome: { outcome: "cancelled" } });
    writeHealthSnapshot(config, "permission-timeout", { connected: true }, { force: true });
    if (expirePermissionCards) {
      void expirePermissionCards(current.summary, current.messages).catch((error: unknown) => {
        console.warn(`[TG] Permission expiry cleanup failed: ${sanitizedError(error)}`);
      });
    }
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
      takePendingPermission(id);
      finish(outcome);
    },
    messages: [],
    connectionGeneration: request.connectionGeneration,
    promptEpoch: request.promptEpoch,
    rawRequest: request,
  };
  setPendingPermission(pending);
  writeHealthSnapshot(config, "permission-registering", {
    connected: true,
  }, { force: true });

  try {
    const messages = await sendPermissionCard(summary, id, request.options);
    const current = getPendingPermission();
    if (!current || current.id !== id) {
      if (expirePermissionCards) await expirePermissionCards(summary, messages);
      return;
    }
    current.messages.push(...messages);
    writeHealthSnapshot(config, "permission-requested", {
      connected: true,
    }, { force: true });
  } catch (error: unknown) {
    const current = takePendingPermission(id);
    if (current) current.resolve({ outcome: { outcome: "cancelled" } });
    throw error;
  }
}
