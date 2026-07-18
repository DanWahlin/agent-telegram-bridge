import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
  lstatSync,
  chmodSync,
  statSync,
  openSync,
  closeSync,
  fstatSync,
  constants as fsConstants,
  readdirSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, resolve, relative } from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { sanitizedError } from "./redact.js";
import { messageSafeRandom } from "./utils.js";

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface InboxFile {
  path: string;
  mime: string;
  originalName: string;
  size: number;
}

export interface MediaArtifact {
  path: string;
  mime: string;
  kind: "photo" | "document";
}

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".zip": "application/zip",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".js": "text/plain",
  ".py": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
};

const PHOTO_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

const DEFAULT_MIME_ALLOW = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/zip",
];

export function defaultMimeAllowlist(): string[] {
  return [...DEFAULT_MIME_ALLOW];
}

export function parseMimeAllowlist(value: string | undefined): string[] {
  if (!value || !value.trim()) return defaultMimeAllowlist();
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function parseCwdAllowlist(value: string | undefined, primaryCwd: string): string[] {
  const paths = new Set<string>();
  paths.add(resolve(primaryCwd));
  if (value) {
    for (const item of value.split(",")) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      paths.add(resolve(trimmed));
    }
  }
  return [...paths];
}

export function guessMime(fileName: string, telegramMime?: string | null): string {
  if (telegramMime && telegramMime !== "application/octet-stream") {
    return telegramMime.toLowerCase();
  }
  const ext = extname(fileName).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export function isAudioMime(mime: string): boolean {
  return mime.startsWith("audio/");
}

export function isAllowedMime(mime: string, allowlist: string[]): boolean {
  const normalized = mime.toLowerCase();
  if (allowlist.includes(normalized)) return true;
  // Allow type/* wildcards in allowlist
  const [type] = normalized.split("/");
  return allowlist.includes(`${type}/*`);
}

export function inboxDir(cwd: string): string {
  return join(resolve(cwd), ".tg-inbox");
}

export function ensureInboxDir(cwd: string): string {
  const dir = inboxDir(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) {
    throw new Error("Inbox directory may not be a symlink");
  }
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, ".gitignore"), "*\n", { mode: 0o600 });
  return dir;
}

export function cleanupStaleInbox(cwd: string): void {
  const dir = ensureInboxDir(cwd);
  for (const entry of readdirSync(dir)) {
    if (entry === ".gitignore") continue;
    const path = join(dir, entry);
    try {
      const stat = lstatSync(path);
      if (stat.isFile() || stat.isSymbolicLink()) rmSync(path, { force: true });
    } catch {
      // Best-effort crash recovery; active prompts track their own files.
    }
  }
}

export function safeInboxFileName(originalName: string): string {
  const base = basename(originalName || "file").replace(/[^\w.\-()+ ]+/g, "_").slice(0, 80);
  const safe = base || "file";
  return `${messageSafeRandom().slice(0, 10)}_${safe}`;
}

/**
 * Resolve a candidate path that must stay under cwd (after realpath).
 * Returns absolute real path or null if outside/unsafe.
 */
export function resolveSafePath(candidate: string, cwd: string): string | null {
  try {
    const root = realpathSync(resolve(cwd));
    const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
    if (!existsSync(abs)) return null;
    if (lstatSync(abs).isSymbolicLink()) {
      // Allow reading through symlink only if the target stays under root
    }
    const real = realpathSync(abs);
    const rel = relative(root, real);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    if (!lstatSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

const SENSITIVE_ARTIFACT_NAMES = new Set([
  "credentials",
  "credentials.json",
  "access.json",
  "lock.json",
  "health.json",
]);
const SENSITIVE_ARTIFACT_EXTENSIONS = new Set([
  ".key",
  ".pem",
  ".p12",
  ".pfx",
  ".kdbx",
]);

/**
 * Revalidate an outbound artifact at send time and reject hidden or credential-like paths.
 */
export function resolveSafeArtifactPath(candidate: string, cwd: string): string | null {
  const safe = resolveSafePath(candidate, cwd);
  if (!safe) return null;
  const root = realpathSync(resolve(cwd));
  const rel = relative(root, safe);
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part.startsWith("."))) return null;
  const name = basename(safe).toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) return null;
  if (SENSITIVE_ARTIFACT_NAMES.has(name)) return null;
  if (SENSITIVE_ARTIFACT_EXTENSIONS.has(extname(name))) return null;
  return safe;
}

