import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { buildAgentLaunch } from "../src/agent-launch.js";
import { parseEnvironment, resolveAgentBinary, DEFAULT_DISPLAY_NAMES, type Config } from "../src/config.js";

const parsed = parseEnvironment(process.env);
const sessionCwd = resolve(parsed.AGENT_CWD);
const agentBin = resolveAgentBinary(parsed.AGENT_PROVIDER, parsed.AGENT_BIN, process.env["HOME"]);

// Minimal Config projection sufficient for the launch builder.
const smokeConfig = {
  agentProvider: parsed.AGENT_PROVIDER,
  agentBin,
  agentModel: parsed.AGENT_MODEL,
  agentAlwaysApprove: parsed.AGENT_ALWAYS_APPROVE,
  agentDisplayName: parsed.AGENT_DISPLAY_NAME.trim() || DEFAULT_DISPLAY_NAMES[parsed.AGENT_PROVIDER],
} as Config;

const launch = buildAgentLaunch(smokeConfig, sessionCwd);
const child = spawn(launch.command, launch.args, {
  cwd: sessionCwd,
  stdio: ["pipe", "pipe", "inherit"],
  env: launch.env,
  shell: false,
});
const timeout = setTimeout(() => {
  child.kill("SIGTERM");
  console.error("Live ACP smoke timed out");
  process.exitCode = 1;
}, 90_000);
timeout.unref();

const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin!),
  Readable.toWeb(child.stdout!),
);
const app = acp
  .client({ name: "agent-telegram-bridge-smoke" })
  .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
    const option = params.options.find((item) => item.kind === "allow_once")
      ?? params.options.find((item) => item.kind === "allow_always");
    return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
  });

let text = "";
try {
  await app.connectWith(stream, async (context) => {
    const init = await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "agent-telegram-bridge-smoke", version: "0.1.0" },
    });
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error("ACP protocol mismatch");
    const session = await context.buildSession(sessionCwd).start();
    const completion = session.prompt("Reply with exactly ACP_PONG. Do not use tools.");
    for (;;) {
      const message = await session.nextUpdate();
      if (message.kind === "stop") break;
      if (message.update.sessionUpdate === "agent_message_chunk" && message.update.content.type === "text") {
        text += message.update.content.text;
      }
    }
    await completion;
    session.dispose();
  });
  if (text.trim() !== "ACP_PONG") throw new Error(`Unexpected response: ${JSON.stringify(text)}`);
  console.log("ACP_PONG");
} finally {
  clearTimeout(timeout);
  child.kill("SIGTERM");
}
