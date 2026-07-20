import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { platform } from "node:os";
import type { RootIdentity } from "./media.js";

export type SupportedHostPlatform = "linux" | "darwin";

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
  isDirectory: () => boolean;
}

export interface PlatformSecurityRuntime {
  hostPlatform?: NodeJS.Platform;
  readTextFile?: (path: string) => string;
  execText?: (file: string, args: string[]) => string;
  realpath?: (path: string) => string;
  statDirectory?: (path: string) => DirectoryIdentity;
}

let cachedOwnProcessStartToken: string | null | undefined;

function defaultExecText(file: string, args: string[]): string {
  return execFileSync(file, args, {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LC_ALL: "C",
    },
  });
}

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

export function parseMacProcessStartToken(output: string): string | null {
  const started = output.trim().replace(/\s+/g, " ");
  return started ? `darwin:${started}` : null;
}

export function parseMacCwdLsof(output: string): string {
  const fields = output.includes("\0")
    ? output.split("\0").map((field) => field.replace(/^\r?\n/, ""))
    : output.split(/\r?\n/);
  const paths = fields
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1))
    .filter(Boolean);
  if (paths.length !== 1) {
    throw new Error("Could not determine the ACP child CWD from macOS lsof output");
  }
  return paths[0]!;
}

export function getProcessStartToken(
  pid: number,
  runtime: PlatformSecurityRuntime = {},
): string | null {
  const cacheable = pid === process.pid && Object.keys(runtime).length === 0;
  if (cacheable && cachedOwnProcessStartToken !== undefined) {
    return cachedOwnProcessStartToken;
  }
  const hostPlatform = runtime.hostPlatform ?? platform();
  try {
    if (hostPlatform === "linux") {
      const readTextFile = runtime.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
      const token = parseLinuxProcessStartToken(readTextFile(`/proc/${pid}/stat`));
      if (cacheable) cachedOwnProcessStartToken = token;
      return token;
    }
    if (hostPlatform === "darwin") {
      const execText = runtime.execText ?? defaultExecText;
      const token = parseMacProcessStartToken(
        execText("/bin/ps", ["-p", String(pid), "-o", "lstart="]),
      );
      if (cacheable) cachedOwnProcessStartToken = token;
      return token;
    }
    if (cacheable) cachedOwnProcessStartToken = null;
    return null;
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

  const statDirectory = runtime.statDirectory
    ?? ((path: string) => statSync(path, { bigint: true }));
  let actualPath: string;

  if (hostPlatform === "linux") {
    actualPath = `/proc/${pid}/cwd`;
  } else {
    const execText = runtime.execText ?? defaultExecText;
    const realpath = runtime.realpath ?? realpathSync;
    const reportedPath = parseMacCwdLsof(
      execText("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-F0n"]),
    );
    actualPath = realpath(reportedPath);
  }

  const actual = statDirectory(actualPath);
  if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error("ACP child started outside the authorized CWD identity");
  }
}
