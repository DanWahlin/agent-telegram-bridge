import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = resolve(repoRoot, "native");
const nodeGyp = realpathSync(resolve(repoRoot, "node_modules/node-gyp/bin/node-gyp.js"));
const outputDir = resolve(repoRoot, "dist/native");
const builtAddon = resolve(nativeRoot, "build/Release/platform_security.node");
const packagedAddon = resolve(outputDir, "platform_security.node");

if (platform() === "darwin" && !existsSync("/usr/bin/clang")) {
  throw new Error("macOS Command Line Tools are required: run xcode-select --install");
}

execFileSync(process.execPath, [nodeGyp, "rebuild", "--directory", nativeRoot], {
  cwd: repoRoot,
  stdio: "inherit",
});
mkdirSync(outputDir, { recursive: true, mode: 0o755 });
copyFileSync(builtAddon, packagedAddon);
chmodSync(packagedAddon, 0o555);
rmSync(resolve(nativeRoot, "build"), { recursive: true, force: true });
console.log(`Built native platform security addon: ${packagedAddon}`);