export function artifactFitsLimit(path: string, maxBytes: number): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size <= maxBytes;
  } catch {
    return false;
  }
}

export function readSafeArtifactFile(
  candidate: string,
  cwd: string,
  maxBytes: number,
): { bytes: Buffer; name: string; path: string } {
  const safe = resolveSafeArtifactPath(candidate, cwd);
  if (!safe) throw new Error("Artifact path is outside the active CWD or is sensitive");
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(safe, flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Artifact is not a regular file");
    if (stat.size > maxBytes) {
      throw new Error(`Artifact too large (${stat.size} bytes; max ${maxBytes})`);
    }
    const root = realpathSync(resolve(cwd));
    let openedPath = safe;
    try {
      openedPath = realpathSync(`/proc/self/fd/${fd}`);
    } catch {
      openedPath = realpathSync(safe);
    }
    if (openedPath !== root && !openedPath.startsWith(root + "/")) {
      throw new Error("Artifact changed outside the active CWD before upload");
    }
    return { bytes: readFileSync(fd), name: basename(safe), path: openedPath };
  } finally {
    closeSync(fd);
  }
}

const PATH_IN_TEXT =
  /(?:^|[\s`"'(=])((?:\/[^\s`"')\]]+)|(?:\.\.?\/[^\s`"')\]]+)|(?:[A-Za-z0-9_.\-]+\/[^\s`"')\]]+\.[A-Za-z0-9]+))/g;

export function extractMediaPaths(text: string, cwd: string): string[] {
  const found = new Set<string>();
  if (!text) return [];
  for (const match of text.matchAll(PATH_IN_TEXT)) {
    const raw = match[1];
    if (!raw) continue;
    // Strip trailing punctuation
    const cleaned = raw.replace(/[.,;:!?]+$/, "");
    const safe = resolveSafePath(cleaned, cwd);
    if (safe) found.add(safe);
  }
  return [...found];
}

export function extractPathsFromUnknown(value: unknown, cwd: string, depth = 0): string[] {
  if (depth > 6 || value == null) return [];
  if (typeof value === "string") return extractMediaPaths(value, cwd);
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractPathsFromUnknown(item, cwd, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const paths: string[] = [];
    for (const key of ["path", "file", "filePath", "filepath", "output", "url", "uri", "saved", "image", "result"]) {
      if (key in record) paths.push(...extractPathsFromUnknown(record[key], cwd, depth + 1));
    }
    return [...new Set(paths)];
  }
  return [];
}

export function classifyArtifact(path: string, mime?: string): MediaArtifact | null {
  const guessed = mime || guessMime(path);
  const ext = extname(path).toLowerCase();
  if (isImageMime(guessed) || PHOTO_EXTS.has(ext)) {
    return { path, mime: guessed, kind: "photo" };
  }
  // Documents and other files
  if (existsSync(path)) {
    return { path, mime: guessed, kind: "document" };
  }
  return null;
}

