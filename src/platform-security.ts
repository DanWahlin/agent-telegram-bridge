import { readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { RootIdentity } from "./media.js";

export type SupportedHostPlatform = "linux" | "darwin";

export interface DarwinProcessIdentity {
  startSeconds: bigint;
  startMicroseconds: bigint;
  cwdDev: bigint;
  cwdIno: bigint;
}

interface PlatformSecurityAddon {
  inspect: (pid: number) => unknown;
  acquireLock: (path: string) => unknown;
  releaseLock: (token: bigint) => void;
}

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
  isDirectory: () => boolean;
}

export interface PlatformSecurityRuntime {
  hostPlatform?: NodeJS.Platform;
  readTextFile?: (path: string) => string;
  inspectDarwin?: (pid: number) => DarwinProcessIdentity;
  statDirectory?: (path: string) => DirectoryIdentity;
}

let cachedOwnProcessStartToken: string | null | undefined;
let loadedPlatformAddon: PlatformSecurityAddon | undefined;

export function normalizeSupportedPlatform(
  hostPlatform: NodeJS.Platform = platform(),
): SupportedHostPlatform {
  if (hostPlatform === "linux" || hostPlatform === "darwin") return hostPlatform;
  if (hostPlatform === "win32") {
    throw new Error("Native Windows is not supported; run Agent Telegram Bridge inside WSL2");
  }
  throw new Error(`Unsupported host platform: ${hostPlatform}`);
}

export function parseLinuxProcessStartToken(stat: string): string | null {
  const lastParen = stat.lastIndexOf(")");
  if (lastParen === -1) return null;
  const fields = stat.slice(lastParen + 2).trim().split(/\s+/);
  const startTime = fields[19];
  return startTime ? `linux:${startTime}` : null;
}

export function validateDarwinProcessIdentity(value: unknown): DarwinProcessIdentity {
  if (!value || typeof value !== "object") {
    throw new Error("Darwin process addon returned an invalid identity record");
  }
  const candidate = value as Partial<DarwinProcessIdentity>;
  for (const key of ["startSeconds", "startMicroseconds", "cwdDev", "cwdIno"] as const) {
    if (typeof candidate[key] !== "bigint" || candidate[key] < 0n) {
      throw new Error("Darwin process addon returned an invalid identity record");
    }
  }
  if (candidate.startSeconds === 0n || candidate.cwdIno === 0n) {
    throw new Error("Darwin process addon returned an incomplete identity record");
  }
  return candidate as DarwinProcessIdentity;
}

function platformAddonPath(moduleUrl = import.meta.url): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const outputDir = basename(dirname(moduleDir)) === "dist"
    ? resolve(moduleDir, "../native")
    : resolve(moduleDir, "../dist/native");
  return resolve(outputDir, "platform_security.node");
}

function getPlatformAddon(): PlatformSecurityAddon {
  if (loadedPlatformAddon) return loadedPlatformAddon;
  const require = createRequire(import.meta.url);
  const loaded: unknown = require(platformAddonPath());
  if (!loaded || typeof loaded !== "object"
      || typeof (loaded as { inspect?: unknown }).inspect !== "function"
      || typeof (loaded as { acquireLock?: unknown }).acquireLock !== "function"
      || typeof (loaded as { releaseLock?: unknown }).releaseLock !== "function") {
    throw new Error("Platform security addon has an invalid interface");
  }
  loadedPlatformAddon = loaded as PlatformSecurityAddon;
  return loadedPlatformAddon;
}

function inspectDarwinProcess(pid: number): DarwinProcessIdentity {
  return validateDarwinProcessIdentity(getPlatformAddon().inspect(pid));
}

export function initializePlatformSecurity(
  hostPlatform: NodeJS.Platform = platform(),
): SupportedHostPlatform {
  const supported = normalizeSupportedPlatform(hostPlatform);
  getPlatformAddon();
  if (supported === "darwin") {
    const identity = inspectDarwinProcess(process.pid);
    cachedOwnProcessStartToken = `darwin:${identity.startSeconds}:${identity.startMicroseconds}`;
  }
  return supported;
}

export function acquireOwnershipLock(path: string): bigint {
  const token = getPlatformAddon().acquireLock(path);
  if (typeof token !== "bigint" || token <= 0n) {
    throw new Error("Platform security addon returned an invalid ownership token");
  }
  return token;
}

export function releaseOwnershipLock(token: bigint): void {
  getPlatformAddon().releaseLock(token);
}

export function getProcessStartToken(
  pid: number,
  runtime: PlatformSecurityRuntime = {},
): string | null {
  const cacheable = pid === process.pid && Object.keys(runtime).length === 0;
  if (cacheable && cachedOwnProcessStartToken !== undefined) return cachedOwnProcessStartToken;
  const hostPlatform = runtime.hostPlatform ?? platform();
  try {
    let token: string | null = null;
    if (hostPlatform === "linux") {
      const readTextFile = runtime.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
      token = parseLinuxProcessStartToken(readTextFile(`/proc/${pid}/stat`));
    } else if (hostPlatform === "darwin") {
      const inspect = runtime.inspectDarwin ?? inspectDarwinProcess;
      const identity = validateDarwinProcessIdentity(inspect(pid));
      token = `darwin:${identity.startSeconds}:${identity.startMicroseconds}`;
    }
    if (cacheable) cachedOwnProcessStartToken = token;
    return token;
  } catch {
    if (cacheable) cachedOwnProcessStartToken = null;
    return null;
  }
}

export function verifyProcessCwdIdentity(
  pid: number | undefined,
  expected: RootIdentity,
  runtime: PlatformSecurityRuntime = {},
): void {
  const hostPlatform = normalizeSupportedPlatform(runtime.hostPlatform ?? platform());
  if (!pid) throw new Error("ACP child PID is unavailable");

  if (hostPlatform === "darwin") {
    const inspect = runtime.inspectDarwin ?? inspectDarwinProcess;
    const identity = validateDarwinProcessIdentity(inspect(pid));
    if (identity.cwdDev !== expected.dev || identity.cwdIno !== expected.ino) {
      throw new Error("ACP child started outside the authorized CWD identity");
    }
    return;
  }

  const statDirectory = runtime.statDirectory
    ?? ((path: string) => statSync(path, { bigint: true }));
  const actual = statDirectory(`/proc/${pid}/cwd`);
  if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error("ACP child started outside the authorized CWD identity");
  }
}
