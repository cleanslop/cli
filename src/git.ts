import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { CliDeps } from "./deps.js";
import { doneQuestion, RERUN_SAME_COMMAND } from "./done-question.js";
import { sourceError, type ActionQuestion } from "./exit.js";
import type { GitSnapshot } from "./types.js";

const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export type GithubRemote = {
  owner: string;
  repo: string;
  fullName: string;
};

function stripGitSuffix(name: string): string {
  return name.replace(/\.git$/i, "");
}

function ownerRepoFromPath(pathname: string): GithubRemote | null {
  const parts = pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const repo = stripGitSuffix(parts[1]!);
  if (!owner || !repo) return null;
  const fullName = `${owner}/${repo}`;
  if (!OWNER_REPO_RE.test(fullName)) return null;
  return { owner, repo, fullName };
}

function hostIsGithub(hostname: string): boolean {
  return hostname.toLowerCase() === "github.com";
}

/** Accept https, git@, and ssh:// forms on github.com only. */
export function parseGithubRemote(raw: string): GithubRemote | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const scp = /^git@([^:]+):(.+)$/i.exec(trimmed);
  if (scp) {
    if (!hostIsGithub(scp[1]!)) return null;
    return ownerRepoFromPath(scp[2]!);
  }

  try {
    const withScheme = /^[a-zA-Z][a-zA-Z+.-]*:/.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const url = new URL(withScheme);
    const protocol = url.protocol.toLowerCase();
    if (protocol !== "https:" && protocol !== "http:" && protocol !== "ssh:") {
      return null;
    }
    if (!hostIsGithub(url.hostname)) return null;
    return ownerRepoFromPath(url.pathname);
  } catch {
    return null;
  }
}

/**
 * Realpath the nearest existing ancestor and re-append the missing tail.
 * Needed because credentials files usually do not exist yet, and git's
 * `--show-toplevel` is already realpath'd (macOS `/var` → `/private/var`).
 */
function resolveThroughExistingAncestor(targetPath: string): string {
  const absolute = resolve(targetPath);
  const missing: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = resolve(cursor, "..");
    if (parent === cursor) {
      throw new Error(`no existing ancestor for ${targetPath}`);
    }
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  const real = realpathSync(cursor);
  return missing.length === 0 ? real : resolve(real, ...missing);
}

export function isPathInsideWorktree(
  targetPath: string,
  worktreeRoot: string
): boolean {
  try {
    const root = resolveThroughExistingAncestor(worktreeRoot);
    const target = resolveThroughExistingAncestor(targetPath);
    const rel = relative(root, target);
    return (
      rel === "" ||
      (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    );
  } catch {
    // Cannot resolve — refuse the write (fail closed).
    return true;
  }
}

export async function gitToplevel(
  deps: CliDeps,
  cwd: string
): Promise<string | null> {
  const result = await deps.git(["rev-parse", "--show-toplevel"], cwd);
  if (!result.ok) return null;
  const top = result.stdout.trim();
  return top || null;
}

async function requireGit(
  deps: CliDeps,
  args: string[],
  cwd: string,
  message: string
): Promise<string> {
  const result = await deps.git(args, cwd);
  if (!result.ok) {
    throw sourceError(message);
  }
  return result.stdout.trim();
}

export async function inspectGit(deps: CliDeps): Promise<GitSnapshot> {
  const cwd = deps.env.cwd();
  const inside = await deps.git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    throw sourceError("Not a git work tree. Run this from a GitHub checkout.");
  }
  const toplevel = await requireGit(
    deps,
    ["rev-parse", "--show-toplevel"],
    cwd,
    "Not a git work tree. Run this from a GitHub checkout."
  );
  const remote = await requireGit(
    deps,
    ["remote", "get-url", "origin"],
    cwd,
    "No origin remote. CleanSlop needs a github.com origin."
  );
  const commitSha = await requireGit(
    deps,
    ["rev-parse", "HEAD"],
    cwd,
    "Could not read HEAD."
  );
  const branchResult = await deps.git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = branchResult.ok ? branchResult.stdout.trim() : "HEAD";
  const status = await deps.git(["status", "--porcelain"], cwd);
  const dirty = status.ok && status.stdout.trim().length > 0;
  const contains = await deps.git(["branch", "-r", "--contains", "HEAD"], cwd);
  const remotes = contains.ok
    ? contains.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  const unpushed = !remotes.some((line) => line.startsWith("origin/"));
  return {
    toplevel,
    remote,
    commitSha,
    branch,
    dirty,
    unpushed,
    github: parseGithubRemote(remote),
  };
}

