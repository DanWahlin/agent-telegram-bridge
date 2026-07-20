import { z } from "zod";
import { resolve } from "node:path";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { platform } from "node:os";
import dotenv from "dotenv";
import { parseCwdAllowlist, parseMimeAllowlist } from "./media.js";
import {
  assertRuntimePathsOutsideBuildOutput,
  getBuildOutputDir,
} from "./path-safety.js";

dotenv.config();

export const AGENT_PROVIDERS = ["grok", "copilot"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

const boolFromString = (v: string) => v === "true" || v === "1" || v === "yes";

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10, "TELEGRAM_BOT_TOKEN is required"),
  AGENT_PROVIDER: z.enum(AGENT_PROVIDERS).default("grok"),
  AGENT_CWD: z.string().default(process.cwd()),
  AGENT_BIN: z.string().default(""),
  AGENT_MODEL: z.string().default("grok-4.5"),
  AGENT_DISPLAY_NAME: z.string().default(""),
  STATE_DIR: z.string().default(resolve(process.cwd(), ".agent-telegram-state")),
  AGENT_CWD_ALLOWLIST: z.string().default(""),
  AGENT_ALWAYS_APPROVE: z
    .string()
    .default("false")
    .transform(boolFromString),
  // Timing controls (ms)
  PAIRING_EXPIRY_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  PAIRING_PENDING_MAX: z.coerce.number().int().positive().max(1000).default(100),
  PERMISSION_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  PROMPT_STALE_AFTER_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  MAX_TYPING_SESSION_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  STREAM_EDIT_INTERVAL_MS: z.coerce.number().int().positive().default(1500),
  STREAM_MIN_DELTA_CHARS: z.coerce.number().int().positive().default(24),
  STREAM_DRAFT_MAX: z.coerce.number().int().positive().default(3800),
  // Mobile-friendly default: first progress notice at 90s
  PROGRESS_NOTICE_AFTER_MS: z.coerce.number().int().positive().default(90 * 1000),
  PROGRESS_NOTICE_INTERVAL_MS: z.coerce.number().int().positive().default(2 * 60 * 1000),
  PROGRESS_NOTICE_ITERATION_MS: z.coerce.number().int().positive().default(60 * 1000),
  PROGRESS_NOTICE_MAX_ITERATIONS: z.coerce.number().int().positive().default(90),
  SEND_PACE_MS: z.coerce.number().int().nonnegative().default(50),
  TELEGRAM_OUTBOUND_QUEUE_MAX: z.coerce.number().int().positive().max(1000).default(100),
  TELEGRAM_RETRY_MAX: z.coerce.number().int().nonnegative().max(5).default(5),
  ASSISTANT_TEXT_MAX_CHARS: z.coerce.number().int().positive().max(1_000_000).default(200_000),
  TYPING_INTERVAL_MS: z.coerce.number().int().positive().default(4000),
  TYPING_DEBOUNCE_MS: z.coerce.number().int().positive().default(60000),
  HEALTH_WRITE_MIN_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  API_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(30_000),
  PERMISSION_SUMMARY_MAX: z.coerce.number().int().positive().default(1800),
  // Media / queue / reliability
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().max(50 * 1024 * 1024).default(20 * 1024 * 1024),
  MEDIA_MIME_ALLOWLIST: z.string().default(""),
  PROMPT_QUEUE_MAX: z.coerce.number().int().nonnegative().max(100).default(3),
  CANCEL_WAIT_MS: z.coerce.number().int().positive().max(30_000).default(15_000),
  RETRY_LAST_TTL_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  WATCHDOG_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  BUBBLE_DEBOUNCE_MS: z.coerce.number().int().positive().default(300),
  THOUGHT_EDIT_INTERVAL_MS: z.coerce.number().int().positive().default(2500),
  VERBOSE_DEFAULT: z
    .string()
    .default("false")
    .transform(boolFromString),
});

export const DEFAULT_DISPLAY_NAMES: Record<AgentProvider, string> = {
  grok: "Grok Build",
  copilot: "GitHub Copilot CLI",
};

