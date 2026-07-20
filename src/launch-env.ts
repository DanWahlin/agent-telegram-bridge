import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import dotenv from "dotenv";

export function readOwnerOnlyEnvironment(
  envFile: string,
  expectedUid: number | null = typeof process.getuid === "function" ? process.getuid() : null,
): Record<string, string> {
  const before = lstatSync(envFile, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    throw new Error("Environment file must be a singly linked regular file, not a symlink");
  }
  if ((before.mode & 0o077n) !== 0n) {
    throw new Error("Environment file must not grant group or other permissions");
  }
  if (expectedUid !== null && before.uid !== BigInt(expectedUid)) {
    throw new Error("Environment file must be owned by the LaunchAgent user");
  }

  const fd = openSync(envFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n
      || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.uid !== before.uid || opened.mode !== before.mode) {
      throw new Error("Environment file identity changed while opening");
    }
    return dotenv.parse(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}
