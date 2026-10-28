import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  PACK_MAX_ARCHIVE_BYTES,
  PACK_MAX_FILE_BYTES,
  PACK_MAX_TREE_BYTES,
} from "./config.js";
import type { CliDeps } from "./deps.js";
import { sourceError } from "./exit.js";
import { gitToplevel } from "./git.js";
import { createUstar, gzipDeterministic, type UstarFile } from "./ustar.js";

const WALK_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".vercel",
  ".output",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "out",
]);

const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".wasm",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".bin",
  ".class",
  ".jar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".wav",
  ".webm",
]);

export type PackExclusion = {
  path: string;
  reason: string;
};

export type PackFile = {
  relativePath: string;
  bytes: number;
};

export type PackPlan = {
  root: string;
  files: PackFile[];
  excluded: PackExclusion[];
  fileCount: number;
  bytes: number;
  dirty: boolean;
  remote?: string;
  commitSha?: string;
  directoryName: string;
  pathHash: string;
};

function posixPath(relativePath: string): string {
  return relativePath.split(sep).join("/");
}

function comparePosix(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isSecretDeniedPath(relativePath: string): string | null {
  const posix = posixPath(relativePath);
  const base = posix.split("/").pop() ?? posix;
  if (posix === ".git" || posix.startsWith(".git/")) return "git metadata";
  if (posix.split("/").includes(".ssh") || posix.startsWith(".ssh/")) {
    return "secret path";
  }
  if (posix.split("/").includes(".aws") || posix.startsWith(".aws/")) {
    return "secret path";
  }
  if (posix === ".docker/config.json" || posix.endsWith("/.docker/config.json")) {
    return "secret config";
  }
  if (/^\.env(?!\.example$)/i.test(base)) return "secret env file";
  if (base === ".dev.vars" || base === ".netrc") return "secret config";
  if (base === ".npmrc" || base === ".pypirc") return "secret config";
  if (/\.pem$/i.test(base) || /\.key$/i.test(base) || /\.p12$/i.test(base)) {
    return "secret key";
  }
  if (/\.jks$/i.test(base) || /\.keystore$/i.test(base)) return "secret key";
  if (/^id_(rsa|ed25519|ecdsa|dsa)(-[a-z0-9]+)?$/i.test(base)) {
    return "secret key";
  }
  if (/\.tfstate/i.test(base)) return "secret terraform";
  if (/service-account.*\.json$/i.test(base)) return "secret credentials";
  if (/firebase-adminsdk.*\.json$/i.test(base)) return "secret credentials";
  if (/^credentials.*\.json$/i.test(base)) return "secret credentials";
  return null;
}

function isBinaryPath(relativePath: string): boolean {
  const base = relativePath.split(sep).pop() ?? relativePath;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return BINARY_EXT.has(base.slice(dot).toLowerCase());
}

async function listGitFiles(deps: CliDeps, root: string): Promise<string[] | null> {
  const listed = await deps.git(["ls-files", "-co", "--exclude-standard"], root);
  if (!listed.ok) return null;
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (entry.isFile()) out.push(rel);
    }
  }
  await walk(root);
  return out;
}

function isSkippedDirPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((part) => WALK_SKIP_DIRS.has(part));
}

async function classifyFile(
  root: string,
  relativePath: string
): Promise<PackFile | PackExclusion> {
  if (isSkippedDirPath(relativePath)) {
    return { path: relativePath, reason: "ignored directory" };
  }
  const secret = isSecretDeniedPath(relativePath);
  if (secret) return { path: relativePath, reason: secret };
  if (isBinaryPath(relativePath)) {
    return { path: relativePath, reason: "binary" };
  }
  const abs = join(root, relativePath);
  let info;
  try {
    info = await lstat(abs);
  } catch {
    return { path: relativePath, reason: "missing" };
  }
  if (info.isSymbolicLink()) return { path: relativePath, reason: "symlink" };
  if (!info.isFile()) return { path: relativePath, reason: "not a file" };
  if (info.size > PACK_MAX_FILE_BYTES) {
    return { path: relativePath, reason: "over 2 MB" };
  }
  return { relativePath, bytes: info.size };
}

export async function planPack(deps: CliDeps, cwd = deps.env.cwd()): Promise<PackPlan> {
  const top = await gitToplevel(deps, cwd);
  const root = resolve(top ?? cwd);
  const gitFiles = top ? await listGitFiles(deps, root) : null;
  const listed = gitFiles ?? (await walkFiles(root));
  const files: PackFile[] = [];
  const excluded: PackExclusion[] = [];
  for (const rel of listed) {
    const classified = await classifyFile(root, rel);
    if ("reason" in classified) excluded.push(classified);
    else files.push(classified);
  }
  files.sort((a, b) => comparePosix(posixPath(a.relativePath), posixPath(b.relativePath)));
  excluded.sort((a, b) => comparePosix(a.path, b.path));
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (files.length === 0) {
    throw sourceError("Nothing to upload after applying ignore and secret filters.");
  }
  // Before writePackArchive reads every file into memory.
  assertPackTreeFitsUpload(bytes);

  let dirty = !top;
  let remote: string | undefined;
  let commitSha: string | undefined;
  if (top) {
    const status = await deps.git(["status", "--porcelain"], root);
    dirty = status.ok && status.stdout.trim().length > 0;
    const origin = await deps.git(["remote", "get-url", "origin"], root);
    if (origin.ok && origin.stdout.trim()) remote = origin.stdout.trim();
    const head = await deps.git(["rev-parse", "HEAD"], root);
    if (head.ok && head.stdout.trim()) commitSha = head.stdout.trim();
  }

  const directoryName = basename(root) || "upload";
  const pathHash = createHash("sha256").update(root).digest("hex").slice(0, 32);
  return {
    root,
    files,
    excluded,
    fileCount: files.length,
    bytes,
    dirty,
    remote,
    commitSha,
    directoryName,
    pathHash,
  };
}