export const DEFAULT_AGENT_BINS: Record<AgentProvider, string> = {
  grok: "grok",
  copilot: "/usr/bin/copilot",
};

export type Config = z.infer<typeof EnvSchema> & {
  stateDir: string;
  agentProvider: AgentProvider;
  agentCwdAbs: string;
  agentBin: string;
  agentModel: string;
  agentAlwaysApprove: boolean;
  agentDisplayName: string;
  mimeAllowlist: string[];
  cwdAllowlist: string[];
};

/**
 * Provider-neutral aliasing: first-class AGENT_* variables win, but the legacy
 * GROK_* names remain accepted for Grok migration.
 */
function applyLegacyAliases(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pick = (primary: string, legacy: string) =>
    input[primary] ?? input[legacy];
  return {
    ...input,
    AGENT_CWD: pick("AGENT_CWD", "GROK_CWD"),
    AGENT_BIN: pick("AGENT_BIN", "GROK_BIN"),
    AGENT_MODEL: pick("AGENT_MODEL", "GROK_MODEL"),
    AGENT_ALWAYS_APPROVE: pick("AGENT_ALWAYS_APPROVE", "GROK_ALWAYS_APPROVE"),
    AGENT_CWD_ALLOWLIST: pick("AGENT_CWD_ALLOWLIST", "GROK_CWD_ALLOWLIST"),
  };
}

export function parseEnvironment(input: NodeJS.ProcessEnv) {
  return EnvSchema.parse(applyLegacyAliases(input));
}

export function resolveAgentBinary(
  provider: AgentProvider,
  configured: string,
  home: string | undefined,
  fileExists: (path: string) => boolean = existsSync,
  hostPlatform: NodeJS.Platform = platform(),
): string {
  const trimmed = configured.trim();
  if (provider === "copilot") {
    return trimmed || (hostPlatform === "darwin" ? "copilot" : DEFAULT_AGENT_BINS.copilot);
  }
  if (trimmed && trimmed !== "grok") return trimmed;
  const candidates = [home ? `${home}/.grok/bin/grok` : null, "grok"]
    .filter(Boolean) as string[];
  return candidates.find((candidate) => candidate === "grok" || fileExists(candidate)) ?? "grok";
}

export function loadConfig(): Config {
  const parsed = parseEnvironment(process.env);

  const stateDir = resolve(parsed.STATE_DIR);
  const agentCwdCandidate = resolve(parsed.AGENT_CWD);
  if (!existsSync(agentCwdCandidate) || !statSync(agentCwdCandidate).isDirectory()) {
    throw new Error(`AGENT_CWD must be an existing directory: ${agentCwdCandidate}`);
  }
  const agentCwdAbs = realpathSync(agentCwdCandidate);
  assertRuntimePathsOutsideBuildOutput(
    stateDir,
    agentCwdAbs,
    getBuildOutputDir(import.meta.url),
  );
  const agentBin = resolveAgentBinary(parsed.AGENT_PROVIDER, parsed.AGENT_BIN, process.env["HOME"]);
  const agentDisplayName = parsed.AGENT_DISPLAY_NAME.trim()
    || DEFAULT_DISPLAY_NAMES[parsed.AGENT_PROVIDER];

  const cwdAllowlist = [...new Set(
    parseCwdAllowlist(parsed.AGENT_CWD_ALLOWLIST, agentCwdAbs).map((entry) => {
      const candidate = resolve(entry);
      if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isDirectory()) {
        throw new Error(`AGENT_CWD_ALLOWLIST entries must be existing non-symlink directories: ${candidate}`);
      }
      return realpathSync(candidate);
    }),
  )];

  return {
    ...parsed,
    stateDir,
    agentProvider: parsed.AGENT_PROVIDER,
    agentCwdAbs,
    agentBin,
    agentModel: parsed.AGENT_MODEL,
    agentAlwaysApprove: parsed.AGENT_ALWAYS_APPROVE,
    agentDisplayName,
    mimeAllowlist: parseMimeAllowlist(parsed.MEDIA_MIME_ALLOWLIST),
    cwdAllowlist,
  };
}

export const CHUNK_MAX = 4096;
