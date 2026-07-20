import {
  chmodSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOwnerOnlyEnvironment } from "./launch-env.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-launch-env-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("launchd environment loading", () => {
  it("parses an owner-only regular dotenv file", () => {
    const path = join(tempRoot(), "copilot.env");
    writeFileSync(path, "AGENT_PROVIDER=copilot\nSTATE_DIR=/tmp/state with spaces\n", { mode: 0o600 });
    expect(readOwnerOnlyEnvironment(path, null)).toEqual({
      AGENT_PROVIDER: "copilot",
      STATE_DIR: "/tmp/state with spaces",
    });
  });

  it("rejects group-readable configuration", () => {
    const path = join(tempRoot(), "copilot.env");
    writeFileSync(path, "TOKEN=fake\n", { mode: 0o600 });
    chmodSync(path, 0o640);
    expect(() => readOwnerOnlyEnvironment(path, null)).toThrow(/group or other/);
  });

  it("rejects symlinked configuration", () => {
    const root = tempRoot();
    const target = join(root, "target.env");
    const link = join(root, "copilot.env");
    writeFileSync(target, "TOKEN=fake\n", { mode: 0o600 });
    symlinkSync(target, link);
    expect(() => readOwnerOnlyEnvironment(link, null)).toThrow(/symlink/);
  });

  it("rejects hard-linked configuration", () => {
    const root = tempRoot();
    const target = join(root, "target.env");
    const link = join(root, "copilot.env");
    writeFileSync(target, "TOKEN=fake\n", { mode: 0o600 });
    linkSync(target, link);
    expect(() => readOwnerOnlyEnvironment(link, null)).toThrow(/singly linked/);
  });
});
