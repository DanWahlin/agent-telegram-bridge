import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentLaunch, buildAgentChildEnv } from "./agent-launch.js";
import { parseEnvironment, resolveAgentBinary } from "./config.js";
import { createTestConfig } from "./test-support.js";

describe("agent launch specification", () => {
  it("builds the Grok stdio launch with model, always-approve, and hardened env", () => {
    const config = createTestConfig("/tmp", {
      agentProvider: "grok",
      agentBin: "grok",
      agentModel: "grok-4.5",
      agentAlwaysApprove: true,
    });
    const launch = buildAgentLaunch(config, "/work", {
      HOME: "/root",
      PATH: "/usr/bin",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      XAI_API_KEY: "xai-secret",
    });
    expect(launch.command).toBe("grok");
    expect(launch.args).toEqual(["agent", "--model", "grok-4.5", "--always-approve", "stdio"]);
    expect(launch.env["GROK_CLAUDE_MCPS_ENABLED"]).toBe("false");
    expect(launch.env["GROK_CLAUDE_HOOKS_ENABLED"]).toBe("false");
    expect(launch.env["HOME"]).toBe("/root");
    expect(launch.env["TELEGRAM_BOT_TOKEN"]).toBeUndefined();
    expect(launch.env["XAI_API_KEY"]).toBeUndefined();
  });

  it("omits --always-approve for Grok when auto-approval is disabled", () => {
    const config = createTestConfig("/tmp", { agentProvider: "grok", agentBin: "grok" });
    const launch = buildAgentLaunch(config, "/work", { HOME: "/root", PATH: "/usr/bin" });
    expect(launch.args).toEqual(["agent", "--model", "grok-4.5", "stdio"]);
  });

  it("builds the Copilot ACP launch without a model pin and without Grok env flags", () => {
    const config = createTestConfig("/tmp", {
      agentProvider: "copilot",
      agentBin: "/usr/bin/copilot",
      agentModel: "grok-4.5",
      agentAlwaysApprove: false,
    });
    const launch = buildAgentLaunch(config, "/work/dir", {
      HOME: "/root",
      PATH: "/usr/bin",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
    });
    expect(launch.command).toBe("/usr/bin/copilot");
    expect(launch.args).toEqual([
      "--acp",
      "--add-dir", "/work/dir",
      "--no-auto-update",
      "--no-remote",
      "--no-remote-export",
    ]);
    expect(launch.args).not.toContain("--model");
    expect(launch.args).not.toContain("--allow-all");
    expect(launch.env["GROK_CLAUDE_MCPS_ENABLED"]).toBeUndefined();
    expect(launch.env["GROK_CLAUDE_HOOKS_ENABLED"]).toBeUndefined();
    expect(launch.env["HOME"]).toBe("/root");
    expect(launch.env["TELEGRAM_BOT_TOKEN"]).toBeUndefined();
  });

  it("adds --allow-all for Copilot only when auto-approval is enabled, never a model", () => {
    const config = createTestConfig("/tmp", {
      agentProvider: "copilot",
      agentBin: "/usr/bin/copilot",
      agentAlwaysApprove: true,
    });
    const launch = buildAgentLaunch(config, "/work/dir", { HOME: "/root", PATH: "/usr/bin" });
    expect(launch.args).toEqual([
      "--acp",
      "--add-dir", "/work/dir",
      "--no-auto-update",
      "--no-remote",
      "--no-remote-export",
      "--allow-all",
    ]);
    expect(launch.args).not.toContain("--model");
  });

  it("keeps Copilot child env free of Grok-specific flags", () => {
    const env = buildAgentChildEnv({ HOME: "/root", PATH: "/usr/bin", GROK_CLAUDE_MCPS_ENABLED: "true" }, "copilot");
    expect(env["GROK_CLAUDE_MCPS_ENABLED"]).toBeUndefined();
    expect(env["GROK_CLAUDE_HOOKS_ENABLED"]).toBeUndefined();
    expect(env["HOME"]).toBe("/root");
  });
});

describe("provider-neutral configuration", () => {
  it("resolves the default Copilot binary and honors an override", () => {
    expect(resolveAgentBinary("copilot", "", "/home/example")).toBe("/usr/bin/copilot");
    expect(resolveAgentBinary("copilot", "/opt/copilot", "/home/example")).toBe("/opt/copilot");
  });

  it("parses first-class AGENT_* variables including the Copilot provider", () => {
    const parsed = parseEnvironment({
      TELEGRAM_BOT_TOKEN: "123456789:test-token-not-real",
      AGENT_PROVIDER: "copilot",
      AGENT_CWD: "/work",
      AGENT_BIN: "/usr/bin/copilot",
      AGENT_ALWAYS_APPROVE: "true",
    });
    expect(parsed.AGENT_PROVIDER).toBe("copilot");
    expect(parsed.AGENT_CWD).toBe("/work");
    expect(parsed.AGENT_BIN).toBe("/usr/bin/copilot");
    expect(parsed.AGENT_ALWAYS_APPROVE).toBe(true);
  });

  it("accepts legacy GROK_* aliases for Grok migration", () => {
    const parsed = parseEnvironment({
      TELEGRAM_BOT_TOKEN: "123456789:test-token-not-real",
      GROK_CWD: "/legacy",
      GROK_BIN: "/legacy/grok",
      GROK_MODEL: "grok-legacy",
      GROK_ALWAYS_APPROVE: "true",
      GROK_CWD_ALLOWLIST: "/legacy,/other",
    });
    expect(parsed.AGENT_PROVIDER).toBe("grok");
    expect(parsed.AGENT_CWD).toBe("/legacy");
    expect(parsed.AGENT_BIN).toBe("/legacy/grok");
    expect(parsed.AGENT_MODEL).toBe("grok-legacy");
    expect(parsed.AGENT_ALWAYS_APPROVE).toBe(true);
    expect(parsed.AGENT_CWD_ALLOWLIST).toBe("/legacy,/other");
  });

  it("lets first-class AGENT_* variables win over legacy aliases", () => {
    const parsed = parseEnvironment({
      TELEGRAM_BOT_TOKEN: "123456789:test-token-not-real",
      AGENT_CWD: "/new",
      GROK_CWD: "/legacy",
    });
    expect(parsed.AGENT_CWD).toBe("/new");
  });

  it("derives a provider display name default that can be overridden", async () => {
    const parent = mkdtempSync(join(tmpdir(), "agent-cfg-"));
    try {
      const { loadConfig } = await import("./config.js");
      const previous = { ...process.env };
      try {
        process.env["TELEGRAM_BOT_TOKEN"] = "123456789:test-token-not-real";
        process.env["AGENT_PROVIDER"] = "copilot";
        process.env["AGENT_CWD"] = parent;
        process.env["STATE_DIR"] = join(parent, "state");
        delete process.env["AGENT_DISPLAY_NAME"];
        delete process.env["GROK_CWD"];
        delete process.env["GROK_CWD_ALLOWLIST"];
        delete process.env["AGENT_CWD_ALLOWLIST"];
        const config = loadConfig();
        expect(config.agentProvider).toBe("copilot");
        expect(config.agentDisplayName).toBe("GitHub Copilot CLI");
        expect(config.agentBin).toBe("/usr/bin/copilot");
      } finally {
        process.env = previous;
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
