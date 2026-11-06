import { posix, resolve, win32 } from "node:path";
import { writeAction } from "./action.js";
import {
  CLIENT_ID,
  LINK_CLI_MIN_VERSION,
  LINK_CLI_NPX_TIMEOUT_MS,
  LINK_CLI_PACKAGE,
  LINK_CLI_TIMEOUT_MS,
} from "./config.js";
import { configDir } from "./credentials.js";
import type { CliDeps, GitResult } from "./deps.js";
import { doneQuestion, RERUN_SAME_COMMAND, RESUME_SAME_COMMAND } from "./done-question.js";
import {
  actionError,
  CliError,
  EXIT_ACTION,
  EXIT_UNEXPECTED,
  EXIT_USAGE,
  usageError,
  type ActionQuestion,
  type ActionRequired,
} from "./exit.js";
import { detectAgentHint, gitToplevel, isPathInsideWorktree } from "./git.js";
import { asRecord } from "./http.js";
import { redactSecrets } from "./redact.js";
import type { ParsedArgs } from "./types.js";

const LINK_INSTALL_HINT =
  "Could not run Stripe's link-cli: it is not on PATH and npx is unavailable. Install Node.js (with npm) or set CLEANSLOP_LINK_CLI.";
const EMPTY_POOL_HINT =
  "Link did not issue agent attestations. Run `cleanslop login --link` again; if it repeats, contact CleanSlop support.";
const LINK_AUTH_CLIENT_NAME = "CleanSlop";
/**
 * Spend-request / SPT grant. Login never requests this. `credits buy` adds it
 * with `auth upgrade` (or `auth login` when there is no session yet), always
 * alongside `LINK_LOGIN_SCOPE` so the session can still issue attestations.
 */
export const LINK_PAYMENT_SCOPE = "payment_methods.agentic";
/**
 * link-cli defaults to `userinfo:read payment_methods.agentic` when `--scope`
 * is omitted. Login must pass a non-empty non-payment scope.
 * Email still comes from the identity presentation; we never call
 * `user-info retrieve`.
 */
export const LINK_LOGIN_SCOPE = "userinfo:read";
/**
 * Attestations need `LINK_LOGIN_SCOPE`. link-cli's `auth upgrade` drops the
 * session's old scopes when its refresh fails, so payment grants ask again.
 */
const LINK_PAYMENT_GRANT_SCOPE = `${LINK_LOGIN_SCOPE} ${LINK_PAYMENT_SCOPE}`;
export const LINK_IDENTITY_CLAIMS = ["email", "email_verified"] as const;
const LINK_AUTH_POLL_MS = 5_000;
const LINK_AUTH_WAIT_MS = 5 * 60_000;
const LINK_ATTESTATION_BATCH = "10";
const EMPTY_POOL_PATTERN = /pool is empty|ATTESTATION_POOL_EMPTY|no attestation/i;
const MISSING_SCOPE_PATTERN = /missing required scopes/i;
/** link-cli's own check: nothing reached Link. */
const EXPIRY_INPUT_INVALID = /Expiry must be Unix seconds or an ISO 8601 timestamp/i;
/** A validation refusal from Link (400 / invalid request), not a timeout or 5xx. */
const VALIDATION_REFUSAL = /\(400\)|"status"\s*:\s*400|\bINVALID_(?:INPUT|ARGUMENT)\b|invalid_request_error/;

/**
 * Only a definite refusal of `--expires-at` may retry with a new idempotency
 * key: an unclear failure might have created the request already.
 */
function isExpiryRejected(result: GitResult): boolean {
  const text = `${result.stderr} ${result.stdout}`;
  if (EXPIRY_INPUT_INVALID.test(text)) return true;
  return VALIDATION_REFUSAL.test(text) && /\bexpires_at\b/i.test(text);
}
const RENEW_CREDENTIAL_PATTERN =
  /no saved identity credential|identity credential has expired|no credential|not found|empty/i;

export type LinkAttestation = {
  authorization: string;
};

export type LinkPresentation = {
  presentation: string;
};

export type LinkClaimsChallenge = {
  aud: string;
  nonce: string;
  claims: string[];
  interactionId: string;
};

/**
 * `PATH` comes from `linkCliRuntime`. Every other spelling (`Path` on
 * Windows) is dropped so the filtered one is the only PATH the child sees.
 */
function linkEnv(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== "PATH") env[key] = value;
  }
  return {
    ...env,
    PATH: path,
    LINK_IDENTITY_COMMANDS: "1",
    // link-cli's postinstall otherwise adds Stripe's payment skill to the
    // person's agent setup when the npx fallback installs it.
    LINK_CLI_SKIP_SKILL_INSTALL: "1",
  };
}

type LinkCliCommand = { file: string; prefix: string[]; npx?: true };

/** Where every link-cli run happens, and the PATH it sees. Resolved once per run. */
type LinkCliRuntime = { cwd: string; path: string };

type ResolvedLinkCli =
  | { cmd: LinkCliCommand; runtime: LinkCliRuntime }
  /** `CLEANSLOP_LINK_CLI` is missing: every call returns this result (exit 127). */
  | { missing: GitResult };

const PATH_LINK_CLI: LinkCliCommand = { file: "link-cli", prefix: [] };
const NPX_LINK_CLI: LinkCliCommand = {
  file: "npx",
  prefix: ["--yes", "--package", LINK_CLI_PACKAGE, "--", "link-cli"],
  npx: true,
};

/** Per-run choice between `link-cli` on PATH and the pinned npx copy. */
const resolvedLinkCli = new WeakMap<CliDeps, ResolvedLinkCli>();

export type LinkCliVersion = { core: [number, number, number]; prerelease: boolean };

/** The first `x.y.z[-pre]` in link-cli's `--version` output. */
export function parseLinkCliVersion(text: string): LinkCliVersion | null {
  const match = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(text);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}

