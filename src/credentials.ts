import { join } from "node:path";
import {
  CREDENTIALS_FILE,
  PENDING_LOGIN_FILE,
  PENDING_PLAN_FILE,
  PENDING_SPEND_FILE,
  parseOrigin,
} from "./config.js";
import type { CliDeps } from "./deps.js";
import { CliError, EXIT_USAGE, NotConnectedError, usageError } from "./exit.js";
import { gitToplevel, isPathInsideWorktree } from "./git.js";
import { tokenLast4 } from "./redact.js";

export type OriginCreds = {
  token: string;
  last4: string;
  githubLogin?: string | null;
  grantId?: string | null;
  lastScanId?: string | null;
};

export type CredentialsFile = {
  version: 1;
  origins: Record<string, OriginCreds>;
};

export function resolveOrigin(deps: CliDeps): string {
  const override = deps.env.get("CLEANSLOP_ORIGIN");
  if (override && override.trim()) {
    const parsed = parseOrigin(override);
    if (!parsed) {
      throw usageError(
        "CLEANSLOP_ORIGIN must be an absolute http(s) origin (no path)."
      );
    }
    return parsed;
  }
  return deps.defaultOrigin;
}

export function configDir(deps: CliDeps): string {
  const xdg = deps.env.get("XDG_CONFIG_HOME")?.trim();
  if (xdg) return join(xdg, "cleanslop");
  if (deps.env.platform === "win32") {
    const appdata = deps.env.get("APPDATA")?.trim();
    if (appdata) return join(appdata, "cleanslop");
  }
  return join(deps.env.homeDir(), ".config", "cleanslop");
}

export function credentialsPath(deps: CliDeps): string {
  return join(configDir(deps), CREDENTIALS_FILE);
}

export function pendingLoginPath(deps: CliDeps): string {
  return join(configDir(deps), PENDING_LOGIN_FILE);
}

/** A saved Link spend request buys a credit pack (`credits buy`) or a monthly plan (`plan`). */
export type SpendKind = "pack" | "plan";

const SPEND_KINDS: readonly SpendKind[] = ["pack", "plan"];

export function pendingSpendPath(deps: CliDeps, kind: SpendKind = "pack"): string {
  return join(configDir(deps), kind === "plan" ? PENDING_PLAN_FILE : PENDING_SPEND_FILE);
}

export type PendingSpendRequest = {
  version: 1;
  origin: string;
  spendRequestId: string;
  pack: string;
  amount: number;
  currency: string;
  networkId: string;
  purchaseUrl: string;
  createdAt: number;
  /** Link approval page from spend-request create, re-shown on --no-wait / --resume. */
  approvalUrl?: string;
  /** Created with `link-cli --test`. Absent on files from older CLIs. */
  testMode?: boolean;
  /** Spend-request events already reported to the server (billing Slack). */
  reported?: string[];
};

function isPendingSpend(value: unknown): value is PendingSpendRequest {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    rec.version === 1 &&
    typeof rec.origin === "string" &&
    typeof rec.spendRequestId === "string" &&
    typeof rec.pack === "string" &&
    typeof rec.amount === "number" &&
    typeof rec.currency === "string" &&
    typeof rec.networkId === "string" &&
    typeof rec.purchaseUrl === "string" &&
    typeof rec.createdAt === "number"
  );
}

