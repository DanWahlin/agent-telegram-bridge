import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  lstatSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { hostname, platform } from "node:os";
import { z, type ZodType } from "zod";
import type { PermissionOption, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { Config } from "./config.js";
import type { InboxFile } from "./media.js";
import {
  acquireOwnershipLock,
  getProcessStartToken,
  releaseOwnershipLock,
} from "./platform-security.js";
import { nowIso, ageMs, messageSafeRandom } from "./utils.js";
import { sanitizedError, sanitizePermissionText } from "./redact.js";

export interface AccessState {
  allowedUsers: string[];
  pending: Record<string, { code: string; timestamp: number; attempts?: number | undefined }>;
}

export interface LockData {
  pid: number;
  sessionId: string;
  botName?: string | undefined;
  hostname: string;
  processStartToken: string | null;
  processStartTokenSource: string;
  connectedAt: string;
  updatedAt: string;
}

export interface HealthSnapshot {
  reason: string;
  updatedAt: string;
  connected: boolean;
  pid: number;
  sessionId: string | null;
  botName: string | null;
  botUsername: string | null;
  hostname: string;
  lastPollAt: string | null;
  lastUpdateAt: string | null;
  lastInboundPromptAt: string | null;
  lastAcpEventAt: string | null;
  lastToolEventAt: string | null;
  typingActive: boolean;
  typingAgeMs: number | null;
  activePrompt: {
    id: string;
    chatId: number;
    messageId: number;
    startedAt: string;
    lastActivityAt: string | null;
    warningSent: boolean;
    progressNoticeCount: number;
    lastProgressNoticeAt: string | null;
    ageMs: number | null;
    activityAgeMs: number | null;
    stale: boolean;
  } | null;
  pendingPermission: {
    id: string;
    kind: string;
    summary: string;
    startedAt: string;
    ageMs: number | null;
    messageCount: number;
  } | null;
  acpSessionId: string | null;
  queueDepth: number;
  cwd: string | null;
  verbose: boolean;
  modeId: string | null;
  usage: { used: number; size: number; costAmount?: number; currency?: string } | null;
  likelyState: string;
}

const DEFAULT_ACCESS: AccessState = { allowedUsers: [], pending: {} };
const PendingPairingSchema = z.object({
  code: z.string().min(1),
  timestamp: z.number().finite(),
  attempts: z.number().int().nonnegative().optional(),
});
const AccessStateSchema: ZodType<AccessState> = z.object({
  allowedUsers: z.array(z.string()),
  pending: z.record(z.string(), PendingPairingSchema),
});
const LockDataSchema: ZodType<LockData> = z.object({
  pid: z.number().int().positive(),
  sessionId: z.string().min(1),
  botName: z.string().optional(),
  hostname: z.string(),
  processStartToken: z.string().nullable(),
  processStartTokenSource: z.string(),
  connectedAt: z.string(),
  updatedAt: z.string(),
});

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function loadJsonOrDefault<T>(
  filePath: string,
  defaultValue: T,
  schema: ZodType<T>,
): T {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
    const validated = schema.safeParse(parsed);
    if (validated.success) return validated.data;
    console.warn(`agent-telegram: invalid state shape in ${filePath}, using defaults`);
    return structuredClone(defaultValue);
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "ENOENT") return structuredClone(defaultValue);
    if (err instanceof SyntaxError) {
      console.warn(`agent-telegram: corrupted JSON in ${filePath}, using defaults`);
      return structuredClone(defaultValue);
    }
    throw err;
  }
}