/** Semver order for the core; `1.2.0-beta.1` sorts below `1.2.0`. */
export function linkCliVersionAtLeast(text: string, min = LINK_CLI_MIN_VERSION): boolean {
  const have = parseLinkCliVersion(text);
  const want = parseLinkCliVersion(min);
  if (!have || !want) return false;
  for (let i = 0; i < 3; i++) {
    if (have.core[i]! !== want.core[i]!) return have.core[i]! > want.core[i]!;
  }
  return !have.prerelease || want.prerelease;
}

function formatLinkCliVersion(text: string): string | null {
  const match = /\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?/.exec(text);
  return match ? match[0] : null;
}

/**
 * The scanned repo must not choose which link-cli runs: `npx @cleanslop/cli`
 * puts the project's `node_modules/.bin` (and its parents') on PATH, and any
 * dependency can ship a `link-cli` bin. Drops every `node_modules/.bin` whose
 * project is inside one of `roots` or contains it, and relative entries.
 */
export function linkCliSearchPath(
  pathValue: string,
  platform: NodeJS.Platform,
  roots: string[]
): string {
  const windows = platform === "win32";
  const paths = windows ? win32 : posix;
  // Windows paths ignore case; POSIX ones resolve symlinks and fail closed.
  const inside = windows
    ? (child: string, parent: string) => {
        const rel = win32.relative(parent.toLowerCase(), child.toLowerCase());
        return rel === "" || (!rel.startsWith("..") && !win32.isAbsolute(rel));
      }
    : isPathInsideWorktree;
  const binDir = windows ? /[\\/]node_modules[\\/]\.bin$/i : /\/node_modules\/\.bin$/;
  return pathValue
    .split(paths.delimiter)
    .filter((entry) => {
      if (!entry || !paths.isAbsolute(entry)) return false;
      const dir = paths.normalize(entry).replace(/[\\/]+$/, "");
      if (!binDir.test(dir)) return true;
      const project = paths.dirname(paths.dirname(dir));
      return !roots.some((root) => inside(project, root) || inside(root, project));
    })
    .join(paths.delimiter);
}

/**
 * Not the repo, so npx ignores the project's `.npmrc` and local installs.
 * link-cli keeps its session in the OS config folder whatever the cwd, so
 * the person's own link-cli and ours share one session.
 */
function linkCliCwd(deps: CliDeps): string {
  const dir = configDir(deps);
  try {
    deps.fs.mkdir(dir, 0o700);
    return dir;
  } catch {
    return deps.env.homeDir();
  }
}

async function linkCliRuntime(deps: CliDeps): Promise<LinkCliRuntime> {
  const cwd = resolve(deps.env.cwd());
  const top = await gitToplevel(deps, cwd).catch(() => null);
  const roots = top && resolve(top) !== cwd ? [cwd, resolve(top)] : [cwd];
  return {
    cwd: linkCliCwd(deps),
    path: linkCliSearchPath(
      deps.env.get("PATH") ?? process.env.PATH ?? "",
      deps.env.platform,
      roots
    ),
  };
}

function execLinkCli(
  deps: CliDeps,
  cmd: LinkCliCommand,
  runtime: LinkCliRuntime,
  args: string[],
  timeout: number,
  extraEnv: Record<string, string> = {}
): Promise<GitResult> {
  return deps.execFile(cmd.file, [...cmd.prefix, ...args], {
    // The first npx run downloads link-cli and its dependencies.
    timeout: cmd.npx ? Math.max(timeout, LINK_CLI_NPX_TIMEOUT_MS) : timeout,
    cwd: runtime.cwd,
    env: { ...linkEnv(runtime.path), ...extraEnv },
  });
}

/**
 * Link runs from the config folder, so a relative `CLEANSLOP_LINK_CLI`
 * (`./bin/link-cli`) is resolved against the person's folder first. A bare
 * name (`link-cli`) is still looked up on the filtered PATH.
 */
function linkCliOverride(deps: CliDeps): string | null {
  const raw = deps.env.get("CLEANSLOP_LINK_CLI")?.trim();
  if (!raw) return null;
  const paths = deps.env.platform === "win32" ? win32 : posix;
  if (paths.isAbsolute(raw) || !/[\\/]/.test(raw)) return raw;
  return paths.resolve(deps.env.cwd(), raw);
}

/**
 * `CLEANSLOP_LINK_CLI` (must be `LINK_CLI_MIN_VERSION` or later), else
 * `link-cli` on PATH when it is new enough, else the pinned
 * `@stripe/link-cli` through npx, so `npx @cleanslop/cli` needs nothing else
 * installed.
 */
async function resolveLinkCli(deps: CliDeps): Promise<ResolvedLinkCli> {
  const known = resolvedLinkCli.get(deps);
  if (known) return known;
  const runtime = await linkCliRuntime(deps);
  const override = linkCliOverride(deps);
  let resolved: ResolvedLinkCli;
  if (override) {
    const cmd: LinkCliCommand = { file: override, prefix: [] };
    const probe = await execLinkCli(deps, cmd, runtime, ["--version"], LINK_CLI_TIMEOUT_MS);
    if (probe.code === 127) {
      resolved = { missing: probe };
    } else if (!probe.ok) {
      const detail = redactSecrets((probe.stderr || probe.stdout || "").trim()).slice(0, 200);
      throw new CliError(
        `CLEANSLOP_LINK_CLI (${override}) did not answer \`--version\` (exit ${probe.code}${detail ? `: ${detail}` : ""}). CleanSlop needs link-cli ${LINK_CLI_MIN_VERSION} or later; fix it, or unset CLEANSLOP_LINK_CLI to use the bundled ${LINK_CLI_PACKAGE}.`,
        EXIT_USAGE
      );
    } else if (!linkCliVersionAtLeast(probe.stdout)) {
      const version = formatLinkCliVersion(probe.stdout);
      throw new CliError(
        `CLEANSLOP_LINK_CLI (${override}) is link-cli ${version ?? "of an unknown version"}; CleanSlop needs link-cli ${LINK_CLI_MIN_VERSION} or later. Update it, or unset CLEANSLOP_LINK_CLI to use the bundled ${LINK_CLI_PACKAGE}.`,
        EXIT_USAGE
      );
    } else {
      resolved = { cmd, runtime };
    }
  } else {
    const probe = await execLinkCli(deps, PATH_LINK_CLI, runtime, ["--version"], LINK_CLI_TIMEOUT_MS);
    const usePath = probe.ok && linkCliVersionAtLeast(probe.stdout);
    resolved = { cmd: usePath ? PATH_LINK_CLI : NPX_LINK_CLI, runtime };
  }
  resolvedLinkCli.set(deps, resolved);
  return resolved;
}