/** The human commits and pushes; the agent never does. */
export function pushFirstQuestion() {
  return doneQuestion({
    id: "push_first",
    header: "Push",
    question: "Commit and push your changes to GitHub. Done?",
    then: { next: RERUN_SAME_COMMAND },
  });
}

/** The human chose uploads: rescans in the fix loop keep it without asking again. */
export const UPLOAD_NEXT =
  "run the same cleanslop command again, adding --upload, and keep --upload on later scans in this session without asking again";

/** "Scan local files" for a GitHub sign-in, with what it gives up. */
export function uploadOption(description: string) {
  return { value: "upload", label: "Scan local files", description, next: UPLOAD_NEXT };
}

/** GitHub grants that may upload: scan the local files now, or push and scan the commit. */
export function pushOrUploadQuestion(): ActionQuestion {
  return {
    id: "push_or_upload",
    header: "Source",
    question:
      "Your latest changes are not on GitHub. Scan the local files as they are, or push them and scan the pushed commit?",
    options: [
      uploadOption(
        "Includes uncommitted changes; nothing is pushed. No project history or triage"
      ),
      {
        value: "pushed",
        label: "I pushed",
        description: "Scans the commit on GitHub; keeps project history and triage",
        next: RERUN_SAME_COMMAND,
      },
      { value: "stop", label: "Not now", description: "Stop here" },
    ],
  };
}

/** A GitHub sign-in in a folder with nothing on GitHub: upload only after the human says so. */
export function uploadLocalQuestion(): ActionQuestion {
  return {
    id: "upload_local",
    header: "Source",
    question: "This folder isn't on GitHub. Scan its files by uploading them to CleanSlop?",
    options: [
      uploadOption("Uploads this folder's files. No project history or triage"),
      { value: "stop", label: "Not now", description: "Stop here" },
    ],
  };
}

export function assertGithubReady(git: GitSnapshot, opts: { canUpload?: boolean } = {}): void {
  if (!git.github) {
    throw sourceError(
      "origin is not a github.com remote. Phase 1 only scans GitHub App repos.",
      {
        kind: "ask_human",
        humanPrompt:
          "Point origin at a github.com repository, or wait for upload support.",
      }
    );
  }
  if (git.dirty || git.unpushed) {
    const why = [
      git.dirty ? "the working tree is dirty" : null,
      git.unpushed ? "HEAD is not on any origin/* ref" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    throw sourceError(`Ask the human before committing or pushing (${why}).`, {
      kind: "ask_human",
      humanPrompt:
        "This checkout has local changes or an unpushed HEAD. Ask the human to commit and push, then rerun. Do not commit or push yourself.",
      question: opts.canUpload ? pushOrUploadQuestion() : pushFirstQuestion(),
    });
  }
}

export function detectAgentHint(env: CliDeps["env"]): string {
  if (env.get("CLAUDECODE") || env.get("CLAUDE_CODE")) return "claude-code";
  if (env.get("CURSOR_TRACE_ID") || env.get("CURSOR_AGENT")) return "cursor";
  if (env.get("CODEX_HOME") || env.get("CODEX")) return "codex";
  if (env.get("REPL_ID") || env.get("REPLIT_DEV_DOMAIN")) return "replit";
  return "other";
}
