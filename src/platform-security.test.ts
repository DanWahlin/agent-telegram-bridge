import { describe, expect, it, vi } from "vitest";
import {
  getProcessStartToken,
  normalizeSupportedPlatform,
  parseLinuxProcessStartToken,
  parseMacCwdLsof,
  parseMacProcessStartToken,
  verifyProcessCwdIdentity,
} from "./platform-security.js";

function linuxStat(startTime: string): string {
  const fields = Array.from({ length: 20 }, (_, index) => String(index + 3));
  fields[19] = startTime;
  return `123 (agent process) ${fields.join(" ")}`;
}

function directory(dev: bigint, ino: bigint) {
  return { dev, ino, isDirectory: () => true };
}

describe("platform security adapters", () => {
  it("accepts Linux and macOS while directing native Windows to WSL2", () => {
    expect(normalizeSupportedPlatform("linux")).toBe("linux");
    expect(normalizeSupportedPlatform("darwin")).toBe("darwin");
    expect(() => normalizeSupportedPlatform("win32")).toThrow(/WSL2/);
  });

  it("parses Linux process start identity after a parenthesized process name", () => {
    expect(parseLinuxProcessStartToken(linuxStat("987654"))).toBe("linux:987654");
    expect(parseLinuxProcessStartToken("not-a-proc-stat")).toBeNull();
  });

  it("normalizes a macOS process start identity", () => {
    expect(parseMacProcessStartToken(" Sun Jul 19 23:00:01 2026\n"))
      .toBe("darwin:Sun Jul 19 23:00:01 2026");
    expect(parseMacProcessStartToken("  \n")).toBeNull();
  });

  it("parses the single cwd record from macOS lsof field output", () => {
    expect(parseMacCwdLsof("p42\nfcwd\nn/Users/dan/My Project\n"))
      .toBe("/Users/dan/My Project");
    expect(() => parseMacCwdLsof("p42\nfcwd\n")).toThrow(/determine/);
    expect(() => parseMacCwdLsof("n/one\nn/two\n")).toThrow(/determine/);
    expect(parseMacCwdLsof("p42\0fcwd\0n/Users/dan/line\nbreak\0\n"))
      .toBe("/Users/dan/line\nbreak");
  });

  it("queries the fixed macOS ps command for a PID start token", () => {
    const execText = vi.fn(() => "Sun Jul 19 23:00:01 2026\n");
    expect(getProcessStartToken(42, { hostPlatform: "darwin", execText }))
      .toBe("darwin:Sun Jul 19 23:00:01 2026");
    expect(execText).toHaveBeenCalledWith("/bin/ps", ["-p", "42", "-o", "lstart="]);
  });

  it("verifies a macOS child cwd by canonical device and inode identity", () => {
    const execText = vi.fn(() => "p42\nfcwd\nn/Users/dan/project\n");
    const realpath = vi.fn(() => "/Users/dan/project");
    const statDirectory = vi.fn(() => directory(7n, 11n));

    expect(() => verifyProcessCwdIdentity(42, {
      path: "/Users/dan/project",
      dev: 7n,
      ino: 11n,
    }, {
      hostPlatform: "darwin",
      execText,
      realpath,
      statDirectory,
    })).not.toThrow();

    expect(execText).toHaveBeenCalledWith(
      "/usr/sbin/lsof",
      ["-a", "-p", "42", "-d", "cwd", "-F0n"],
    );
    expect(statDirectory).toHaveBeenCalledWith("/Users/dan/project");
  });

  it("rejects a macOS child running outside the authorized directory identity", () => {
    expect(() => verifyProcessCwdIdentity(42, {
      path: "/Users/dan/allowed",
      dev: 7n,
      ino: 11n,
    }, {
      hostPlatform: "darwin",
      execText: () => "p42\nfcwd\nn/Users/dan/other\n",
      realpath: (path) => path,
      statDirectory: () => directory(7n, 12n),
    })).toThrow(/outside the authorized CWD identity/);
  });
});
