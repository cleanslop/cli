import { USER_AGENT } from "./config.js";
import type { CliDeps, HttpResult } from "./deps.js";
import {
  actionError,
  CliError,
  EXIT_ACTION,
  EXIT_PAYMENT,
  EXIT_POLICY,
  EXIT_RUNNING,
  EXIT_SCAN_FAILED,
  EXIT_SOURCE,
  EXIT_UNEXPECTED,
  EXIT_USAGE,
  type ActionKind,
  type ActionQuestion,
  type ActionQuestionOption,
  type ActionRequired,
} from "./exit.js";
import { doneQuestion, RERUN_SAME_COMMAND } from "./done-question.js";
import { pushFirstQuestion } from "./git.js";
import {
  promoOffered,
  topUpQuestion,
  monthlyPlanOffered,
  webBillingQuestion,
  withWebBillingOption,
} from "./top-up.js";
import type { AgentErrorBody } from "./types.js";

export function hasIdentityPresentationChallenge(result: HttpResult): boolean {
  if (result.status !== 401) return false;
  const body = asErrorBody(result.json);
  if (body.error === "identity_presentation_required") return true;
  const www = result.headers.get("www-authenticate") ?? "";
  return /identity-presentation/i.test(www);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function asErrorBody(value: unknown): AgentErrorBody {
  return (asRecord(value) ?? {}) as AgentErrorBody;
}

export async function httpRequest(
  deps: CliDeps,
  origin: string,
  method: string,
  path: string,
  opts: {
    token?: string;
    body?: unknown;
    rawBody?: Uint8Array;
    headers?: Record<string, string>;
    accept?: string;
    contentType?: string;
  } = {}
): Promise<HttpResult> {
  const url = `${origin}${path}`;
  const headers = new Headers(opts.headers);
  headers.set("User-Agent", USER_AGENT);
  headers.set("Accept", opts.accept ?? "application/json");
  if (opts.token) {
    headers.set("Authorization", `Bearer ${opts.token}`);
  }
  if (opts.rawBody) {
    headers.set("Content-Type", opts.contentType ?? "application/octet-stream");
  } else if (opts.body !== undefined) {
    headers.set("Content-Type", opts.contentType ?? "application/json");
  }
  const init: RequestInit = {
    method,
    headers,
    redirect: "manual",
  };
  if (opts.rawBody) {
    init.body = Buffer.from(opts.rawBody) as RequestInit["body"];
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  let response: Response;
  try {
    response = await deps.request(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(`Network error: ${message}`, EXIT_UNEXPECTED);
  }
  const text = await response.text();
  let json: unknown | null = null;
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    json,
  };
}

function actionFromBody(
  body: AgentErrorBody,
  fallback: ActionKind
): ActionRequired {
  const kind = mapActionKind(body.action?.kind, fallback);
  return {
    kind,
    humanPrompt:
      body.action?.humanPrompt ??
      body.message ??
      body.error_description ??
      body.error ??
      "A human action is required.",
    url: body.action?.url,
  };
}

/** Without Link packs (`credits.ts` handles those), offer checkout or a promo code. */
function outOfScansAction(body: AgentErrorBody, json: unknown): ActionRequired {
  const action = actionFromBody(body, "top-up");
  const web = monthlyPlanOffered(json);
  if (!promoOffered(json)) {
    if (!action.url) {
      if (!web) return action;
      return {
        ...action,
        question: webBillingQuestion(
          null,
          web,
          web === "link"
            ? "This account is out of scans. Start a monthly CleanSlop plan paid with Link?"
            : "This account is out of scans. Subscribe to a monthly plan on the CleanSlop website?"
        ),
      };
    }
    const question = doneQuestion({
      id: "web_checkout",
      header: "Add scans",
      question: `Buy scans at ${action.url}. Done?`,
      then: { next: "rerun the scan" },
      notNow: "Buy nothing",
    });
    return { ...action, question };
  }
  const checkout: ActionQuestionOption | null = action.url
    ? {
        value: "checkout",
        label: "Buy on the web",
        description: "Pay in the browser",
        next: "give the human the URL above, then rerun the scan after they pay",
      }
    : null;
  return { ...action, question: withWebBillingOption(topUpQuestion(checkout), web) };
}

/** The human does `what` at the action's link, then the agent reruns. No link, nothing to ask. */
function doneAtUrl(
  action: ActionRequired,
  id: string,
  header: string,
  what: string
): ActionRequired {
  if (!action.url) return action;
  return {
    ...action,
    question: doneQuestion({
      id,
      header,
      question: `${what} at ${action.url}. Done?`,
      then: { next: RERUN_SAME_COMMAND },
    }),
  };
}

function installAction(body: AgentErrorBody): ActionRequired {
  return doneAtUrl(
    actionFromBody(body, "install"),
    "github_install",
    "Install",
    "Install the CleanSlop GitHub App for this repository"
  );
}

/** The Link email already has an account: connect Link to it through GitHub, or stop. */
const LINK_EXISTING_QUESTION: ActionQuestion = {
  id: "link_existing",
  header: "Connect",
  question:
    "This Link email already has a CleanSlop account. Connect Link to it by signing in with GitHub?",
  options: [
    {
      value: "github",
      label: "Sign in with GitHub",
      description: "Then connect Link to that account",
      next: "run `cleanslop login --no-wait` and finish its approval, then run `cleanslop link-identity --no-wait`",
    },
    { value: "stop", label: "Not now", description: "Stop here" },
  ],
};

function mapActionKind(raw: string | undefined, fallback: ActionKind): ActionKind {
  switch (raw) {
    case "approve":
    case "install":
    case "top-up":
    case "beta":
    case "reauth":
    case "present_identity":
    case "link_existing":
    case "ask_human":
    case "ask_email":
    case "wait":
      return raw;
    case "open_url":
      return fallback;
    default:
      return fallback;
  }
}

export function throwHttpError(result: HttpResult): never {
  const body = asErrorBody(result.json);
  const code = body.error ?? "";
  const message =
    body.message ?? body.error_description ?? code ?? `HTTP ${result.status}`;

  if (hasIdentityPresentationChallenge(result)) {
    throw new CliError(
      message,
      EXIT_ACTION,
      actionFromBody(body, "present_identity")
    );
  }

  switch (code) {
    case "authorization_pending":
    case "slow_down":
      throw new CliError(message, EXIT_ACTION);
    case "access_denied":
    case "expired_token":
    case "invalid_grant":
      throw actionError(message, {
        kind: "approve",
        humanPrompt: message,
      });
    case "out_of_scans":
      throw new CliError(message, EXIT_PAYMENT, outOfScansAction(body, result.json));
    case "repo_not_connected":
      throw new CliError(message, EXIT_ACTION, installAction(body));
    case "github_reauth_required":
      throw new CliError(
        message,
        EXIT_ACTION,
        doneAtUrl(actionFromBody(body, "reauth"), "github_reconnect", "Reconnect", "Reconnect GitHub")
      );
    case "token_revoked":
    case "token_expired":
    case "invalid_token":
      throw new CliError(message, EXIT_ACTION, actionFromBody(body, "reauth"));
    case "account_exists":
      throw new CliError(message, EXIT_ACTION, {
        ...actionFromBody(body, "link_existing"),
        question: LINK_EXISTING_QUESTION,
      });
    case "link_pilot_required":
    case "terms_required":
    case "link_email_unverified":
    case "link_email_mismatch":
    case "link_email_in_use":
    case "uploads_unavailable":
    case "upload_quota":
    case "promo_invalid":
    case "promo_already_redeemed":
      throw new CliError(message, EXIT_POLICY, actionFromBody(body, "ask_human"));
    case "link_unavailable":
      throw new CliError(message, EXIT_UNEXPECTED);
    case "beta_required":
      throw new CliError(message, EXIT_POLICY, actionFromBody(body, "beta"));
    case "waitlisted":
    case "incomplete":
    case "agent_daily_cap":
    case "insufficient_scope":
      throw new CliError(message, EXIT_POLICY, actionFromBody(body, "ask_human"));
    case "commit_not_on_github":
      throw new CliError(message, EXIT_SOURCE, {
        ...actionFromBody(body, "ask_human"),
        question: pushFirstQuestion(),
      });
    case "unsupported_remote":
      throw new CliError(message, EXIT_SOURCE, actionFromBody(body, "ask_human"));
    case "scan_failed":
      throw new CliError(
        message,
        EXIT_SCAN_FAILED,
        actionFromBody(body, "ask_human")
      );
    case "rate_limited":
    case "capacity":
      throw new CliError(message, EXIT_RUNNING, actionFromBody(body, "wait"));
    case "github_unavailable":
      throw new CliError(message, EXIT_UNEXPECTED, actionFromBody(body, "wait"));
    case "training_decision_required":
      throw new CliError(
        message,
        EXIT_ACTION,
        doneAtUrl(
          actionFromBody(body, "ask_human"),
          "training_default",
          "Training",
          "Choose a training default for undecided repos"
        )
      );
    case "report_not_ready":
    case "scan_in_progress":
      throw new CliError(message, EXIT_RUNNING, actionFromBody(body, "wait"));
    case "cli_outdated":
      // The message names the npx command that fetches the current version.
      throw new CliError(message, EXIT_USAGE);
    case "invalid_request":
    case "invalid_client":
    case "unsupported_grant_type":
    case "prompt_must_quote_recipient":
      throw new CliError(message, EXIT_USAGE);
    case "no_verified_email":
    case "done_alerts_disabled":
    case "already_sent":
    case "too_late":
      throw new CliError(message, EXIT_POLICY, actionFromBody(body, "ask_human"));
    default:
      break;
  }

  if (result.status === 401) {
    const www = result.headers.get("www-authenticate") ?? "";
    if (/identity-presentation/i.test(www)) {
      throw new CliError(
        message,
        EXIT_ACTION,
        actionFromBody(body, "present_identity")
      );
    }
    throw new CliError(message, EXIT_ACTION, actionFromBody(body, "reauth"));
  }
  if (result.status === 402) {
    throw new CliError(message, EXIT_PAYMENT, actionFromBody(body, "top-up"));
  }
  if (result.status === 403) {
    throw new CliError(message, EXIT_POLICY, actionFromBody(body, "ask_human"));
  }
  throw new CliError(message || `HTTP ${result.status}`, EXIT_UNEXPECTED);
}

export function requireOk(result: HttpResult): HttpResult {
  if (result.status >= 200 && result.status < 300) return result;
  throwHttpError(result);
}

export function retryAfterMs(result: HttpResult, fallback: number): number {
  const header = result.headers.get("retry-after");
  if (header) {
    const sec = Number(header);
    if (Number.isFinite(sec) && sec >= 0) return Math.max(sec * 1000, fallback);
  }
  const body = asErrorBody(result.json);
  const retry = body.action?.retryAfterSec;
  if (typeof retry === "number" && retry >= 0) {
    return Math.max(retry * 1000, fallback);
  }
  return fallback;
}