export async function runLinkCli(
  deps: CliDeps,
  args: string[],
  opts: { timeout?: number; env?: Record<string, string> } = {}
): Promise<GitResult> {
  const timeout = opts.timeout ?? LINK_CLI_TIMEOUT_MS;
  const resolved = await resolveLinkCli(deps);
  if ("missing" in resolved) return resolved.missing;
  return execLinkCli(deps, resolved.cmd, resolved.runtime, args, timeout, opts.env);
}

function throwLinkCliFailure(result: GitResult, fallback: string): never {
  const detail = redactSecrets((result.stderr || result.stdout || "").trim());
  if (result.code === 127) {
    throw actionError(LINK_INSTALL_HINT, {
      kind: "ask_human",
      humanPrompt: LINK_INSTALL_HINT,
      question: doneQuestion({
        id: "install_link_cli",
        header: "Install",
        question:
          "CleanSlop needs Stripe's link-cli. Install Node.js (with npm), or set CLEANSLOP_LINK_CLI to link-cli's path. Done?",
        then: { next: RERUN_SAME_COMMAND },
      }),
    });
  }
  if (EMPTY_POOL_PATTERN.test(`${result.stderr} ${result.stdout}`)) {
    throw actionError("Link did not issue agent attestations.", {
      kind: "ask_human",
      humanPrompt: EMPTY_POOL_HINT,
    });
  }
  throw new CliError(detail || fallback, EXIT_ACTION);
}

function parseLinkJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    // Polling commands (`auth status`, `auth login`) print an array of snapshots.
    return asRecord(Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed);
  } catch {
    return null;
  }
}

type LinkAuthKind = "login" | "upgrade";

type LinkSession = {
  authenticated: boolean;
  hasPaymentScope: boolean;
  /** Link reported the session's scopes and they lack `LINK_LOGIN_SCOPE`. */
  missingLoginScope: boolean;
  /** Link reported the session's scopes and they lack `LINK_PAYMENT_SCOPE`. */
  missingPaymentScope: boolean;
};

export function linkScopeTokens(scope: unknown): string[] {
  if (typeof scope === "string") {
    return scope.trim().split(/[\s,]+/).filter(Boolean);
  }
  if (Array.isArray(scope)) {
    return scope.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  }
  return [];
}

/** Never relays `auth status` output: it carries a Link access-token prefix. */
async function readLinkSession(deps: CliDeps): Promise<LinkSession> {
  const result = await runLinkCli(deps, ["auth", "status", "--format", "json"]);
  if (!result.ok) throwLinkCliFailure(result, "Could not check the Link session.");
  const json = parseLinkJson(result.stdout);
  const authenticated = json?.authenticated === true;
  // link-cli only reports `scope` when Link's token response carries it, so
  // an unreported scope is not treated as missing.
  const scopes = authenticated ? linkScopeTokens(json?.scope) : [];
  return {
    authenticated,
    hasPaymentScope: scopes.includes(LINK_PAYMENT_SCOPE),
    missingLoginScope: scopes.length > 0 && !scopes.includes(LINK_LOGIN_SCOPE),
    missingPaymentScope: scopes.length > 0 && !scopes.includes(LINK_PAYMENT_SCOPE),
  };
}

/** What Link asks before the purchase approval itself. */
export type LinkPaymentStep = "approve" | "permission" | "sign-in";

/**
 * Mirrors `ensureLinkPaymentScope` so the pack question can say what comes
 * first. Best effort: a failed check falls back to "approve".
 */
export async function linkPaymentStep(deps: CliDeps): Promise<LinkPaymentStep> {
  try {
    const session = await readLinkSession(deps);
    if (!session.authenticated) return "sign-in";
    return session.hasPaymentScope ? "approve" : "permission";
  } catch {
    return "approve";
  }
}

export type LinkAuthMode = "wait" | "no-wait" | "resume";

export function linkAuthMode(args: ParsedArgs): LinkAuthMode {
  if (args.noWait && args.resume) {
    throw usageError("Use either --no-wait or --resume, not both.");
  }
  if (args.noWait) return "no-wait";
  return args.resume ? "resume" : "wait";
}

/** Whether this approval lets CleanSlop request payments (a cold `credits buy` login does too). */
function grantsPayments(scope: string): boolean {
  return linkScopeTokens(scope).includes(LINK_PAYMENT_SCOPE);
}

/**
 * The payment permission is not a payment, and agents read "approve" next to
 * a pack price as "approve the purchase": say so in both prompt and question.
 */
const NOT_THE_PAYMENT =
  "This only grants permission: nothing is charged now, and Link asks for the purchase separately next.";

function linkAuthWhat(kind: LinkAuthKind, payments: boolean): string {
  if (!payments) return "approve CleanSlop in Link";
  return kind === "login"
    ? "sign in and allow CleanSlop to request Link payments"
    : "allow CleanSlop to request Link payments";
}

function linkAuthAsk(kind: LinkAuthKind, payments: boolean): string {
  const ask = `Ask the human to open this link and ${linkAuthWhat(kind, payments)}.`;
  return payments ? `${ask} ${NOT_THE_PAYMENT}` : ask;
}

