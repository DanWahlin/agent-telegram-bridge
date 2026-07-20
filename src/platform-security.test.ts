import { describe, expect, it, vi } from "vitest";
import {
  getProcessStartToken,
  normalizeSupportedPlatform,
  parseLinuxProcessStartToken,
  validateDarwinProcessIdentity,
  verifyProcessCwdIdentity,
} from "./platform-security.js";

function linuxStat(startTime: string): string {
  const fields = Array.from({ length: 20 }, (_, index) => String(index + 3));
  fields[19] = startTime;
  return `123 (agent process) ${fields.join(" ")}`;
}

const darwinIdentity = {
  startSeconds: 1_784_506_000n,
  startMicroseconds: 123_456n,
  cwdDev: 7n,
  cwdIno: 11n,
};

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

  it("validates the complete native Darwin addon identity", () => {
    expect(validateDarwinProcessIdentity(darwinIdentity)).toEqual(darwinIdentity);
    expect(() => validateDarwinProcessIdentity({ ...darwinIdentity, cwdIno: 0n }))
      .toThrow(/incomplete identity/);
    expect(() => validateDarwinProcessIdentity({ ...darwinIdentity, cwdDev: "7" }))
      .toThrow(/invalid identity/);
  });

  it("uses the native Darwin identity for a microsecond-resolution start token", () => {
    const inspectDarwin = vi.fn(() => darwinIdentity);
    expect(getProcessStartToken(42, { hostPlatform: "darwin", inspectDarwin }))
      .toBe("darwin:1784506000:123456");
    expect(inspectDarwin).toHaveBeenCalledWith(42);
  });

  it("verifies a Darwin child CWD directly by vnode device and inode", () => {
    const inspectDarwin = vi.fn(() => darwinIdentity);
    expect(() => verifyProcessCwdIdentity(42, {
      path: "/Users/dan/project",
      dev: 7n,
      ino: 11n,
    }, { hostPlatform: "darwin", inspectDarwin })).not.toThrow();
    expect(inspectDarwin).toHaveBeenCalledWith(42);
  });

  it("rejects a Darwin child with a different CWD identity", () => {
    expect(() => verifyProcessCwdIdentity(42, {
      path: "/Users/dan/project",
      dev: 7n,
      ino: 11n,
    }, {
      hostPlatform: "darwin",
      inspectDarwin: () => ({ ...darwinIdentity, cwdIno: 12n }),
    })).toThrow(/outside the authorized CWD identity/);
  });

  it("fails closed when native Darwin inspection fails", () => {
    expect(getProcessStartToken(42, {
      hostPlatform: "darwin",
      inspectDarwin: () => { throw new Error("denied"); },
    })).toBeNull();
    expect(() => verifyProcessCwdIdentity(42, {
      path: "/Users/dan/project",
      dev: 7n,
      ino: 11n,
    }, {
      hostPlatform: "darwin",
      inspectDarwin: () => { throw new Error("denied"); },
    })).toThrow(/denied/);
  });
});