export function buildPromptBlocks(options: {
  text: string;
  files: InboxFile[];
  capabilities: PromptCapabilities;
}): { blocks: ContentBlock[]; notes: string[] } {
  const blocks: ContentBlock[] = [];
  const notes: string[] = [];
  const text = options.text.trim() || (options.files.length
    ? "User sent media. Please inspect the attached files."
    : "User sent an empty message.");
  blocks.push({ type: "text", text });

  for (const file of options.files) {
    const buf = readFileSync(file.path);
    const b64 = buf.toString("base64");
    if (isImageMime(file.mime) && options.capabilities.image) {
      blocks.push({
        type: "image",
        data: b64,
        mimeType: file.mime,
        uri: `file://${file.path}`,
      });
      notes.push(`Attached image: ${file.originalName} (${file.path})`);
    } else if (isAudioMime(file.mime) && options.capabilities.audio) {
      blocks.push({
        type: "audio",
        data: b64,
        mimeType: file.mime,
      });
      notes.push(`Attached audio: ${file.originalName} (${file.path})`);
    } else if (options.capabilities.embeddedContext) {
      if (file.mime.startsWith("text/") || file.mime === "application/json") {
        blocks.push({
          type: "resource",
          resource: {
            uri: `file://${file.path}`,
            mimeType: file.mime,
            text: buf.toString("utf8").slice(0, 200_000),
          },
        });
      } else {
        blocks.push({
          type: "resource",
          resource: {
            uri: `file://${file.path}`,
            mimeType: file.mime,
            blob: b64,
          },
        });
      }
      notes.push(`Embedded resource: ${file.originalName} (${file.path})`);
    } else {
      // Baseline: resource_link + path in text so agent can open via tools
      blocks.push({
        type: "resource_link",
        name: file.originalName,
        uri: `file://${file.path}`,
        mimeType: file.mime,
        size: file.size,
        description: `Telegram attachment saved at ${file.path}`,
      });
      notes.push(`Attachment saved for tools: ${file.path}`);
    }
  }

  if (notes.length && options.files.length) {
    // Reinforce paths for agents that ignore resource links
    blocks.push({
      type: "text",
      text: `Attachment paths on disk:\n${notes.map((n) => `- ${n}`).join("\n")}`,
    });
  }

  return { blocks, notes };
}

export function cleanupInboxFiles(paths: string[]): void {
  for (const path of paths) {
    try {
      rmSync(path, { force: true });
    } catch (error: unknown) {
      console.warn(`[MEDIA] Failed to remove inbox file: ${sanitizedError(error)}`);
    }
  }
}

export function writeInboxFile(
  cwd: string,
  originalName: string,
  data: Buffer,
): InboxFile {
  const dir = ensureInboxDir(cwd);
  const name = safeInboxFileName(originalName);
  const path = join(dir, name);
  writeFileSync(path, data, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  const mime = guessMime(originalName);
  return {
    path,
    mime,
    originalName: basename(originalName || name),
    size: data.length,
  };
}

export function formatPlanText(
  entries: Array<{ content: string; status: string; priority?: string }>,
): string {
  if (!entries.length) return "📋 Plan (empty)";
  const lines = entries.map((entry, index) => {
    const icon = entry.status === "completed"
      ? "✅"
      : entry.status === "in_progress"
        ? "▶️"
        : "⬜";
    return `${icon} ${index + 1}. ${entry.content}`;
  });
  return `📋 Plan (${entries.length} steps)\n${lines.join("\n")}`;
}

export function formatPlanUpdateText(plan: {
  type?: string;
  entries?: Array<{ content: string; status: string }>;
  content?: string;
  planId?: string;
}): string {
  if (plan.type === "items" && plan.entries) {
    return formatPlanText(plan.entries);
  }
  if (plan.type === "markdown" && plan.content) {
    return `📋 Plan\n${plan.content.slice(0, 3500)}`;
  }
  if (plan.type === "file" && plan.content) {
    return `📋 Plan file updated\n${plan.content.slice(0, 3500)}`;
  }
  if (plan.entries) return formatPlanText(plan.entries);
  if (plan.content) return `📋 Plan\n${plan.content.slice(0, 3500)}`;
  return "📋 Plan updated";
}

export async function downloadTelegramFileBytes(
  token: string,
  filePath: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`Telegram file download failed: ${res.status}`);
  }
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new Error(`File too large (${contentLength} bytes; max ${maxBytes})`);
  }
  if (!res.body) throw new Error("Telegram file download returned no body");
  const chunks: Buffer[] = [];
  const reader = res.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`File too large (${total} bytes received; max ${maxBytes})`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