export function saveJsonAtomic(filePath: string, data: unknown, mode = 0o600): void {
  const dir = join(filePath, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`Refusing symlink state directory: ${dir}`);
  chmodSync(dir, 0o700);
  const tmp = `${filePath}.${process.pid}.${messageSafeRandom()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode, flag: "wx" });
    chmodSync(tmp, mode);
    renameSync(tmp, filePath);
    chmodSync(filePath, mode);
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch (error: unknown) {
      console.warn(`agent-telegram: failed to remove temporary state file: ${sanitizedError(error)}`);
    }
  }
}

export function ensureStateDir(config: Config): void {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  if (lstatSync(config.stateDir).isSymbolicLink()) throw new Error("STATE_DIR may not be a symlink");
  chmodSync(config.stateDir, 0o700);
}

export function accessPath(config: Config): string {
  return join(config.stateDir, "access.json");
}
export function lockPath(config: Config): string {
  return join(config.stateDir, "lock.json");
}
export function healthPath(config: Config): string {
  return join(config.stateDir, "health.json");
}

export function reloadAccess(config: Config): AccessState {
  return loadJsonOrDefault(accessPath(config), DEFAULT_ACCESS, AccessStateSchema);
}

export function saveAccess(config: Config, access: AccessState): void {
  saveJsonAtomic(accessPath(config), access, 0o600);
}

export function isAllowed(access: AccessState, userId: number | string): boolean {
  return access.allowedUsers.includes(String(userId));
}

export function cleanExpiredPending(config: Config, access: AccessState): boolean {
  const now = Date.now();
  let changed = false;
  for (const [chatId, entry] of Object.entries(access.pending || {})) {
    if (now - entry.timestamp > config.PAIRING_EXPIRY_MS) {
      delete access.pending[chatId];
      changed = true;
    }
  }
  if (changed) saveAccess(config, access);
  return changed;
}

export function startPairing(config: Config, access: AccessState, chatId: number | string): string {
  const chatIdStr = String(chatId);
  const code = messageSafeRandom().slice(0, 6).toUpperCase();
  if (!access.pending) access.pending = {};
  if (!(chatIdStr in access.pending)) {
    const entries = Object.entries(access.pending)
      .sort(([, a], [, b]) => a.timestamp - b.timestamp);
    while (entries.length >= config.PAIRING_PENDING_MAX) {
      const oldest = entries.shift();
      if (oldest) delete access.pending[oldest[0]];
    }
  }
  access.pending[chatIdStr] = { code, timestamp: Date.now(), attempts: 0 };
  saveAccess(config, access);
  return code;
}

export function completePairing(
  config: Config,
  access: AccessState,
  chatId: number | string,
  userId: number | string,
  code: string
): boolean {
  const chatIdStr = String(chatId);
  const userIdStr = String(userId);
  const pending = access.pending?.[chatIdStr];
  if (!pending) return false;
  if (Date.now() - pending.timestamp > config.PAIRING_EXPIRY_MS) {
    delete access.pending[chatIdStr];
    saveAccess(config, access);
    return false;
  }
  if (pending.code.toUpperCase() !== code.toUpperCase()) {
    pending.attempts = (pending.attempts ?? 0) + 1;
    if (pending.attempts >= 5) delete access.pending[chatIdStr];
    saveAccess(config, access);
    return false;
  }
  if (!access.allowedUsers.includes(userIdStr)) {
    access.allowedUsers.push(userIdStr);
  }
  delete access.pending[chatIdStr];
  saveAccess(config, access);
  return true;
}

// --- Lock management ---

interface OwnershipLease {
  token: bigint;
  sessionId: string;
}

const ownershipLeases = new Map<string, OwnershipLease>();

function ownershipLockPath(config: Config): string {
  return `${lockPath(config)}.ownership`;
}

export function createLockData(
  sessionId: string,
  connectedAt = nowIso()
): LockData {
  const processStartToken = getProcessStartToken(process.pid);
  if (!processStartToken) {
    throw new Error(`Could not prove process start identity on ${platform()}`);
  }
  return {
    pid: process.pid,
    sessionId,
    hostname: hostname(),
    processStartToken,
    processStartTokenSource: platform(),
    connectedAt,
    updatedAt: nowIso(),
  };
}

export function acquireLock(config: Config, sessionId: string): void {
  const path = lockPath(config);
  const data = createLockData(sessionId);
  if (ownershipLeases.has(path)) {
    throw new Error("Bot is already locked by this process");
  }
  let token: bigint;
  try {
    token = acquireOwnershipLock(ownershipLockPath(config));
  } catch (error: unknown) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "OWNERSHIP_LOCK_HELD") {
      const existing = readLock(config);
      const owner = existing
        ? ` by pid ${existing.pid} on ${existing.hostname}`
        : "";
      throw new Error(`Bot is already locked${owner}: ${sanitizedError(error)}`);
    }
    throw new Error(`Could not acquire bot ownership lock: ${sanitizedError(error)}`);
  }
  const lease: OwnershipLease = { token, sessionId };
  ownershipLeases.set(path, lease);
  try {
    saveJsonAtomic(path, data, 0o600);
  } catch (error: unknown) {
    ownershipLeases.delete(path);
    releaseOwnershipLock(lease.token);
    throw error;
  }
}

export function readLock(config: Config): LockData | null {
  return loadJsonOrDefault<LockData | null>(
    lockPath(config),
    null,
    LockDataSchema.nullable(),
  );
}

export function lockOwnedByCurrentProcess(lock: LockData | null, sessionId: string): boolean {
  if (!lock || lock.pid !== process.pid || lock.sessionId !== sessionId) return false;
  if (lock.hostname && lock.hostname !== hostname()) return false;
  if (lock.processStartToken) {
    const current = getProcessStartToken(lock.pid);
    if (!current || current !== lock.processStartToken) return false;
  }
  return true;
}

export function refreshLock(config: Config, sessionId: string): boolean {
  const lease = ownershipLeases.get(lockPath(config));
  if (!lease || lease.sessionId !== sessionId) return false;
  const lock = readLock(config);
  if (!lock || !lockOwnedByCurrentProcess(lock, sessionId)) return false;
  const connectedAt = lock.connectedAt || nowIso();
  saveJsonAtomic(lockPath(config), createLockData(sessionId, connectedAt), 0o600);
  return true;
}

export function removeLock(config: Config, sessionId: string): void {
  const path = lockPath(config);
  const lease = ownershipLeases.get(path);
  if (!lease || lease.sessionId !== sessionId) return;
  const lock = readLock(config);
  try {
    if (lockOwnedByCurrentProcess(lock, sessionId)) {
      rmSync(path, { force: true });
    }
  } catch (error: unknown) {
    console.warn(`agent-telegram: failed to remove lock metadata: ${sanitizedError(error)}`);
  } finally {
    ownershipLeases.delete(path);
    try {
      releaseOwnershipLock(lease.token);
    } catch (error: unknown) {
      console.warn(`agent-telegram: failed to release ownership lock: ${sanitizedError(error)}`);
    }
  }
}

// --- Health ---

let lastHealthWriteAt = 0;
interface ResolvedHealthInput {
  connected: boolean;
  botName: string | null;
  botUsername: string | null;
  acpSessionId: string | null;
  lastPollAt: string | null;
  lastUpdateAt: string | null;
  lastInboundPromptAt: string | null;
  lastAcpEventAt: string | null;
  lastToolEventAt: string | null;
  typingActive: boolean;
}
const healthInputByStateDir = new Map<string, ResolvedHealthInput>();

export interface ActivePromptState {
  id: string;
  chatId: number;
  userId: number;
  messageId: number;
  startedAt: string;
  lastActivityAt: string | null;
  warningSent: boolean;
  progressNoticeCount: number;
  lastProgressNoticeAt: string | null;
  toolCount: number;
  cancelling: boolean;
  staleMessageId: number | null;
  inboxFiles: InboxFile[];
}

export interface QueuedPromptState {
  id: string;
  chatId: number;
  userId: number;
  messageId: number;
  text: string;
  replyContext: string | null;
  /** In-memory admitted attachment leases. */
  inboxFiles: InboxFile[];
  enqueuedAt: string;
}

export interface LastFinalResponse {
  chatId: number;
  text: string;
  savedAt: number;
}

export interface PendingPermissionState {
  id: string;
  kind: string;
  summary: string;
  startedAt: string;
  timer: NodeJS.Timeout;
  resolve: (outcome: RequestPermissionResponse) => void;
  messages: Array<{ chatId: number; messageId: number }>;
  connectionGeneration: number;
  promptEpoch: number;
  rawRequest?: { options: PermissionOption[] };
}

let activePrompt: ActivePromptState | null = null;
let pendingPermission: PendingPermissionState | null = null;
let typingStartedAt: number | null = null;
let promptQueue: QueuedPromptState[] = [];
let lastFinalResponse: LastFinalResponse | null = null;
let verboseMode = false;
let currentModeId: string | null = null;
let lastUsage: { used: number; size: number; costAmount?: number; currency?: string } | null = null;
let sessionCwd: string | null = null;
const planMessageIds = new Map<number, number>();
const thoughtDrafts = new Map<number, { messageId: number | null; text: string; lastEditAt: number }>();

export function getActivePrompt(): ActivePromptState | null {
  return activePrompt;
}
export function setActivePrompt(p: ActivePromptState | null): void {
  activePrompt = p;
}
export function getPendingPermission(): PendingPermissionState | null {
  return pendingPermission;
}
export function takePendingPermission(id?: string): PendingPermissionState | null {
  if (!pendingPermission || (id !== undefined && pendingPermission.id !== id)) return null;
  const current = pendingPermission;
  pendingPermission = null;
  return current;
}
export function cancelPendingPermissionState(
  connectionGeneration?: number,
  promptEpoch?: number,
): PendingPermissionState | null {
  const current = getPendingPermission();
  if (!current
    || (connectionGeneration !== undefined && current.connectionGeneration !== connectionGeneration)
    || (promptEpoch !== undefined && current.promptEpoch !== promptEpoch)) return null;
  const pending = takePendingPermission(current.id);
  if (!pending) return null;
  clearTimeout(pending.timer);
  pending.resolve({ outcome: { outcome: "cancelled" } });
  return pending;
}
export function setPendingPermission(p: PendingPermissionState | null): void {
  pendingPermission = p;
}
export function getTypingStartedAt(): number | null {
  return typingStartedAt;
}
export function setTypingStartedAt(t: number | null): void {
  typingStartedAt = t;
}

export function startActivePrompt(
  chatId: number,
  messageId: number,
  userId = chatId,
  inboxFiles: InboxFile[] = [],
): ActivePromptState {
  const startedAt = nowIso();
  activePrompt = {
    id: messageSafeRandom(),
    chatId,
    userId,
    messageId,
    startedAt,
    lastActivityAt: startedAt,
    warningSent: false,
    progressNoticeCount: 0,
    lastProgressNoticeAt: null,
    toolCount: 0,
    cancelling: false,
    staleMessageId: null,
    inboxFiles,
  };
  return activePrompt;
}

export function clearActivePrompt(): void {
  activePrompt = null;
}

export function markActivePromptCancelling(): void {
  if (activePrompt) activePrompt.cancelling = true;
}

export function incrementActivePromptTools(): void {
  if (activePrompt) activePrompt.toolCount += 1;
}

// --- Prompt queue ---

export function getPromptQueue(): QueuedPromptState[] {
  return promptQueue;
}

export function enqueuePrompt(
  item: Omit<QueuedPromptState, "id" | "enqueuedAt">,
  max: number,
): { ok: true; position: number } | { ok: false; reason: "full" } {
  if (promptQueue.length >= max) return { ok: false, reason: "full" };
  promptQueue.push({
    ...item,
    id: messageSafeRandom(),
    enqueuedAt: nowIso(),
  });
  return { ok: true, position: promptQueue.length };
}

export function dequeuePrompt(): QueuedPromptState | null {
  return promptQueue.shift() ?? null;
}

export function clearPromptQueue(): QueuedPromptState[] {
  const cleared = promptQueue;
  promptQueue = [];
  return cleared;
}

export function promptQueueLength(): number {
  return promptQueue.length;
}

// --- Last final response (for /retry last) ---

export function setLastFinalResponse(response: LastFinalResponse | null): void {
  lastFinalResponse = response;
}

export function getLastFinalResponse(ttlMs: number): LastFinalResponse | null {
  if (!lastFinalResponse) return null;
  if (Date.now() - lastFinalResponse.savedAt > ttlMs) {
    lastFinalResponse = null;
    return null;
  }
  return lastFinalResponse;
}

// --- Verbose / mode / usage / cwd ---

export function getVerboseMode(): boolean {
  return verboseMode;
}
export function setVerboseMode(value: boolean): void {
  verboseMode = value;
}

export function getCurrentModeId(): string | null {
  return currentModeId;
}
export function setCurrentModeId(mode: string | null): void {
  currentModeId = mode;
}

export function getLastUsage(): typeof lastUsage {
  return lastUsage;
}
export function setLastUsage(
  usage: { used: number; size: number; costAmount?: number; currency?: string } | null,
): void {
  lastUsage = usage;
}

export function getSessionCwd(fallback: string): string {
  return sessionCwd ?? fallback;
}
export function setSessionCwd(cwd: string): void {
  sessionCwd = resolvePath(cwd);
}

export function getPlanMessageId(chatId: number): number | null {
  return planMessageIds.get(chatId) ?? null;
}
export function setPlanMessageId(chatId: number, messageId: number | null): void {
  if (messageId == null) planMessageIds.delete(chatId);
  else planMessageIds.set(chatId, messageId);
}

export function getThoughtDraft(chatId: number) {
  return thoughtDrafts.get(chatId) ?? null;
}
export function setThoughtDraft(
  chatId: number,
  draft: { messageId: number | null; text: string; lastEditAt: number } | null,
): void {
  if (!draft) thoughtDrafts.delete(chatId);
  else thoughtDrafts.set(chatId, draft);
}

export function resetSessionUiState(): void {
  planMessageIds.clear();
  thoughtDrafts.clear();
  currentModeId = null;
  lastUsage = null;
}

/** Test helper to reset module-level runtime state. */
export function resetRuntimeStateForTests(): void {
  for (const [path, lease] of ownershipLeases) {
    try {
      releaseOwnershipLock(lease.token);
    } catch {
      // Tests may deliberately compromise or remove a lock.
    }
    ownershipLeases.delete(path);
  }
  activePrompt = null;
  pendingPermission = null;
  typingStartedAt = null;
  promptQueue = [];
  lastFinalResponse = null;
  verboseMode = false;
  currentModeId = null;
  lastUsage = null;
  sessionCwd = null;
  planMessageIds.clear();
  thoughtDrafts.clear();
  healthInputByStateDir.clear();
  lastHealthWriteAt = 0;
}

export interface HealthSnapshotInput {
  connected: boolean;
  botName?: string | null;
  botUsername?: string | null;
  acpSessionId?: string | null;
  lastPollAt?: string | null;
  lastUpdateAt?: string | null;
  lastInboundPromptAt?: string | null;
  lastAcpEventAt?: string | null;
  lastToolEventAt?: string | null;
  typingActive?: boolean;
}

function resolveHealthInput(config: Config, extra: HealthSnapshotInput): ResolvedHealthInput {
  const previous = healthInputByStateDir.get(config.stateDir);
  const resolved: ResolvedHealthInput = {
    connected: extra.connected,
    botName: extra.botName !== undefined ? extra.botName : previous?.botName ?? null,
    botUsername: extra.botUsername !== undefined
      ? extra.botUsername
      : previous?.botUsername ?? null,
    acpSessionId: extra.acpSessionId !== undefined
      ? extra.acpSessionId
      : previous?.acpSessionId ?? null,
    lastPollAt: extra.lastPollAt !== undefined ? extra.lastPollAt : previous?.lastPollAt ?? null,
    lastUpdateAt: extra.lastUpdateAt !== undefined
      ? extra.lastUpdateAt
      : previous?.lastUpdateAt ?? null,
    lastInboundPromptAt: extra.lastInboundPromptAt !== undefined
      ? extra.lastInboundPromptAt
      : previous?.lastInboundPromptAt ?? null,
    lastAcpEventAt: extra.lastAcpEventAt !== undefined
      ? extra.lastAcpEventAt
      : previous?.lastAcpEventAt ?? null,
    lastToolEventAt: extra.lastToolEventAt !== undefined
      ? extra.lastToolEventAt
      : previous?.lastToolEventAt ?? null,
    typingActive: extra.typingActive !== undefined
      ? extra.typingActive
      : previous?.typingActive ?? false,
  };
  healthInputByStateDir.set(config.stateDir, resolved);
  return resolved;
}

export function buildHealthSnapshot(
  config: Config,
  reason: string,
  extra: HealthSnapshotInput,
): HealthSnapshot {
  const resolved = resolveHealthInput(config, extra);
  const ap = activePrompt;
  const pp = pendingPermission;
  const promptAge = ap ? ageMs(ap.startedAt) : null;
  const promptActivityAge = ap ? ageMs(ap.lastActivityAt || ap.startedAt) : null;
  const typingAge = typingStartedAt ? Date.now() - typingStartedAt : null;

  const snapshot: HealthSnapshot = {
    reason,
    updatedAt: nowIso(),
    connected: resolved.connected,
    pid: process.pid,
    sessionId: resolved.acpSessionId,
    botName: resolved.botName,
    botUsername: resolved.botUsername,
    hostname: hostname(),
    lastPollAt: resolved.lastPollAt,
    lastUpdateAt: resolved.lastUpdateAt,
    lastInboundPromptAt: resolved.lastInboundPromptAt,
    lastAcpEventAt: resolved.lastAcpEventAt,
    lastToolEventAt: resolved.lastToolEventAt,
    typingActive: resolved.typingActive,
    typingAgeMs: typingAge,
    activePrompt: ap
      ? {
          id: ap.id,
          chatId: ap.chatId,
          messageId: ap.messageId,
          startedAt: ap.startedAt,
          lastActivityAt: ap.lastActivityAt,
          warningSent: !!ap.warningSent,
          progressNoticeCount: ap.progressNoticeCount || 0,
          lastProgressNoticeAt: ap.lastProgressNoticeAt,
          ageMs: promptAge,
          activityAgeMs: promptActivityAge,
          stale: !!(promptActivityAge != null && promptActivityAge > config.PROMPT_STALE_AFTER_MS),
        }
      : null,
    pendingPermission: pp
      ? {
          id: pp.id,
          kind: pp.kind,
          summary: sanitizePermissionText(pp.summary, config.PERMISSION_SUMMARY_MAX),
          startedAt: pp.startedAt,
          ageMs: ageMs(pp.startedAt),
          messageCount: pp.messages?.length || 0,
        }
      : null,
    acpSessionId: resolved.acpSessionId,
    queueDepth: promptQueue.length,
    cwd: sessionCwd,
    verbose: verboseMode,
    modeId: currentModeId,
    usage: lastUsage,
    likelyState: getLikelyState(resolved.connected, !!pp, !!(promptActivityAge != null && promptActivityAge > config.PROMPT_STALE_AFTER_MS), !!ap),
  };
  return snapshot;
}

export function getLikelyState(
  connected: boolean,
  pendingPerm: boolean,
  promptStale: boolean,
  hasActivePrompt: boolean
): string {
  if (!connected) return "disconnected";
  if (pendingPerm) return "waiting for Telegram approval";
  if (promptStale) return "ACP session stalled";
  if (hasActivePrompt) return "waiting for ACP response";
  return "healthy/idle";
}

export function writeHealthSnapshot(
  config: Config,
  reason: string,
  extra: HealthSnapshotInput,
  { force = true }: { force?: boolean } = {}
): void {
  const now = Date.now();
  if (!force && now - lastHealthWriteAt < config.HEALTH_WRITE_MIN_INTERVAL_MS) return;
  try {
    ensureStateDir(config);
    const snap = buildHealthSnapshot(config, reason, extra);
    saveJsonAtomic(healthPath(config), snap, 0o600);
    lastHealthWriteAt = now;
  } catch (err: unknown) {
    console.error(`agent-telegram: failed to write health snapshot: ${sanitizedError(err)}`);
  }
}

export function updateActivePromptActivity() {
  if (activePrompt) {
    activePrompt.lastActivityAt = nowIso();
  }
}