function linkAuthQuestion(
  kind: LinkAuthKind,
  payments: boolean,
  url: string,
  phrase: string | undefined
): ActionQuestion {
  const check = phrase ? `, check the phrase "${phrase}",` : "";
  const note = payments ? ` ${NOT_THE_PAYMENT}` : "";
  return doneQuestion({
    id: "link_approval",
    header: payments ? "Permission" : "Sign in",
    question: `Open ${url}${check} and ${linkAuthWhat(kind, payments)}.${note} Done?`,
    then: { next: RESUME_SAME_COMMAND },
  });
}

/**
 * Starts a Link device approval (`auth login` or `auth upgrade`) and prints the
 * approval link. `wait` then polls in-process; `no-wait` exits 10 so a
 * foreground agent can relay the link, and `resume` polls the request
 * link-cli already has pending without starting a new one.
 */
async function completeLinkDeviceAuth(
  deps: CliDeps,
  opts: {
    kind: LinkAuthKind;
    scope: string;
    mode: LinkAuthMode;
    command: string;
  }
): Promise<void> {
  const { kind, scope, mode, command } = opts;
  const payments = grantsPayments(scope);
  let approval: Pick<ActionRequired, "url" | "code"> = {};
  if (mode !== "resume") {
    const started = await runLinkCli(deps, [
      "auth",
      kind,
      "--client-name",
      LINK_AUTH_CLIENT_NAME,
      "--scope",
      scope,
      // link-cli 1.1+ login otherwise also asks for the person's balances and
      // transactions. `upgrade` keeps the session's own and rejects the flag.
      ...(kind === "login" ? ["--no-financial-insights"] : []),
      "--format",
      "json",
    ]);
    if (!started.ok) {
      throwLinkCliFailure(
        started,
        payments
          ? "Could not start a Link payment grant."
          : "Could not start Link sign-in."
      );
    }
    const json = parseLinkJson(started.stdout);
    const url = typeof json?.verification_url === "string" ? json.verification_url : "";
    const phrase = typeof json?.phrase === "string" ? json.phrase : undefined;
    if (!url) {
      throw new CliError("link-cli did not return a Link approval link.", EXIT_UNEXPECTED);
    }
    approval = { url, ...(phrase ? { code: phrase } : {}) };
    const ask = linkAuthAsk(kind, payments);
    if (mode === "no-wait") {
      throw actionError(payments ? "Link payment permission pending." : "Link approval pending.", {
        kind: "approve",
        humanPrompt: `${ask} After they approve, run the same command with --resume instead of --no-wait.`,
        ...approval,
        question: linkAuthQuestion(kind, payments, url, phrase),
      });
    }
    writeAction(deps, {
      kind: "approve",
      humanPrompt: `${ask} Waiting for approval.`,
      ...approval,
    });
  }
  const deadline = deps.clock.now() + LINK_AUTH_WAIT_MS;
  while (deps.clock.now() < deadline) {
    await deps.clock.sleep(LINK_AUTH_POLL_MS);
    // A pending `auth upgrade` reports authenticated:false until approved, so
    // signed-in is the completion signal for both kinds. Do not wait on
    // `scope`: link-cli only reports it when Link's token response carries it.
    if ((await readLinkSession(deps)).authenticated) return;
  }
  throw actionError("Link approval timed out.", {
    kind: "approve",
    ...approval,
    humanPrompt: `The Link approval was not completed in time. Run \`${command}${mode === "resume" ? " --no-wait" : ""}\` again for a new link.`,
  });
}

type LinkAuthOpts = { mode?: LinkAuthMode; command?: string };

/**
 * `--resume` only polls an approval link-cli already has pending. A signed-in
 * session that still needs an upgrade has none pending, so start one and exit.
 */
function upgradeMode(mode: LinkAuthMode | undefined): LinkAuthMode | undefined {
  return mode === "resume" ? "no-wait" : mode;
}

/**
 * Starts Link's device sign-in when link-cli has no session (a fresh machine or
 * cloud sandbox), or upgrades a session without `LINK_LOGIN_SCOPE` (one a cold
 * payment login made with an older CLI). Does not request
 * `payment_methods.agentic`.
 */
export async function ensureLinkAuth(deps: CliDeps, opts: LinkAuthOpts = {}): Promise<void> {
  const session = await readLinkSession(deps);
  if (session.authenticated && !session.missingLoginScope) return;
  if (!session.authenticated) {
    await addLinkLoginScope(deps, "login", opts);
    return;
  }
  await addLinkLoginScope(deps, "upgrade", { ...opts, mode: upgradeMode(opts.mode) });
}

function addLinkLoginScope(
  deps: CliDeps,
  kind: LinkAuthKind,
  opts: LinkAuthOpts
): Promise<void> {
  return completeLinkDeviceAuth(deps, {
    kind,
    scope: LINK_LOGIN_SCOPE,
    mode: opts.mode ?? "wait",
    command: opts.command ?? "cleanslop login --link",
  });
}

/**
 * Ensures the Link session can create spend requests. Existing sessions that
 * already granted `payment_methods.agentic` are left as-is. A session without
 * that grant is widened with `auth upgrade`. No session logs in with the
 * payment scope so a cold `credits buy` is one approval, not login + upgrade.
 */
export async function ensureLinkPaymentScope(
  deps: CliDeps,
  opts: { mode?: LinkAuthMode; command?: string } = {}
): Promise<void> {
  const mode = opts.mode ?? "wait";
  const command = opts.command ?? "cleanslop credits buy --link";
  const session = await readLinkSession(deps);
  if (!session.authenticated) {
    await completeLinkDeviceAuth(deps, {
      kind: "login",
      scope: LINK_PAYMENT_GRANT_SCOPE,
      mode,
      command,
    });
    return;
  }
  if (session.hasPaymentScope) return;
  // Under --resume, an unreported scope is most likely the grant the human
  // just approved; a refusal from Link still upgrades (`grantLinkPayments`).
  if (mode === "resume" && !session.missingPaymentScope) return;
  await grantLinkPayments(deps, { mode, command });
}

