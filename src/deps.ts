import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { DEFAULT_WAIT_MS, MIN_POLL_MS, defaultOrigin } from "./config.js";
import { redactSecrets } from "./redact.js";

export type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

export type HttpResult = {
  status: number;
  headers: Headers;
  text: string;
  json: unknown | null;
};

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdinIsTTY: boolean;
};

export type ExecFileOpts = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
};

export type CliClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type CliEnv = {
  get: (name: string) => string | undefined;
  cwd: () => string;
  homeDir: () => string;
  hostname: () => string;
  platform: NodeJS.Platform;
};

export type CliFs = {
  exists: (path: string) => boolean;
  read: (path: string) => string;
  write: (path: string, data: string, mode: number) => void;
  mkdir: (path: string, mode: number) => void;
  rm: (path: string) => void;
  chmod: (path: string, mode: number) => void;
  statMode: (path: string) => number;
};

export type CliDeps = {
  io: CliIo;
  env: CliEnv;
  fs: CliFs;
  clock: CliClock;
  git: (args: string[], cwd: string) => Promise<GitResult>;
  execFile: (
    file: string,
    args: string[],
    opts?: ExecFileOpts
  ) => Promise<GitResult>;
  confirm: (question: string) => Promise<boolean>;
  request: (url: string, init: RequestInit) => Promise<Response>;
  randomId: () => string;
  minPollMs: number;
  defaultWaitMs: number;
  defaultOrigin: string;
};

function runExecFile(
  file: string,
  args: string[],
  opts: ExecFileOpts = {}
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeout,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : "";
        const errText = typeof stderr === "string" ? stderr : "";
        if (err && "code" in err && err.code === "ENOENT") {
          resolve({
            ok: false,
            stdout: out,
            stderr: errText || err.message,
            code: 127,
          });
          return;
        }
        const code =
          err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({
          ok: code === 0,
          stdout: out,
          stderr: errText,
          code,
        });
      }
    );
  });
}

async function defaultConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stderr.write(redactSecrets(`${question} [y/N] `));
  const line = await new Promise<string>((resolve) => {
    const onData = (buf: Buffer) => {
      process.stdin.off("data", onData);
      resolve(buf.toString("utf8"));
    };
    process.stdin.once("data", onData);
  });
  return /^\s*y(es)?\s*$/i.test(line);
}

function spawnGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", (err) => {
      resolve({
        ok: false,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        code: 1,
      });
    });
    child.on("close", (code) => {
      const status = code ?? 1;
      resolve({
        ok: status === 0,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: status,
      });
    });
  });
}

export function createDefaultDeps(): CliDeps {
  return {
    io: {
      stdout: (text) => {
        process.stdout.write(redactSecrets(text));
      },
      stderr: (text) => {
        process.stderr.write(redactSecrets(text));
      },
      stdinIsTTY: Boolean(process.stdin.isTTY),
    },
    env: {
      get: (name) => process.env[name],
      cwd: () => process.cwd(),
      homeDir: () => homedir(),
      hostname: () => hostname(),
      platform: platform(),
    },
    fs: {
      exists: (path) => existsSync(path),
      read: (path) => readFileSync(path, "utf8"),
      write: (path, data, mode) => {
        const tmp = `${path}.tmp-${process.pid}`;
        writeFileSync(tmp, data, { mode });
        renameSync(tmp, path);
        chmodSync(path, mode);
      },
      mkdir: (path, mode) => {
        mkdirSync(path, { recursive: true, mode });
        chmodSync(path, mode);
      },
      rm: (path) => {
        rmSync(path, { force: true });
      },
      chmod: (path, mode) => {
        chmodSync(path, mode);
      },
      statMode: (path) => statSync(path).mode & 0o777,
    },
    clock: {
      now: () => Date.now(),
      sleep: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
    },
    git: spawnGit,
    execFile: runExecFile,
    confirm: defaultConfirm,
    request: (url, init) => fetch(url, init),
    randomId: () => crypto.randomUUID(),
    minPollMs: MIN_POLL_MS,
    defaultWaitMs: DEFAULT_WAIT_MS,
    defaultOrigin: defaultOrigin(),
  };
}

export function mergeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  const base = createDefaultDeps();
  return {
    ...base,
    ...overrides,
    io: { ...base.io, ...overrides.io },
    env: { ...base.env, ...overrides.env },
    fs: { ...base.fs, ...overrides.fs },
    clock: { ...base.clock, ...overrides.clock },
  };
}