export function readPendingSpend(
  deps: CliDeps,
  kind: SpendKind = "pack"
): PendingSpendRequest | null {
  const path = pendingSpendPath(deps, kind);
  if (!deps.fs.exists(path)) return null;
  try {
    const parsed: unknown = JSON.parse(deps.fs.read(path));
    return isPendingSpend(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writePendingSpend(
  deps: CliDeps,
  pending: PendingSpendRequest,
  kind: SpendKind = "pack"
): Promise<void> {
  const dir = configDir(deps);
  const path = pendingSpendPath(deps, kind);
  await assertNotInWorktree(deps, path);
  deps.fs.mkdir(dir, 0o700);
  deps.fs.write(path, `${JSON.stringify(pending, null, 2)}\n`, 0o600);
}

export function deletePendingSpend(deps: CliDeps, kind: SpendKind = "pack"): void {
  const path = pendingSpendPath(deps, kind);
  if (deps.fs.exists(path)) deps.fs.rm(path);
}

export type PendingLogin = {
  version: 1;
  origin: string;
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  expiresAt: number;
  interval: number;
};

function isPendingLogin(value: unknown): value is PendingLogin {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    rec.version === 1 &&
    typeof rec.origin === "string" &&
    typeof rec.deviceCode === "string" &&
    typeof rec.userCode === "string" &&
    typeof rec.verificationUriComplete === "string" &&
    typeof rec.expiresAt === "number" &&
    typeof rec.interval === "number"
  );
}

export function readPendingLogin(deps: CliDeps): PendingLogin | null {
  const path = pendingLoginPath(deps);
  if (!deps.fs.exists(path)) return null;
  try {
    const parsed: unknown = JSON.parse(deps.fs.read(path));
    return isPendingLogin(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writePendingLogin(
  deps: CliDeps,
  pending: PendingLogin
): Promise<void> {
  const dir = configDir(deps);
  const path = pendingLoginPath(deps);
  await assertNotInWorktree(deps, path);
  deps.fs.mkdir(dir, 0o700);
  deps.fs.write(path, `${JSON.stringify(pending, null, 2)}\n`, 0o600);
}

export function deletePendingLogin(deps: CliDeps): void {
  const path = pendingLoginPath(deps);
  if (deps.fs.exists(path)) deps.fs.rm(path);
}

/**
 * Removes the pending GitHub login and Link payment saved for `origin`, so a
 * logout leaves nothing for the next command to resume. Another origin's stay;
 * a file that no longer parses goes too.
 */
export function deletePendingFor(deps: CliDeps, origin: string): void {
  const login = pendingLoginPath(deps);
  if (deps.fs.exists(login) && (readPendingLogin(deps)?.origin ?? origin) === origin) {
    deps.fs.rm(login);
  }
  for (const kind of SPEND_KINDS) {
    const spend = pendingSpendPath(deps, kind);
    if (deps.fs.exists(spend) && (readPendingSpend(deps, kind)?.origin ?? origin) === origin) {
      deps.fs.rm(spend);
    }
  }
}

/** Every file the CLI keeps in `configDir`; `logout --all` deletes them all. */
export function deleteAllLocalState(deps: CliDeps): void {
  for (const path of [
    credentialsPath(deps),
    pendingLoginPath(deps),
    ...SPEND_KINDS.map((kind) => pendingSpendPath(deps, kind)),
  ]) {
    if (deps.fs.exists(path)) deps.fs.rm(path);
  }
}

export async function assertNotInWorktree(
  deps: CliDeps,
  targetPath: string
): Promise<void> {
  const top = await gitToplevel(deps, deps.env.cwd());
  if (!top) return;
  if (isPathInsideWorktree(targetPath, top)) {
    throw new CliError(
      `Refusing to write credentials inside the git worktree (${targetPath}). Set XDG_CONFIG_HOME outside this repo.`,
      EXIT_USAGE
    );
  }
}

function emptyFile(): CredentialsFile {
  return { version: 1, origins: {} };
}

export function readCredentialsFile(deps: CliDeps): CredentialsFile {
  const path = credentialsPath(deps);
  if (!deps.fs.exists(path)) return emptyFile();
  try {
    const parsed: unknown = JSON.parse(deps.fs.read(path));
    if (!parsed || typeof parsed !== "object") return emptyFile();
    const rec = parsed as { version?: unknown; origins?: unknown };
    if (rec.version !== 1 || !rec.origins || typeof rec.origins !== "object") {
      return emptyFile();
    }
    return { version: 1, origins: rec.origins as Record<string, OriginCreds> };
  } catch {
    return emptyFile();
  }
}

export async function writeCredentialsFile(
  deps: CliDeps,
  file: CredentialsFile
): Promise<void> {
  const dir = configDir(deps);
  const path = credentialsPath(deps);
  await assertNotInWorktree(deps, path);
  deps.fs.mkdir(dir, 0o700);
  deps.fs.write(path, `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

export type ResolvedToken = {
  token: string;
  last4: string;
  githubLogin: string | null;
  grantId: string | null;
  lastScanId: string | null;
  source: "env" | "file";
};

export function peekStoredCreds(
  deps: CliDeps,
  origin: string
): OriginCreds | null {
  return readCredentialsFile(deps).origins[origin] ?? null;
}

export function resolveToken(deps: CliDeps, origin: string): ResolvedToken | null {
  const envToken = deps.env.get("CLEANSLOP_TOKEN")?.trim();
  const stored = peekStoredCreds(deps, origin);
  if (envToken) {
    return {
      token: envToken,
      last4: tokenLast4(envToken),
      githubLogin: stored?.githubLogin ?? null,
      grantId: stored?.grantId ?? null,
      lastScanId: stored?.lastScanId ?? null,
      source: "env",
    };
  }
  if (!stored?.token) return null;
  return {
    token: stored.token,
    last4: stored.last4 || tokenLast4(stored.token),
    githubLogin: stored.githubLogin ?? null,
    grantId: stored.grantId ?? null,
    lastScanId: stored.lastScanId ?? null,
    source: "file",
  };
}

export function requireToken(deps: CliDeps, origin: string): ResolvedToken {
  const resolved = resolveToken(deps, origin);
  if (!resolved) throw new NotConnectedError(origin);
  return resolved;
}

export async function storeToken(
  deps: CliDeps,
  origin: string,
  input: {
    token: string;
    githubLogin?: string | null;
    grantId?: string | null;
  }
): Promise<OriginCreds> {
  const file = readCredentialsFile(deps);
  const prev = file.origins[origin];
  const next: OriginCreds = {
    token: input.token,
    last4: tokenLast4(input.token),
    githubLogin: input.githubLogin ?? prev?.githubLogin ?? null,
    grantId: input.grantId ?? prev?.grantId ?? null,
    lastScanId: prev?.lastScanId ?? null,
  };
  file.origins[origin] = next;
  await writeCredentialsFile(deps, file);
  return next;
}

export async function storeLastScanId(
  deps: CliDeps,
  origin: string,
  scanId: string
): Promise<void> {
  const file = readCredentialsFile(deps);
  const prev = file.origins[origin];
  if (!prev) return;
  file.origins[origin] = { ...prev, lastScanId: scanId };
  await writeCredentialsFile(deps, file);
}

export async function deleteOriginCreds(
  deps: CliDeps,
  origin: string
): Promise<void> {
  const file = readCredentialsFile(deps);
  if (!file.origins[origin]) {
    return;
  }
  delete file.origins[origin];
  if (Object.keys(file.origins).length === 0) {
    const path = credentialsPath(deps);
    if (deps.fs.exists(path)) deps.fs.rm(path);
    return;
  }
  await writeCredentialsFile(deps, file);
}