/** Upgrades the session to `LINK_PAYMENT_GRANT_SCOPE`, starting a new approval under --resume. */
export function grantLinkPayments(
  deps: CliDeps,
  opts: { mode?: LinkAuthMode; command?: string } = {}
): Promise<void> {
  return completeLinkDeviceAuth(deps, {
    kind: "upgrade",
    scope: LINK_PAYMENT_GRANT_SCOPE,
    mode: upgradeMode(opts.mode) ?? "wait",
    command: opts.command ?? "cleanslop credits buy --link",
  });
}

async function tryPopAttestation(deps: CliDeps): Promise<LinkAttestation | null> {
  const result = await runLinkCli(deps, [
    "identity",
    "attestations",
    "pop",
    "--format",
    "json",
  ]);
  if (!result.ok) {
    if (EMPTY_POOL_PATTERN.test(`${result.stderr} ${result.stdout}`)) return null;
    throwLinkCliFailure(result, "Could not pop a Link attestation.");
  }
  const json = parseLinkJson(result.stdout);
  const authorization =
    typeof json?.authorization === "string" ? json.authorization.trim() : "";
  return authorization ? { authorization } : null;
}

function requestAttestations(deps: CliDeps): Promise<GitResult> {
  return runLinkCli(deps, [
    "identity",
    "attestations",
    "request",
    "--count",
    LINK_ATTESTATION_BATCH,
    "--format",
    "json",
  ]);
}

/**
 * Signs in to Link when needed, then pops an attestation, refilling an empty
 * pool (Link issues attestations without a per-request approval). When Link
 * refuses the refill for a missing scope that `auth status` did not report,
 * upgrades the session once and retries.
 */
export async function linkAttestation(
  deps: CliDeps,
  opts: LinkAuthOpts = {}
): Promise<LinkAttestation> {
  await ensureLinkAuth(deps, opts);
  const pooled = await tryPopAttestation(deps);
  if (pooled) return pooled;
  let requested = await requestAttestations(deps);
  if (!requested.ok && MISSING_SCOPE_PATTERN.test(`${requested.stderr} ${requested.stdout}`)) {
    await addLinkLoginScope(deps, "upgrade", { ...opts, mode: upgradeMode(opts.mode) });
    requested = await requestAttestations(deps);
  }
  if (!requested.ok) {
    throwLinkCliFailure(requested, "Could not request Link attestations.");
  }
  const refilled = await tryPopAttestation(deps);
  if (refilled) return refilled;
  throw actionError("Link did not issue agent attestations.", {
    kind: "ask_human",
    humanPrompt: EMPTY_POOL_HINT,
  });
}

/**
 * One API call with the signed-in session: nothing for the human to approve,
 * so a failure is a Link or session error (`login --link` then offers GitHub).
 */
export async function requestLinkCredentials(deps: CliDeps): Promise<void> {
  // link-cli 0.27 has no claim filter on request; Link still mints a local
  // pack that can include name and phone. We only present email claims.
  const result = await runLinkCli(deps, ["identity", "credentials", "request"], {
    timeout: 120_000,
  });
  if (!result.ok) {
    throwLinkCliFailure(result, "Link did not issue an identity credential.");
  }
}

export async function presentLinkIdentity(
  deps: CliDeps,
  input: { aud: string; nonce: string }
): Promise<LinkPresentation> {
  const args = [
    "identity",
    "credentials",
    "present",
    "--aud",
    input.aud,
    "--nonce",
    input.nonce,
    ...LINK_IDENTITY_CLAIMS.flatMap((claim) => ["--claim", claim]),
    "--format",
    "json",
  ];
  let result = await runLinkCli(deps, args);
  // link-cli will not present a missing or expired saved credential;
  // `credentials request` replaces it.
  const renewCred =
    !result.ok &&
    RENEW_CREDENTIAL_PATTERN.test(`${result.stderr} ${result.stdout}`);
  if (renewCred) {
    await requestLinkCredentials(deps);
    result = await runLinkCli(deps, args);
  }
  if (!result.ok) {
    throwLinkCliFailure(result, "Could not present a Link identity.");
  }
  const json = parseLinkJson(result.stdout);
  const presentation =
    typeof json?.presentation === "string" ? json.presentation.trim() : "";
  if (!presentation) {
    throw new CliError(
      "link-cli did not return an identity presentation.",
      EXIT_UNEXPECTED
    );
  }
  return { presentation };
}

export function readLinkClaimsChallenge(
  body: unknown,
  origin: string
): LinkClaimsChallenge {
  const rec = asRecord(body);
  if (!rec) {
    throw new CliError("Link challenge was not JSON.", EXIT_UNEXPECTED);
  }
  const aud = typeof rec.aud === "string" ? rec.aud : "";
  if (aud !== origin) {
    throw actionError(
      `Refusing Link challenge: audience ${aud || "(missing)"} is not ${origin}.`,
      {
        kind: "ask_human",
        humanPrompt:
          "The Link challenge audience did not match CLEANSLOP_ORIGIN. Check AUTH_URL / CLEANSLOP_ORIGIN.",
      }
    );
  }
  const claimsRaw = rec.claims;
  const claims = Array.isArray(claimsRaw)
    ? claimsRaw.filter((item): item is string => typeof item === "string")
    : [];
  const expected = [...LINK_IDENTITY_CLAIMS];
  const sameClaims =
    claims.length === expected.length &&
    expected.every((name) => claims.includes(name));
  if (!sameClaims) {
    throw actionError("Refusing Link challenge: claims must be exactly email and email_verified.", {
      kind: "ask_human",
      humanPrompt:
        "CleanSlop will only accept a Link email presentation. The server asked for different claims.",
    });
  }
  const interactionId =
    typeof rec.interaction_id === "string" ? rec.interaction_id : "";
  const nonce = typeof rec.nonce === "string" ? rec.nonce : "";
  if (!interactionId || !nonce) {
    throw new CliError("Link challenge was missing nonce or interaction_id.", EXIT_UNEXPECTED);
  }
  return { aud, nonce, claims, interactionId };
}

