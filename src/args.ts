import { DEFAULT_WAIT_MS } from "./config.js";
import { usageError } from "./exit.js";
import type { CommandName, ParsedArgs, ReportFormat } from "./types.js";

const COMMANDS: readonly CommandName[] = [
  "scan",
  "login",
  "logout",
  "whoami",
  "status",
  "report",
  "setup",
  "email",
  "link-identity",
  "credits",
  "redeem",
  "billing",
  "plan",
  "feedback",
];

export const FEEDBACK_KINDS = ["bug", "confusing", "false_positive", "idea", "other"] as const;

function isCommand(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

export function parseWaitMs(
  raw: string,
  fallback = DEFAULT_WAIT_MS
): number {
  const match = /^(\d+)([smh])?$/i.exec(raw.trim());
  if (!match) {
    throw usageError(`Invalid --wait duration: ${raw} (use 8m, 75m, 30s, 1h)`);
  }
  const n = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  if (unit === "m") return n * 60 * 1000;
  if (unit === "h") return n * 60 * 60 * 1000;
  return n * 1000;
}

function emptyArgs(defaultWaitMs: number): ParsedArgs {
  return {
    command: "scan",
    help: false,
    version: false,
    id: null,
    json: false,
    wait: false,
    waitMs: defaultWaitMs,
    noWait: false,
    noPromo: false,
    resume: false,
    force: false,
    upload: false,
    preview: false,
    format: "md",
    dryRun: false,
    uninstall: false,
    all: false,
    project: false,
    yes: false,
    consent: null,
    reply: null,
    link: false,
    agree: false,
    acceptTerms: false,
    yesShareEmail: false,
    pack: null,
    amount: null,
    networkId: null,
    spendRequestId: null,
    feedbackKind: null,
    scanId: null,
    findingId: null,
    newTicket: false,
    replies: false,
  };
}

export function parseArgs(
  argv: string[],
  defaultWaitMs = DEFAULT_WAIT_MS
): ParsedArgs {
  const out = emptyArgs(defaultWaitMs);
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-") && isCommand(rest[0])) {
    out.command = rest.shift() as CommandName;
  }

  while (rest.length > 0) {
    const token = rest.shift()!;
    switch (token) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "-v":
      case "--version":
        out.version = true;
        break;
      case "--json":
        out.json = true;
        out.format = "json";
        break;
      case "--no-wait":
        out.noWait = true;
        break;
      case "--resume":
        out.resume = true;
        break;
      case "--no-promo":
        out.noPromo = true;
        break;
      case "--force":
        out.force = true;
        break;
      case "--upload":
        out.upload = true;
        break;
      case "--preview":
        out.preview = true;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--uninstall":
        out.uninstall = true;
        break;
      case "--all":
        out.all = true;
        break;
      case "--project":
        out.project = true;
        break;
      case "--yes":
      case "-y":
        out.yes = true;
        break;
      case "--link":
        out.link = true;
        break;
      case "--agree":
        out.agree = true;
        break;
      case "--accept-terms":
        out.acceptTerms = true;
        break;
      case "--yes-share-email":
        out.yesShareEmail = true;
        break;
      case "--pack": {
        const next = rest.shift();
        if (next !== "p5" && next !== "p15" && next !== "p40") {
          throw usageError("--pack must be p5, p15, or p40");
        }
        out.pack = next;
        break;
      }
      case "--amount": {
        const next = rest.shift();
        if (!next || !/^\d+$/.test(next) || Number(next) < 1) {
          throw usageError("--amount must be a positive integer in cents");
        }
        out.amount = Number(next);
        break;
      }
      case "--network-id": {
        const next = rest.shift();
        if (!next) throw usageError("--network-id requires a Stripe profile id");
        out.networkId = next;
        break;
      }
      case "--kind": {
        const next = rest.shift();
        if (!next || !(FEEDBACK_KINDS as readonly string[]).includes(next)) {
          throw usageError(`--kind must be one of ${FEEDBACK_KINDS.join(", ")}`);
        }
        out.feedbackKind = next;
        break;
      }
      case "--scan": {
        const next = rest.shift();
        if (!next) throw usageError("--scan requires a scan id");
        out.scanId = next;
        break;
      }
      case "--finding": {
        const next = rest.shift();
        if (!next) throw usageError("--finding requires a finding id (fp1_…)");
        out.findingId = next;
        break;
      }
      case "--new":
        out.newTicket = true;
        break;
      case "--replies":
        out.replies = true;
        break;
      case "--spend-request-id": {
        const next = rest.shift();
        if (!next) throw usageError("--spend-request-id requires an id");
        out.spendRequestId = next;
        break;
      }
      case "--wait": {
        out.wait = true;
        const next = rest[0];
        if (next && !next.startsWith("-") && /^\d/.test(next)) {
          out.waitMs = parseWaitMs(rest.shift()!, defaultWaitMs);
        }
        break;
      }
      case "--format": {
        const next = rest.shift();
        if (next !== "md" && next !== "json") {
          throw usageError("--format must be md or json");
        }
        out.format = next as ReportFormat;
        if (next === "json") out.json = true;
        break;
      }
      case "--consent": {
        const next = rest.shift();
        if (!next) throw usageError("--consent requires the exact question text");
        out.consent = next;
        break;
      }
      case "--reply": {
        const next = rest.shift();
        if (!next) throw usageError("--reply requires the human reply text");
        out.reply = next;
        break;
      }
      default:
        if (token.startsWith("-")) {
          throw usageError(`Unknown flag: ${token}`);
        }
        if (out.id) {
          throw usageError(`Unexpected extra argument: ${token}`);
        }
        out.id = token;
        break;
    }
  }

  return out;
}