export function formatPackSummary(plan: PackPlan, dryRun: boolean): string {
  const lines = [
    dryRun ? "Would upload:" : "Uploading:",
    `  ${plan.fileCount} files, ${plan.bytes} bytes`,
    `  directory ${plan.directoryName}`,
  ];
  if (plan.remote) lines.push(`  remote ${plan.remote}`);
  const topExcluded = plan.excluded.slice(0, 8);
  if (topExcluded.length > 0) {
    lines.push("  excluded:");
    for (const item of topExcluded) {
      lines.push(`    ${item.path} (${item.reason})`);
    }
    if (plan.excluded.length > topExcluded.length) {
      lines.push(`    … ${plan.excluded.length - topExcluded.length} more`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function assertPackTreeFitsUpload(bytes: number): void {
  if (bytes > PACK_MAX_TREE_BYTES) {
    throw sourceError(
      `Files to upload come to ${bytes} bytes uncompressed; the upload limit is 1 GB.`
    );
  }
}

export function assertPackedArchiveFitsUpload(bytes: number): void {
  if (bytes > PACK_MAX_ARCHIVE_BYTES) {
    throw sourceError(
      `Packed archive is ${bytes} bytes; the upload limit is 100 MB.`
    );
  }
}

export type PackArchive = {
  bytes: Buffer;
  /** SHA-256 of the gzip body as sent. */
  sha256: string;
  /** SHA-256 of the uncompressed tar: the same files hash the same whatever gzip does. */
  treeSha256: string;
};

export async function writePackArchive(plan: PackPlan): Promise<PackArchive> {
  const entries: UstarFile[] = [];
  for (const file of plan.files) {
    const posix = posixPath(file.relativePath);
    const abs = join(plan.root, file.relativePath);
    const info = await lstat(abs);
    if (info.isSymbolicLink()) {
      throw sourceError(`Refusing to pack symlink ${posix}.`);
    }
    if (!info.isFile()) {
      throw sourceError(`Refusing to pack non-file ${posix}.`);
    }
    entries.push({ name: posix, content: await readFile(abs) });
  }
  const tar = createUstar(entries);
  // The server caps the tar stream itself, headers and padding included.
  assertPackTreeFitsUpload(tar.byteLength);
  const gz = gzipDeterministic(tar);
  assertPackedArchiveFitsUpload(gz.byteLength);
  return {
    bytes: gz,
    sha256: createHash("sha256").update(gz).digest("hex"),
    treeSha256: createHash("sha256").update(tar).digest("hex"),
  };
}

/** Matches the server's caps on the manifest's `excluded` list. */
const EXCLUDED_MAX_FILES = 20;
const EXCLUDED_MAX_PATH = 200;

function excludedRank(reason: string): number {
  if (reason.startsWith("secret")) return 0;
  return reason === "ignored directory" ? 2 : 1;
}

/**
 * What the scan never saw, for the report. Secrets list first. Deleted
 * tracked files (`missing`) are gone, not skipped, so they are left out.
 */
export function excludedSummary(excluded: readonly PackExclusion[]): {
  total: number;
  byReason: Record<string, number>;
  files: Array<{ path: string; reason: string }>;
} {
  const skipped = excluded.filter((item) => item.reason !== "missing");
  const byReason: Record<string, number> = {};
  for (const item of skipped) {
    byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;
  }
  const files = skipped
    .map((item) => ({ path: posixPath(item.path), reason: item.reason }))
    .filter((item) => item.path.length <= EXCLUDED_MAX_PATH)
    .sort(
      (a, b) =>
        excludedRank(a.reason) - excludedRank(b.reason) || comparePosix(a.path, b.path)
    )
    .slice(0, EXCLUDED_MAX_FILES);
  return { total: skipped.length, byReason, files };
}

export function packManifest(
  plan: PackPlan,
  archive: Pick<PackArchive, "sha256" | "treeSha256">
): Record<string, unknown> {
  return {
    remote: plan.remote,
    commitSha: plan.commitSha,
    dirty: plan.dirty,
    fileCount: plan.fileCount,
    bytes: plan.bytes,
    contentSha256: archive.sha256,
    treeSha256: archive.treeSha256,
    directoryName: plan.directoryName,
    pathHash: plan.pathHash,
    excluded: excludedSummary(plan.excluded),
  };
}
