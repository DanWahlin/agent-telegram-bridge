import type { Config } from "./config.js";

export interface AgentLaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

// Parent-process variables that are safe to forward to the agent subprocess.
// TELEGRAM_BOT_TOKEN and unrelated parent secrets must never appear here.
const FORWARDED_ENV_KEYS = [
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

export function buildAgentChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  provider: Config["agentProvider"] = "grok",
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  if (provider === "grok") {
    // The bridge owns Telegram transport. Grok must not import Claude-compatible
    // MCPs/hooks, especially the root Claude Telegram plugin, or it can launch a
    // competing Bot API poller and wedge both bridges.
    childEnv["GROK_CLAUDE_MCPS_ENABLED"] = "false";
    childEnv["GROK_CLAUDE_HOOKS_ENABLED"] = "false";
  }
  for (const key of FORWARDED_ENV_KEYS) {
    const value = parentEnv[key];
    if (value) childEnv[key] = value;
  }
  return childEnv;
}

/**
 * Build the provider-specific ACP stdio launch specification. Both providers are
 * launched with `spawn(command, args, { shell: false })`. Copilot never receives
 * a `--model` argument.
 */
export function buildAgentLaunch(
  config: Config,
  cwd: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
): AgentLaunchSpec {
  const env = buildAgentChildEnv(parentEnv, config.agentProvider);
  if (config.agentProvider === "copilot") {
    const args = [
      "--acp",
      "--add-dir", cwd,
      "--no-auto-update",
      "--no-remote",
      "--no-remote-export",
    ];
    if (config.agentAlwaysApprove) args.push("--allow-all");
    return { command: config.agentBin, args, env };
  }
  const args = ["agent", "--model", config.agentModel];
  if (config.agentAlwaysApprove) args.push("--always-approve");
  args.push("stdio");
  return { command: config.agentBin, args, env };
}