export type LinkConsentSource = "flag" | "tty";

export function linkTermsUrl(origin: string): string {
  return `${origin}/terms`;
}

/** Asked only when the Link-verified email has no CleanSlop account yet. */
export function linkSignupQuestion(origin: string, termsUrl: string): string {
  return `Create a CleanSlop account (${origin}) with your Link-verified email, and agree to the CleanSlop terms (${termsUrl})?`;
}

/**
 * Yes/No on the quoted consent question. Like the prose block, it never names
 * the consent flag: the agent continues per its CleanSlop instructions only
 * after the human's yes.
 */
function consentQuestion(id: string, header: string, question: string): ActionQuestion {
  return {
    id,
    header,
    question,
    options: [
      {
        value: "yes",
        label: "Yes",
        next: "continue as your CleanSlop instructions say for a yes",
      },
      { value: "no", label: "No", description: "Stop here" },
    ],
  };
}

/** `--accept-terms --yes-share-email` is the older spelling of `--agree`. */
export function linkTermsAgreed(args: ParsedArgs): boolean {
  return args.agree || (args.acceptTerms && args.yesShareEmail);
}

/**
 * The terms question for a new account. Choosing Link and approving it in
 * Link already covers sharing the verified email, so returning users and
 * emails that belong to a GitHub account are never asked.
 */
export async function requireLinkTermsConsent(
  deps: CliDeps,
  origin: string
): Promise<LinkConsentSource> {
  const termsUrl = linkTermsUrl(origin);
  deps.io.stderr(`CleanSlop terms: ${termsUrl}\n`);
  const question = linkSignupQuestion(origin, termsUrl);
  if (!deps.io.stdinIsTTY) {
    throw actionError("Human consent is required.", {
      kind: "ask_human",
      humanPrompt: question,
      url: termsUrl,
      question: consentQuestion("link_signup_consent", "Sign up", question),
    });
  }
  if (!(await deps.confirm(question))) {
    throw actionError("Sign-up was declined.", {
      kind: "ask_human",
      humanPrompt: question,
      url: termsUrl,
    });
  }
  return "tty";
}

/** Same schedule as link-cli `runMppPayWithSpendRequest`. */
export const SPT_RETRIEVAL_DELAYS_MS = [
  0, 1000, 1000, 1000, 1000, 2000, 2000, 2000, 2000,
];

export type SpendRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "requires_action"
  | "canceled"
  | "failed"
  /** The merchant (CleanSlop) is charging the token, or already did. Never pay again. */
  | "submitted"
  | "succeeded"
  | "unknown";

/** Link's `next_action`: what the human must do, and whether the request resumes after. */
export type SpendRequestNextAction = {
  /** `auto_resume`, `create_new_spend_request`, `create_new_spend_request_after_completion`. */
  resolution: string | null;
  /** e.g. `three_d_secure`, `partner_auth_challenge`, `add_payment_method`. */
  type: string | null;
  displayMessage: string | null;
  actionUrl: string | null;
};

export type SpendRequestSnapshot = {
  id: string;
  status: SpendRequestStatus;
  displayMessage: string | null;
  resolution: string | null;
  actionType: string | null;
  actionUrl: string | null;
  /**
   * `status_details.failed.code`, else a failed payment's
   * `payment_status_details.decline_code` / `code`, else
   * `status_details.requires_action.failure_code`.
   */
  failureCode: string | null;
  sharedPaymentToken: string | null;
  approvalUrl: string | null;
};

