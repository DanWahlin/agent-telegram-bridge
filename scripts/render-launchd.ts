import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderLaunchdTemplate } from "../src/launchd-template.js";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`render-launchd: missing ${name}`);
  return value;
}

const repo = resolve(option("--repo"));
const node = resolve(option("--node"));
const envFile = resolve(option("--env"));
const output = resolve(option("--output"));
const home = resolve(option("--home"));
const template = readFileSync(
  resolve(repo, "deploy/launchd/com.codewithdan.agent-telegram.copilot.plist.example"),
  "utf8",
);

const rendered = renderLaunchdTemplate(template, {
  nodeBin: node,
  repoDir: repo,
  envFile,
  home,
});
writeFileSync(output, rendered, { mode: 0o644 });
chmodSync(output, 0o644);
console.log(`Rendered LaunchAgent: ${output}`);
