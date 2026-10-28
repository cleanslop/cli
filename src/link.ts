import { writeAction } from "./action.js";
import {
  CLIENT_ID,
  LINK_CLI_NPX_TIMEOUT_MS,
  LINK_CLI_PACKAGE,
  LINK_CLI_TIMEOUT_MS,
} from "./config.js";
import type { CliDeps, GitResult } from "./deps.js";
import { doneQuestion, RERUN_SAME_COMMAND, RESUME_SAME_COMMAND } from "./done-question.js";
import {
  actionError,
  CliError,
  EXIT_ACTION,
  EXIT_UNEXPECTED,
  usageError,
  type ActionQuestion,
  type ActionRequired,
} from "./exit.js";
import { detectAgentHint } from "./git.js";
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
 * link-cli 0.27 defaults to `userinfo:read payment_methods.agentic` when
 * `--scope` is omitted. Login must pass a non-empty non-payment scope.
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

function linkEnv(deps: CliDeps): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LINK_IDENTITY_COMMANDS: "1",
    // link-cli's postinstall otherwise adds Stripe's payment skill to the
    // person's agent setup when the npx fallback installs it.
    LINK_CLI_SKIP_SKILL_INSTALL: "1",
    PATH: deps.env.get("PATH") ?? process.env.PATH ?? "",
  };
}

type LinkCliCommand = { file: string; prefix: string[] };

const PATH_LINK_CLI: LinkCliCommand = { file: "link-cli", prefix: [] };
const NPX_LINK_CLI: LinkCliCommand = {
  file: "npx",
  prefix: ["--yes", "--package", LINK_CLI_PACKAGE, "--", "link-cli"],
};

/** Per-run choice between `link-cli` on PATH and the pinned npx copy. */
const resolvedLinkCli = new WeakMap<CliDeps, LinkCliCommand>();

function execLinkCli(
  deps: CliDeps,
  cmd: LinkCliCommand,
  args: string[],
  timeout: number
): Promise<GitResult> {
  return deps.execFile(cmd.file, [...cmd.prefix, ...args], {
    // The first npx run downloads link-cli and its dependencies.
    timeout: cmd === NPX_LINK_CLI ? Math.max(timeout, LINK_CLI_NPX_TIMEOUT_MS) : timeout,
    env: linkEnv(deps),
  });
}

/**
 * `CLEANSLOP_LINK_CLI`, else `link-cli` on PATH, else the pinned
 * `@stripe/link-cli` through npx, so `npx @cleanslop/cli` needs nothing else
 * installed.
 */
export async function runLinkCli(
  deps: CliDeps,
  args: string[],
  opts: { timeout?: number } = {}
): Promise<GitResult> {
  const timeout = opts.timeout ?? LINK_CLI_TIMEOUT_MS;
  const override = deps.env.get("CLEANSLOP_LINK_CLI")?.trim();
  if (override) {
    return execLinkCli(deps, { file: override, prefix: [] }, args, timeout);
  }
  const known = resolvedLinkCli.get(deps);
  if (known) return execLinkCli(deps, known, args, timeout);
  const onPath = await execLinkCli(deps, PATH_LINK_CLI, args, timeout);
  if (onPath.code !== 127) {
    resolvedLinkCli.set(deps, PATH_LINK_CLI);
    return onPath;
  }
  resolvedLinkCli.set(deps, NPX_LINK_CLI);
  return execLinkCli(deps, NPX_LINK_CLI, args, timeout);
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
  | "unknown";

export type SpendRequestSnapshot = {
  id: string;
  status: SpendRequestStatus;
  displayMessage: string | null;
  resolution: string | null;
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
    case "denied":
    case "expired":
    case "requires_action":
    case "canceled":
      return raw;
    default:
      return "unknown";
  }
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
  const next = asRecord(json.next_action);
  const resolutionRaw = next?.resolution;
  const resolution =
    typeof resolutionRaw === "string"
      ? resolutionRaw
      : typeof asRecord(resolutionRaw)?.type === "string"
        ? String(asRecord(resolutionRaw)?.type)
        : null;
  const displayMessage =
    (typeof next?.display_message === "string" && next.display_message) ||
    (typeof json.display_message === "string" && json.display_message) ||
    null;
  return {
    id,
    status,
    displayMessage,
    resolution,
    sharedPaymentToken: extractSharedPaymentToken(json),
    approvalUrl: extractApprovalUrl(json),
  };
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
  }
): Promise<SpendRequestSnapshot> {
  const result = await runLinkCli(deps, [
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
    input.idempotencyKey,
    ...(input.recurringInterval ? ["--recurring-interval", input.recurringInterval] : []),
    "--request-approval",
    ...(input.testMode ? ["--test"] : []),
    "--format",
    "json",
  ]);
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
    return parsed;
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
    if (fromList) return fromList;
  }
  throwLinkCliFailure(result, "Could not retrieve the Link spend request.");
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