function spendRequestStatus(raw: string): SpendRequestStatus {
  switch (raw) {
    case "pending":
    case "pending_approval":
    case "created":
      return "pending";
    case "approved":
    case "submitted":
    case "succeeded":
    case "denied":
    case "expired":
    case "requires_action":
    case "canceled":
    case "failed":
      return raw;
    default:
      return "unknown";
  }
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** link-cli's `NextAction`; `resolution` was an object in older fixtures. */
export function parseNextAction(value: unknown): SpendRequestNextAction | null {
  const next = asRecord(value);
  if (!next) return null;
  const raw = next.resolution;
  return {
    resolution: nonEmpty(raw) ?? nonEmpty(asRecord(raw)?.type),
    type: nonEmpty(next.type),
    displayMessage: nonEmpty(next.display_message),
    actionUrl: httpUrl(next.action_url),
  };
}

/**
 * link-cli puts the action under `status_details.<status>.next_action`, so the
 * current status's entry wins over a stale one; the top-level `next_action`
 * is only a fallback for other shapes.
 */
function nextActionOf(
  json: Record<string, unknown>,
  status: SpendRequestStatus
): SpendRequestNextAction | null {
  const details = asRecord(json.status_details);
  const failed = parseNextAction(asRecord(details?.failed)?.next_action);
  const action = parseNextAction(asRecord(details?.requires_action)?.next_action);
  const ordered = status === "failed" ? [failed, action] : [action, failed];
  return ordered[0] ?? ordered[1] ?? parseNextAction(json.next_action);
}

/** Codes only (`card_declined`): nothing free-form reaches Slack or the prompt. */
const FAILURE_CODE_RE = /^[a-z0-9_.-]{1,64}$/i;

function failureCode(value: unknown): string | null {
  const code = nonEmpty(value);
  return code && FAILURE_CODE_RE.test(code) ? code : null;
}

function failureCodeOf(json: Record<string, unknown>): string | null {
  const details = asRecord(json.status_details);
  const payment = asRecord(json.payment_status_details);
  const declined = payment?.outcome === "failure";
  return (
    failureCode(asRecord(details?.failed)?.code) ??
    (declined ? failureCode(payment?.decline_code) ?? failureCode(payment?.code) : null) ??
    failureCode(asRecord(details?.requires_action)?.failure_code)
  );
}

function extractApprovalUrl(json: Record<string, unknown>): string | null {
  for (const key of ["approval_url", "approval_link", "approvalUrl"]) {
    const value = json[key];
    if (typeof value === "string") {
      const url = value.trim();
      if (/^https?:\/\//i.test(url)) return url;
    }
  }
  return null;
}

function extractSharedPaymentToken(json: Record<string, unknown>): string | null {
  const token = json.shared_payment_token ?? json.sharedPaymentToken;
  if (typeof token === "string" && token.startsWith("spt_")) return token;
  const rec = asRecord(token);
  if (!rec) return null;
  const id = rec.id ?? rec.token;
  return typeof id === "string" && id.startsWith("spt_") ? id : null;
}

function snapshotFromSpendRecord(
  json: Record<string, unknown>
): SpendRequestSnapshot | null {
  const id = typeof json.id === "string" ? json.id.trim() : "";
  if (!id) return null;
  const status = spendRequestStatus(
    typeof json.status === "string" ? json.status : ""
  );
  const next = nextActionOf(json, status);
  return {
    id,
    status,
    displayMessage: next?.displayMessage ?? nonEmpty(json.display_message),
    resolution: next?.resolution ?? null,
    actionType: next?.type ?? null,
    actionUrl: next?.actionUrl ?? null,
    failureCode: failureCodeOf(json),
    sharedPaymentToken: extractSharedPaymentToken(json),
    approvalUrl: extractApprovalUrl(json),
  };
}

/** Link's own `next_action` replaces what the plain retrieve parsed. */
function withNextAction(
  snap: SpendRequestSnapshot,
  next: SpendRequestNextAction
): SpendRequestSnapshot {
  return {
    ...snap,
    resolution: next.resolution ?? snap.resolution,
    actionType: next.type ?? snap.actionType,
    displayMessage: next.displayMessage ?? snap.displayMessage,
    actionUrl: next.actionUrl ?? snap.actionUrl,
  };
}

/**
 * `spend-request retrieve <id> --next-action` (link-cli 1.2+): one snapshot of
 * the request's current action, or null. Never polls or returns credentials.
 */
export async function retrieveLinkSpendRequestNextAction(
  deps: CliDeps,
  spendRequestId: string
): Promise<SpendRequestNextAction | null> {
  const result = await runLinkCli(deps, [
    "spend-request",
    "retrieve",
    spendRequestId,
    "--next-action",
    "--format",
    "json",
  ]);
  if (!result.ok) return null;
  const json = parseLinkJson(result.stdout);
  return parseNextAction(json?.next_action);
}

export function parseSpendRequestJson(stdout: string): SpendRequestSnapshot | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  for (let i = records.length - 1; i >= 0; i--) {
    const json = asRecord(records[i]);
    if (!json) continue;
    const snap = snapshotFromSpendRecord(json);
    if (snap) return snap;
  }
  return null;
}

/**
 * Link only issues a token when the spend request's mode matches the network
 * profile's, so a `profile_test_` id from a `sk_test_` server means test mode.
 * `CLEANSLOP_LINK_TEST=1` (exact) stays as a hidden override.
 */
export function linkSpendRequestTestMode(deps: CliDeps, networkId: string): boolean {
  return (
    deps.env.get("CLEANSLOP_LINK_TEST")?.trim() === "1" ||
    networkId.startsWith("profile_test_")
  );
}

export function isLinkSpendRequestNotFound(result: GitResult): boolean {
  const text = `${result.stderr} ${result.stdout}`;
  if (/\bNOT_FOUND\b/.test(text)) return true;
  return /spend request \S+ not found/i.test(text);
}

function spendRequestsFromListJson(stdout: string): SpendRequestSnapshot[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const rec = asRecord(parsed);
  const records = Array.isArray(parsed)
    ? parsed
    : Array.isArray(rec?.data)
      ? rec.data
      : [parsed];
  const out: SpendRequestSnapshot[] = [];
  for (const item of records) {
    const snap = snapshotFromSpendRecord(asRecord(item) ?? {});
    if (snap) out.push(snap);
  }
  return out;
}

async function retrieveLinkSpendRequestFromList(
  deps: CliDeps,
  spendRequestId: string
): Promise<SpendRequestSnapshot | null> {
  const result = await runLinkCli(deps, [
    "spend-request",
    "list",
    "--include-history",
    "--format",
    "json",
  ]);
  if (!result.ok) return null;
  return (
    spendRequestsFromListJson(result.stdout).find((row) => row.id === spendRequestId) ??
    null
  );
}

export async function createLinkSpendRequest(
  deps: CliDeps,
  input: {
    networkId: string;
    amount: number;
    currency: string;
    context: string;
    lineItem: string;
    total: string;
    idempotencyKey: string;
    testMode: boolean;
    /** Monthly plan: a recurring spend request (link-cli 0.29+). */
    recurringInterval?: "month";
    /** ISO 8601 ending in `Z`, at least 3 hours ahead. Omitted: Link's default (7 days one-time). */
    expiresAt?: string;
  }
): Promise<SpendRequestSnapshot> {
  const create = (expiresAt: string | undefined, idempotencyKey: string) =>
    runLinkCli(deps, [
      "spend-request",
      "create",
      "--credential-type",
      "shared_payment_token",
      "--network-id",
      input.networkId,
      "--amount",
      String(input.amount),
      "--currency",
      input.currency,
      "--context",
      input.context,
      "--line-item",
      input.lineItem,
      "--total",
      input.total,
      "--idempotency-key",
      idempotencyKey,
      ...(input.recurringInterval ? ["--recurring-interval", input.recurringInterval] : []),
      ...(expiresAt ? ["--expires-at", expiresAt] : []),
      "--request-approval",
      ...(input.testMode ? ["--test"] : []),
      "--format",
      "json",
    ]);
  let result = await create(input.expiresAt, input.idempotencyKey);
  // The expiry is only a tighter limit: if Link refuses it (a country limit,
  // clock skew), create once more with Link's default rather than fail the purchase.
  if (!result.ok && input.expiresAt && isExpiryRejected(result)) {
    result = await create(undefined, `${input.idempotencyKey}-default-expiry`);
  }
  if (!result.ok) {
    throwLinkCliFailure(result, "Could not create a Link spend request.");
  }
  const parsed = parseSpendRequestJson(result.stdout);
  if (!parsed) {
    throw new CliError(
      "link-cli did not return a spend request id.",
      EXIT_UNEXPECTED
    );
  }
  return parsed;
}

/**
 * Called when Link refuses a call for a missing scope. Resolves true after
 * fixing the session (the call is retried once), false to fail as is.
 */
export type OnMissingScope = () => Promise<boolean>;

export async function retrieveLinkSpendRequest(
  deps: CliDeps,
  spendRequestId: string,
  opts: { includeSpt?: boolean; testMode?: boolean; onMissingScope?: OnMissingScope } = {}
): Promise<SpendRequestSnapshot> {
  const args = ["spend-request", "retrieve", spendRequestId, "--format", "json"];
  if (opts.includeSpt) {
    args.push("--include", "shared_payment_token");
  }
  let result = await runLinkCli(deps, args);
  if (
    !result.ok &&
    opts.onMissingScope &&
    MISSING_SCOPE_PATTERN.test(`${result.stderr} ${result.stdout}`) &&
    (await opts.onMissingScope())
  ) {
    result = await runLinkCli(deps, args);
  }
  if (result.ok) {
    const parsed = parseSpendRequestJson(result.stdout);
    if (!parsed) {
      throw new CliError(
        "link-cli spend-request retrieve returned invalid JSON.",
        EXIT_UNEXPECTED
      );
    }
    return withCurrentAction(deps, parsed);
  }
  // link-cli 0.27 create --test writes a test-mode id; retrieve has no --test
  // and 404s in live. List still sees the request.
  if (opts.testMode && isLinkSpendRequestNotFound(result)) {
    const fromList = await retrieveLinkSpendRequestFromList(deps, spendRequestId);
    // `list` takes no --include, so it may never carry the token. Fail here
    // rather than retrying a token that cannot arrive.
    if (
      fromList &&
      opts.includeSpt &&
      fromList.status === "approved" &&
      !fromList.sharedPaymentToken
    ) {
      throw new CliError(
        "Link test mode approved the spend request, but link-cli cannot return its payment token (retrieve 404s and list has no token).",
        EXIT_UNEXPECTED
      );
    }
    // `list` rows often carry no action details.
    if (fromList) return withCurrentAction(deps, fromList);
  }
  throwLinkCliFailure(result, "Could not retrieve the Link spend request.");
}

/**
 * On `requires_action` / `failed`, asks `--next-action` for the current action.
 * A failure there keeps what the plain retrieve parsed.
 */
async function withCurrentAction(
  deps: CliDeps,
  snap: SpendRequestSnapshot
): Promise<SpendRequestSnapshot> {
  if (snap.status !== "requires_action" && snap.status !== "failed") return snap;
  const next = await retrieveLinkSpendRequestNextAction(deps, snap.id).catch(() => null);
  return next ? withNextAction(snap, next) : snap;
}

export async function retrieveSharedPaymentToken(
  deps: CliDeps,
  spendRequestId: string,
  opts: { testMode?: boolean; onMissingScope?: OnMissingScope } = {}
): Promise<string | null> {
  for (const delayMs of SPT_RETRIEVAL_DELAYS_MS) {
    if (delayMs > 0) await deps.clock.sleep(delayMs);
    const snap = await retrieveLinkSpendRequest(deps, spendRequestId, {
      includeSpt: true,
      ...opts,
    });
    if (snap.sharedPaymentToken) return snap.sharedPaymentToken;
  }
  return null;
}

/** How long an auto-approved test request may take to read as approved. */
export const AUTO_APPROVE_WAIT_MS = 30_000;

/**
 * Hidden team override for test mode: `CLEANSLOP_LINK_AUTO_APPROVE=1` (exact)
 * approves a test-mode spend request right after it is created, through
 * link-cli's `test-helpers spend-request approve`, so packs and plans run end
 * to end without the Link app. Never touches live requests. A failure only
 * warns; the normal approval wait follows.
 */
export async function autoApproveTestSpendRequest(
  deps: CliDeps,
  spendRequestId: string,
  testMode: boolean
): Promise<boolean> {
  if (!testMode || deps.env.get("CLEANSLOP_LINK_AUTO_APPROVE")?.trim() !== "1") return false;
  const result = await runLinkCli(
    deps,
    ["test-helpers", "spend-request", "approve", spendRequestId, "--format", "json"],
    { env: { LINK_TEST_HELPERS: "1" } }
  );
  if (result.ok) return true;
  const detail = redactSecrets((result.stderr || result.stdout || "").trim());
  deps.io.stderr(
    `CLEANSLOP_LINK_AUTO_APPROVE: Link test helper did not approve ${spendRequestId}${detail ? ` (${detail})` : ""}.\n`
  );
  return false;
}

/** Terms ride along only once the human agreed to them (a new account). */
export function linkSignupBody(
  deps: CliDeps,
  acceptTerms: string | null,
  consentSource: LinkConsentSource | null
): {
  client: string;
  agentHint: string;
  hostHint: string;
  acceptTerms?: string;
  consentSource?: LinkConsentSource;
} {
  return {
    client: CLIENT_ID,
    agentHint: detectAgentHint(deps.env),
    hostHint: deps.env.hostname().slice(0, 64),
    ...(acceptTerms ? { acceptTerms } : {}),
    ...(consentSource ? { consentSource } : {}),
  };
}
