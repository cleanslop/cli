import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultDeps, mergeDeps, type CliDeps } from "../src/deps.js";
import type { GitSnapshot } from "../src/types.js";

export const TEST_TOKEN = "cslop_agt_TESTTOKEN0000000000000000000000000abcd";

export function captureIo(stdinIsTTY = true) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
      stdinIsTTY,
    },
    stdout,
    stderr,
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  };
}

export function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function ok(stdout: string) {
  return { ok: true, stdout: `${stdout}\n`, stderr: "", code: 0 };
}

function fail(stderr = "git failed") {
  return { ok: false, stdout: "", stderr, code: 1 };
}

export function gitStub(
  opts: {
    worktree?: boolean;
    remote?: string;
    sha?: string;
    branch?: string;
    dirty?: boolean;
    unpushed?: boolean;
    toplevel?: string;
    /** `git init` with no commits: HEAD does not resolve. */
    noCommits?: boolean;
  } = {}
): CliDeps["git"] {
  const remote = opts.remote ?? "https://github.com/acme/app.git";
  const sha = opts.sha ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const toplevel = opts.toplevel ?? "/repo";
  return async (args) => {
    const key = args.join(" ");
    if (key === "rev-parse --is-inside-work-tree") {
      return opts.worktree === false ? fail("not a git repo") : ok("true");
    }
    if (key === "rev-parse --show-toplevel") {
      return opts.worktree === false ? fail("not a git repo") : ok(toplevel);
    }
    if (key === "remote get-url origin") {
      return remote ? ok(remote) : fail("no origin");
    }
    if (key === "rev-parse HEAD") return opts.noCommits ? fail("unknown revision HEAD") : ok(sha);
    if (key === "rev-parse --abbrev-ref HEAD") {
      return ok(opts.branch ?? "main");
    }
    if (key === "status --porcelain") {
      return ok(opts.dirty ? " M src/app.ts" : "");
    }
    if (key.startsWith("branch -r --contains")) {
      return ok(opts.unpushed ? "" : "  origin/main");
    }
    if (key === "ls-files -co --exclude-standard") {
      return ok("src/app.ts");
    }
    return fail(`unexpected git ${key}`);
  };
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "cleanslop-cli-"));
}

export function makeDeps(opts: {
  origin: string;
  home: string;
  cwd?: string;
  git?: CliDeps["git"];
  execFile?: CliDeps["execFile"];
  confirm?: CliDeps["confirm"];
  envExtra?: Record<string, string | undefined>;
  stdinIsTTY?: boolean;
  platform?: NodeJS.Platform;
  minPollMs?: number;
  defaultWaitMs?: number;
}): { deps: CliDeps; cap: ReturnType<typeof captureIo>; clock: ReturnType<typeof fakeClock> } {
  const cap = captureIo(opts.stdinIsTTY ?? true);
  const clock = fakeClock();
  const envMap: Record<string, string | undefined> = {
    XDG_CONFIG_HOME: join(opts.home, ".config"),
    HOME: opts.home,
    CLEANSLOP_ORIGIN: opts.origin,
    ...opts.envExtra,
  };
  const real = createDefaultDeps();
  const deps = mergeDeps({
    io: cap.io,
    clock,
    git: opts.git ?? gitStub(),
    ...(opts.execFile ? { execFile: opts.execFile } : {}),
    confirm: opts.confirm ?? (async () => true),
    minPollMs: opts.minPollMs ?? 10,
    defaultWaitMs: opts.defaultWaitMs ?? 1000,
    defaultOrigin: opts.origin,
    env: {
      get: (name) => envMap[name],
      cwd: () => opts.cwd ?? opts.home,
      homeDir: () => opts.home,
      hostname: () => "testhost",
      platform: opts.platform ?? "linux",
    },
    fs: real.fs,
    request: real.request,
    randomId: () => "idem-test-1",
  });
  return { deps, cap, clock };
}

export function assertNoToken(text: string): void {
  if (text.includes(TEST_TOKEN) || /cslop_agt_[A-Za-z0-9]{10,}/.test(text)) {
    throw new Error(`output leaked a token:\n${text}`);
  }
}

export function sampleGit(): GitSnapshot {
  return {
    toplevel: "/repo",
    remote: "https://github.com/acme/app.git",
    commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    branch: "main",
    dirty: false,
    unpushed: false,
    github: { owner: "acme", repo: "app", fullName: "acme/app" },
  };
}

/** The structured question from a CLEANSLOP_ACTION_REQUIRED block, if any. */
export function questionFrom(stderr: string): {
  id: string;
  header: string;
  question: string;
  options: Array<{ value: string; label: string; description?: string; run?: string; next?: string }>;
} | null {
  const line = stderr.split("\n").find((l) => l.startsWith("CLEANSLOP_QUESTION: "));
  return line ? JSON.parse(line.slice("CLEANSLOP_QUESTION: ".length)) : null;
}