export const HELP_TEXT = `cleanslop — CleanSlop agent CLI

Usage:
  cleanslop [scan] [--wait [duration]] [--json] [--force] [--preview] [--upload]
  cleanslop login [--link] [--agree] [--no-wait | --resume]
  cleanslop link-identity [--no-wait | --resume]
  cleanslop credits buy --link [--pack p5] [--no-promo] [--no-wait | --resume]
  cleanslop redeem <code>
  cleanslop billing
  cleanslop plan [starter|pro|max] [--no-wait | --resume]
  cleanslop logout [--all]
  cleanslop whoami
  cleanslop status [id] [--wait [duration]]
  cleanslop report [id] [--format md|json] [--preview]
  cleanslop email <id> --consent "<exact question>" [--reply "<human reply>"]
  cleanslop setup [--dry-run] [--uninstall] [--project] [--yes]
  cleanslop feedback "<message>" [--kind bug|confusing|false_positive|idea|other]
                     [--scan <id>] [--finding <fp1_…>] [--new]
  cleanslop feedback --replies

scan is the default command. GitHub App repos, or a packed upload when /me
reports uploads:true (Link). With uploadFallback:true (GitHub), a folder not
on GitHub asks whether to upload its files, and a dirty or unpushed checkout
asks whether to upload them or push first. --dry-run on scan lists the upload pack.

billing (Link accounts): prints where the human manages the plan and credits
on the web and the masked email to enter there, then exits 10 to relay it.

feedback: sends the human's words to the CleanSlop team (ask first; no code,
file contents, secrets or paths). --replies shows answers from the team.

plan (Link accounts): starts a monthly plan paid each month from a recurring
Link approval. Without a plan name it asks which one. When CleanSlop offers no
Link plans, it does what billing does.

Wait:
  --wait           poll until final or the budget (default 8 minutes)
  --wait 75m       Claude Code background budget (hours/minutes/seconds: 1h, 75m, 30s)
  At the deadline: exit 75 and print a resume command. The scan keeps running.

Flags:
  --json           one JSON document on stdout
  --force          skip same-commit dedupe (sends Idempotency-Key)
  --preview        first-pass report before judgment is final
  --upload         scan: upload the local files instead of the pushed commit (after the human picks it)
  --no-wait        login / link-identity / credits buy / plan: print what to approve and exit 10
  --resume         login / link-identity / credits buy / plan: continue a pending --no-wait approval
  --link           login: Stripe Link sign-up / sign-in (requires link-cli)
  --agree          login --link: pass only after the human answers yes to the quoted terms question
                   (--accept-terms --yes-share-email together still work)
  --pack           credits buy: p5, p15, or p40. Required without a terminal (the human picks); a terminal defaults to p5. Price and network id come from CleanSlop.
  --no-promo       credits buy: skip the promo-code choice (the human already chose to buy)
  --all            logout: revoke every saved token and delete all local CleanSlop data
                   (without it, logout signs out of this origin and drops its pending login and Link payment)
  --dry-run        setup: print the plan. scan (upload): list the pack, upload nothing
  --uninstall      setup: remove marker blocks / skill files
  --project        setup: project files instead of user scope
  --yes            setup: write in a non-TTY (otherwise non-TTY is a plan only)
  --consent        email: the exact masked-recipient question you asked
  --reply          email: optional verbatim human reply
  --kind           feedback: what it is about (default other)
  --scan           feedback: the scan it is about
  --finding        feedback: a finding id from that scan's report (false_positive)
  --new            feedback: start a new conversation instead of adding to the last
  --replies        feedback: show replies from the CleanSlop team

Env:
  CLEANSLOP_ORIGIN   API origin (default https://cleanslop.com)
  CLEANSLOP_TOKEN    bearer token override (never printed)
  CLEANSLOP_LINK_CLI path to link-cli (default: link-cli on PATH)

Credentials: $XDG_CONFIG_HOME/cleanslop/credentials.json or ~/.config/cleanslop/
Directory 0700, file 0600. Never stored inside the git worktree.

Exit codes: 0 ok · 1 unexpected · 2 usage · 10 human action · 11 payment
  12 policy · 13 source · 20 scan failed · 75 still running

Never open, approve, or pay yourself. Relay CLEANSLOP_ACTION_REQUIRED blocks.
Ask a CLEANSLOP_QUESTION with your multiple-choice question tool when you have
one (never ask the human to type "Done"), using exactly its options. Never
answer for the human.
`;
