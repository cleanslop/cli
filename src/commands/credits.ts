import { writeAction } from "../action.js";
import type { CliDeps, HttpResult } from "../deps.js";
import { doneQuestion } from "../done-question.js";
import { asRecord, httpRequest, requireOk } from "../http.js";
import {
  AUTO_APPROVE_WAIT_MS,
  autoApproveTestSpendRequest,
  createLinkSpendRequest,
  ensureLinkPaymentScope,
  grantLinkPayments,
  linkAuthMode,
  linkPaymentStep,
  linkSpendRequestTestMode,
  retrieveLinkSpendRequest,
  retrieveSharedPaymentToken,
  type LinkPaymentStep,
  type OnMissingScope,
  type SpendRequestSnapshot,
} from "../link.js";
import {
  deletePendingSpend,
  readPendingSpend,
  requireToken,
  resolveOrigin,
  writePendingSpend,
  type PendingSpendRequest,
  type SpendKind,
} from "../credentials.js";
import {
  type ActionQuestion,
  type ActionQuestionOption,
  actionError,
  CliError,
  EXIT_OK,
  EXIT_PAYMENT,
  usageError,
} from "../exit.js";
import {
  NOT_NOW,
  promoOffered,
  topUpQuestion,
  monthlyPlanOffered,
  webBillingQuestion,
  withPromoHint,
  withWebBillingHint,
  withWebBillingOption,
} from "../top-up.js";
import type { ParsedArgs } from "../types.js";

const CREDIT_PACKS = {
  p5: 5,
  p15: 15,
  p40: 40,
} as const;

type CreditPackId = keyof typeof CREDIT_PACKS;

function isCreditPackId(value: string | null): value is CreditPackId {
  return value === "p5" || value === "p15" || value === "p40";
}

function spendRequestContext(pack: CreditPackId, scans: number): string {
  const text = `CleanSlop ${scans} scan credits (pack ${pack}). Approve this Shared Payment Token so your coding agent can add credits to this CleanSlop account. This is a one-time charge for scan credits only.`;
  return text.length >= 100 ? text : text.padEnd(100, ".");
}

export type StripeSptOffer = {
  pack: CreditPackId;
  amount: number;
  currency: string;
  networkId: string;
  purchaseUrl: string;
  /** CleanSlop marks one pack as the best value. */
  best?: boolean;
};

/** Fixed Link approval budget. Auto-buy ignores `scan --wait`. */
export const LINK_APPROVAL_WAIT_MS = 10 * 60 * 1000;

/**
 * `--resume` budget. The human has usually approved already; anything longer
 * would outlast an agent's foreground shell call.
 */
export const LINK_RESUME_WAIT_MS = 60 * 1000;

const BUY_COMMAND = "cleanslop credits buy --link";

/**
 * How long to poll Link for approval. `--no-wait` checks once, `--resume`
 * polls briefly, and the default (a human at a terminal) waits 10 minutes.
 */
export function linkApprovalWaitMs(
  args: ParsedArgs,
  opts: { autoBuy?: boolean } = {}
): number {
  if (opts.autoBuy) return LINK_APPROVAL_WAIT_MS;
  switch (linkAuthMode(args)) {
    case "no-wait":
      return 0;
    case "resume":
      return LINK_RESUME_WAIT_MS;
    case "wait":
      return args.wait ? args.waitMs : LINK_APPROVAL_WAIT_MS;
  }
}

/**
 * What a saved Link spend request pays for: its pending file, the command
 * that resumes it, and what to say when Link turns it down.
 */
export type SpendFlow = {
  kind: SpendKind;
  /** Resume command without `--resume`, e.g. `cleanslop credits buy --link`. */
  command: string;
  /** What the human approves, e.g. `CleanSlop credit pack (p5)`. */
  what: string;
  /** Prompt and question after Link denied, expired or canceled the request. */
  restart: (status: string) => { humanPrompt: string; question: ActionQuestion };
  /** Starts a new spend request, e.g. `cleanslop credits buy --link --pack p5 --no-wait`. */
  newCommand: string;
  /** What to check once a payment turns out to be charged already. */
  checkPaid: string;
};

/** Link's minimum is 3 hours ahead; 5 minutes more covers clock skew. */
const PACK_SPEND_REQUEST_TTL_MS = 3 * 60 * 60_000 + 5 * 60_000;

/**
 * Credit packs are charged right after approval, so their spend request (and
 * its token) expires in about 3 hours instead of Link's 7-day default.
 * Monthly plans keep Link's default: renewals need the token.
 */
export function packSpendRequestExpiry(deps: CliDeps): string {
  return new Date(deps.clock.now() + PACK_SPEND_REQUEST_TTL_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Decimal places of a currency's minor unit: 2 for USD, 0 for JPY, 3 for KWD. */
function currencyMinorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** Minor units to a display price, e.g. `5.00 USD` or `500 JPY`. */
export function formatPackPrice(amount: number, currency: string): string {
  const digits = currencyMinorDigits(currency);
  return `${(amount / 10 ** digits).toFixed(digits)} ${currency.toUpperCase()}`;
}

/** `p15 (15 scans, 25.00 USD, 1.67 USD per scan, best value)`. */
export function describePackOffer(offer: StripeSptOffer): string {
  const scans = CREDIT_PACKS[offer.pack];
  const parts = [
    `${scans} scans`,
    formatPackPrice(offer.amount, offer.currency),
    `${formatPackPrice(Math.round(offer.amount / scans), offer.currency)} per scan`,
  ];
  if (offer.best) parts.push("best value");
  return `${offer.pack} (${parts.join(", ")})`;
}

const APPROVE_THEN_RESUME = `relay its approval prompt (Link notifies their Link app; there is usually no link), and after they approve run \`${BUY_COMMAND} --resume\`.`;

/** Asks the human to pick from every pack CleanSlop offers. */
function choosePackPrompt(offers: StripeSptOffer[], tail = ""): string {
  const list = new Intl.ListFormat("en", { type: "disjunction" }).format(
    offers.map(describePackOffer)
  );
  return `Ask the human which CleanSlop credit pack to buy with Link: ${list}. If they pick one, run \`${BUY_COMMAND} --pack <pack> --no-wait\`, ${APPROVE_THEN_RESUME}${tail}`;
}

function buyCommand(pack: string): string {
  return `${BUY_COMMAND} --pack ${pack} --no-wait`;
}

function packOption(offer: StripeSptOffer): ActionQuestionOption {
  const scans = CREDIT_PACKS[offer.pack];
  const perScan = formatPackPrice(Math.round(offer.amount / scans), offer.currency);
  return {
    value: offer.pack,
    label: `${scans} scans · ${formatPackPrice(offer.amount, offer.currency)}`,
    description: `${perScan} per scan${offer.best ? ", best value" : ""}`,
    run: buyCommand(offer.pack),
  };
}

/** What the human approves, in order: a one-time Link permission (or sign-in) first when Link needs it. */
export function approvalNote(step: LinkPaymentStep): string {
  switch (step) {
    case "sign-in":
      return "Link first asks you to sign in and allow CleanSlop to request Link payments (nothing is charged), then you approve the payment in your Link app.";
    case "permission":
      return "Link first asks you to allow CleanSlop to request Link payments (one time; nothing is charged), then you approve the payment in your Link app.";
    default:
      return "You approve the payment in your Link app.";
  }
}

/** The agent's prompt says it too, so the permission step is not relayed as the purchase. */
export function approvalPromptTail(step: LinkPaymentStep): string {
  return step === "approve" ? "" : ` Tell the human: ${approvalNote(step)}`;
}

/** Every offered pack plus "Not now": at most four options. */
function packQuestion(
  offers: StripeSptOffer[],
  step: LinkPaymentStep,
  lead = ""
): ActionQuestion {
  return {
    id: "link_credit_pack",
    header: "Credits",
    question: `${lead}Which CleanSlop credit pack should I buy with Link? ${approvalNote(step)}`,
    options: [...offers.map(packOption), NOT_NOW],
  };
}

/**
 * The "buy" answer beside a promo code: one named pack buys it; several run
 * `credits buy` again with `--no-promo` so it asks only which pack.
 */
function buyOption(offers: StripeSptOffer[]): ActionQuestionOption {
  const [only] = offers;
  if (offers.length === 1 && only) {
    return {
      value: only.pack,
      label: `Buy ${only.pack}`,
      description: describePackOffer(only),
      run: buyCommand(only.pack),
    };
  }
  return {
    value: "buy",
    label: "Buy with Link",
    description: offers.map(describePackOffer).join("; "),
    run: `${BUY_COMMAND} --no-promo --no-wait`,
  };
}

/** Yes/no for one pack the human or the CLI already named. */
function buyPackQuestion(
  id: string,
  question: string,
  pack: string,
  label = `Buy ${pack}`
): ActionQuestion {
  return {
    id,
    header: "Credits",
    question,
    options: [{ value: pack, label, run: buyCommand(pack) }, NOT_NOW],
  };
}

function purchaseUrlFor(origin: string): string {
  return `${origin}/api/agent/v1/credits/purchases`;
}

function asStripeSptOffer(value: unknown): StripeSptOffer | null {
  const rec = asRecord(value);
  if (!rec || rec.kind !== "stripe_spt") return null;
  const pack = typeof rec.pack === "string" ? rec.pack : "";
  if (!isCreditPackId(pack)) return null;
  const amount = typeof rec.amount === "number" ? rec.amount : Number(rec.amount);
  if (!Number.isInteger(amount) || amount < 1) return null;
  const networkId = typeof rec.networkId === "string" ? rec.networkId.trim() : "";
  const purchaseUrl = typeof rec.purchaseUrl === "string" ? rec.purchaseUrl.trim() : "";
  if (!networkId || !purchaseUrl) return null;
  return {
    pack,
    amount,
    currency:
      typeof rec.currency === "string" && rec.currency.trim()
        ? rec.currency.trim()
        : "usd",
    networkId,
    purchaseUrl,
    ...(rec.best === true ? { best: true } : {}),
  };
}

/** Every `stripe_spt` offer in a 402 `out_of_scans` body, in server order. */
export function stripeSptOffersFromErrorBody(json: unknown): StripeSptOffer[] {
  const payment = asRecord(asRecord(json)?.payment);
  const methods = Array.isArray(payment?.methods) ? payment.methods : [];
  return methods
    .map(asStripeSptOffer)
    .filter((offer): offer is StripeSptOffer => offer != null);
}

/** Read a matching `stripe_spt` offer from a 402 `out_of_scans` body. */
export function stripeSptOfferFromErrorBody(
  json: unknown,
  packHint: string | null
): StripeSptOffer | null {
  const offers = stripeSptOffersFromErrorBody(json);
  if (offers.length === 0) return null;
  const wanted = packHint && isCreditPackId(packHint) ? packHint : "p5";
  return offers.find((offer) => offer.pack === wanted) ?? offers[0] ?? null;
}

function packFlow(pack: string): SpendFlow {
  return {
    kind: "pack",
    command: BUY_COMMAND,
    what: `CleanSlop credit pack (${pack})`,
    newCommand: `${BUY_COMMAND} --pack ${pack} --no-wait`,
    checkPaid: "the scan balance with `cleanslop whoami`",
    restart: (status) => ({
      humanPrompt: `The Link payment was ${status}. Ask the person whether to try again; if yes, run \`${BUY_COMMAND} --pack ${pack} --no-wait\` for a new spend request.`,
      question: buyPackQuestion(
        "link_payment_retry",
        `The Link payment for ${pack} was ${status}. Try again with a new payment?`,
        pack,
        "Try again"
      ),
    }),
  };
}

export function tokenMissingAction(spendRequestId: string, command = BUY_COMMAND): never {
  throw actionError(
    "The Link payment token is not ready yet. Retry the same spend request.",
    {
      kind: "wait",
      humanPrompt: `The person already approved this payment in Link, but the token is not ready. Run \`${command} --resume\` — do not create a new spend request.`,
      code: spendRequestId,
    }
  );
}

async function persistPending(
  deps: CliDeps,
  pending: PendingSpendRequest,
  kind: SpendKind = "pack"
): Promise<void> {
  await writePendingSpend(deps, pending, kind);
}

type SpendRequestEvent =
  | "created"
  | "approved"
  | "denied"
  | "expired"
  | "canceled"
  | "requires_action"
  | "failed"
  | "token_missing";

/**
 * Tells the server (billing Slack) about a spend-request transition it cannot
 * see. Once per event per request; a network error or an older server that
 * 404s never blocks the purchase. Call before deleting the pending file.
 */
export async function reportSpendRequest(
  deps: CliDeps,
  token: string,
  pending: PendingSpendRequest,
  event: SpendRequestEvent,
  kind: SpendKind = "pack",
  failureCode: string | null = null
): Promise<void> {
  if (pending.reported?.includes(event)) return;
  try {
    await httpRequest(deps, pending.origin, "POST", "/api/agent/v1/credits/spend-requests", {
      token,
      body: {
        event,
        spendRequestId: pending.spendRequestId,
        pack: pending.pack,
        amount: pending.amount,
        currency: pending.currency,
        testMode: pending.testMode === true,
        ageMs: Math.max(0, deps.clock.now() - pending.createdAt),
        ...(failureCode ? { failureCode } : {}),
      },
    });
  } catch {
    return;
  }
  pending.reported = [...(pending.reported ?? []), event];
  await persistPending(deps, pending, kind);
}

/** link-cli 0.27 prints no approval page for live requests; Link notifies the app. */
export const IN_LINK_APP = "in their Link app (Link sends them a notification; there is no link to open)";

/** Approving in Link, then `--resume`; "Not now" leaves the request pending. */
export function paymentApprovalQuestion(
  what: string,
  approvalUrl: string | null | undefined,
  command = BUY_COMMAND
): ActionQuestion {
  const where = approvalUrl
    ? `Open ${approvalUrl} and approve ${what}.`
    : `Approve ${what} in your Link app (Link sends you a notification).`;
  return doneQuestion({
    id: "link_payment_approval",
    header: "Approve",
    question: `${where} Done?`,
    then: { run: `${command} --resume` },
    notNow: "Nothing is charged unless you approve",
  });
}

function notApprovedYet(pending: PendingSpendRequest, flow: SpendFlow): CliError {
  const where = pending.approvalUrl ? "in Link" : IN_LINK_APP;
  return actionError("The Link payment is not approved yet.", {
    kind: "approve",
    humanPrompt: `Ask the human to approve this ${flow.what} ${where}. After they approve, run \`${flow.command} --resume\`. Do not start a new purchase.`,
    ...(pending.approvalUrl ? { url: pending.approvalUrl } : {}),
    question: paymentApprovalQuestion(`the ${flow.what}`, pending.approvalUrl, flow.command),
  });
}

/** Link's message, then its link when there is one: `Complete 3D Secure. Link: https://…`. */
function linkStepText(snap: SpendRequestSnapshot, fallback: string): string {
  const message = snap.displayMessage ?? fallback;
  return snap.actionUrl ? `${message} Link: ${snap.actionUrl}` : message;
}

/**
 * 3D Secure or a partner auth challenge: the same spend request resumes once
 * the human completes it, so keep the pending file and do not start a new one.
 */
function verificationAsk(snap: SpendRequestSnapshot, flow: SpendFlow): string {
  const step = linkStepText(
    snap,
    "Link needs one more step for this payment; check the Link app."
  );
  return `Ask the human to complete Link's verification for this ${flow.what}: ${step}`;
}

function verificationPending(snap: SpendRequestSnapshot, flow: SpendFlow): CliError {
  return actionError("The Link payment is waiting for verification.", {
    kind: "approve",
    humanPrompt: `${verificationAsk(snap, flow)} After they finish, run \`${flow.command} --resume\`. Do not start a new purchase: this one resumes on its own.`,
    ...(snap.actionUrl ? { url: snap.actionUrl } : {}),
    question: doneQuestion({
      id: "link_payment_verification",
      header: "Verify",
      question: `${linkStepText(snap, `Complete Link's verification for the ${flow.what}.`)} Done?`,
      then: { run: `${flow.command} --resume` },
      notNow: "Nothing is charged until it is verified",
    }),
  });
}

/** The two resolutions that end this request; anything else may still resume. */
const NEW_REQUEST = "create_new_spend_request";
const NEW_REQUEST_AFTER = "create_new_spend_request_after_completion";

/**
 * Link stopped this request for good: say why and drop it. After a step the
 * human must finish first (`…_after_completion`), "Done" starts the new
 * request; otherwise the usual "Try again" does.
 */
async function stoppedByLink(
  deps: CliDeps,
  token: string,
  pending: PendingSpendRequest,
  flow: SpendFlow,
  snap: SpendRequestSnapshot,
  event: "requires_action" | "failed"
): Promise<never> {
  await reportSpendRequest(deps, token, pending, event, flow.kind, snap.failureCode);
  deletePendingSpend(deps, flow.kind);
  const reason =
    event === "failed"
      ? linkStepText(
          snap,
          `Link could not complete this payment${snap.failureCode ? ` (${snap.failureCode})` : ""}.`
        )
      : linkStepText(snap, "Link asked for a step that this payment cannot continue from.");
  const message =
    snap.displayMessage ??
    `The Link spend request ${event === "failed" ? "failed" : "needs another step"}.`;
  const url = snap.actionUrl ? { url: snap.actionUrl } : {};
  if (snap.resolution === NEW_REQUEST_AFTER) {
    throw actionError(message, {
      kind: "ask_human",
      humanPrompt: `${reason} Ask the human to finish that in Link first; nothing was charged. After they finish, run \`${flow.newCommand}\` for a new payment.`,
      ...url,
      question: doneQuestion({
        id: "link_payment_step",
        header: "Link",
        question: `${reason} Then CleanSlop starts a new payment for the ${flow.what}. Done?`,
        then: { run: flow.newCommand },
        notNow: "Nothing was charged",
      }),
    });
  }
  const restart = flow.restart("not completed");
  throw actionError(message, {
    kind: "ask_human",
    humanPrompt: `${reason} ${restart.humanPrompt}`,
    ...url,
    // A question tool may show only the question: repeat Link's reason there.
    question: { ...restart.question, question: `${reason} ${restart.question.question}` },
  });
}

/** Re-show the verification block when Link changes what it asks for. */
function sameAction(a: SpendRequestSnapshot | null, b: SpendRequestSnapshot): boolean {
  return (
    a !== null &&
    a.actionType === b.actionType &&
    a.actionUrl === b.actionUrl &&
    a.displayMessage === b.displayMessage
  );
}

/**
 * `approved`: retrieve the token and pay. `submitted` (the charge is still
 * processing) / `succeeded`: the token was already charged; never start a new
 * charge.
 */
export type SpendOutcome = "approved" | "submitted" | "succeeded";

/**
 * Checks the spend request at least once (starting from `first`, the create
 * response, when given), then polls until `waitMs` runs out.
 */
export async function pollUntilApproved(
  deps: CliDeps,
  token: string,
  pending: PendingSpendRequest,
  waitMs: number,
  onMissingScope: OnMissingScope,
  flow: SpendFlow = packFlow(pending.pack),
  first?: SpendRequestSnapshot
): Promise<SpendOutcome> {
  const deadline = deps.clock.now() + waitMs;
  let verifying: SpendRequestSnapshot | null = null;
  let next: SpendRequestSnapshot | undefined = first;
  for (;;) {
    const snap =
      next ??
      (await retrieveLinkSpendRequest(deps, pending.spendRequestId, {
        testMode: pending.testMode,
        onMissingScope,
      }));
    next = undefined;
    switch (snap.status) {
      case "approved":
        await reportSpendRequest(deps, token, pending, "approved", flow.kind);
        return "approved";
      case "submitted":
      case "succeeded":
        return snap.status;
      case "denied":
      case "expired":
      case "canceled":
        await reportSpendRequest(deps, token, pending, snap.status, flow.kind);
        deletePendingSpend(deps, flow.kind);
        throw actionError(`The Link spend request was ${snap.status}.`, {
          kind: "ask_human",
          ...flow.restart(snap.status),
        });
      case "failed":
        return stoppedByLink(deps, token, pending, flow, snap, "failed");
      case "requires_action":
        if (snap.resolution === NEW_REQUEST || snap.resolution === NEW_REQUEST_AFTER) {
          return stoppedByLink(deps, token, pending, flow, snap, "requires_action");
        }
        // `auto_resume`, or no action yet (Link: a null action does not rule
        // out verification): keep this request and keep checking.
        if (!verifying) {
          await reportSpendRequest(deps, token, pending, "requires_action", flow.kind);
        }
        // With no wait left the thrown block says the same; print it once per action.
        if (!sameAction(verifying, snap) && deps.clock.now() < deadline) {
          writeAction(deps, {
            kind: "approve",
            humanPrompt: `${verificationAsk(snap, flow)} Waiting for it to finish.`,
            ...(snap.actionUrl ? { url: snap.actionUrl } : {}),
          });
        }
        verifying = snap;
        break;
      case "pending":
      case "unknown":
        break;
      default: {
        const _exhaustive: never = snap.status;
        throw _exhaustive;
      }
    }
    if (deps.clock.now() >= deadline) {
      throw verifying ? verificationPending(verifying, flow) : notApprovedYet(pending, flow);
    }
    await deps.clock.sleep(2000);
  }
}

/**
 * After `submitted` / `succeeded`: one token check, no retry loop. With the
 * token the purchase POST replays the original row (the server looks up by
 * token and never charges twice); without it the request is simply done.
 */
export async function usedPaymentToken(
  deps: CliDeps,
  pending: PendingSpendRequest
): Promise<string | null> {
  try {
    const snap = await retrieveLinkSpendRequest(deps, pending.spendRequestId, {
      includeSpt: true,
      testMode: pending.testMode,
    });
    return snap.sharedPaymentToken;
  } catch {
    return null;
  }
}

/**
 * An earlier run already charged this request; this run has nothing to
 * charge. `submitted` is still processing, so say so rather than "went through".
 */
export function alreadyPaid(
  deps: CliDeps,
  flow: SpendFlow,
  status: "submitted" | "succeeded"
): number {
  deletePendingSpend(deps, flow.kind);
  deps.io.stdout(
    status === "submitted"
      ? `This Link payment for the ${flow.what} was already submitted on an earlier run and is still processing; nothing new was charged. Check ${flow.checkPaid} in a minute.\n`
      : `This Link payment for the ${flow.what} already went through on an earlier run; nothing new was charged. Check ${flow.checkPaid}.\n`
  );
  return EXIT_OK;
}

async function postPurchase(
  deps: CliDeps,
  origin: string,
  pending: PendingSpendRequest,
  token: string,
  sharedPaymentToken: string
): Promise<{ credits: number; pack: string; paymentIntentId: string | null }> {
  const result = await httpRequest(deps, origin, "POST", "/api/agent/v1/credits/purchases", {
    token,
    body: {
      pack: pending.pack,
      sharedPaymentToken,
      spendRequestId: pending.spendRequestId,
    },
  });
  try {
    requireOk(result);
  } catch (err) {
    if (err instanceof CliError && err.exitCode === EXIT_PAYMENT) {
      deletePendingSpend(deps);
    }
    throw err;
  }
  const rec = asRecord(result.json);
  const credits = typeof rec?.credits === "number" ? rec.credits : 0;
  const pack = typeof rec?.pack === "string" ? rec.pack : pending.pack;
  const paymentIntentId =
    typeof rec?.paymentIntentId === "string" ? rec.paymentIntentId : null;
  return { credits, pack, paymentIntentId };
}

/** Reads this grant's Link packs from `GET /credits/offers` (same shape as a 402). */
async function fetchStripeSptOffer(
  deps: CliDeps,
  origin: string,
  token: string,
  args: ParsedArgs
): Promise<StripeSptOffer> {
  const packHint = args.pack;
  const result = await httpRequest(deps, origin, "GET", "/api/agent/v1/credits/offers", {
    token,
  });
  requireOk(result);
  // An agent shell must not pick a pack for the human; a terminal keeps p5.
  const offers = stripeSptOffersFromErrorBody(result.json);
  const agentPicks = !packHint && !deps.io.stdinIsTTY;
  const web = monthlyPlanOffered(result.json);
  // While a promo code is possible, ask buy-or-promo first (packs plus
  // "Not now" already fill a question); "Buy" reruns with --no-promo.
  if (agentPicks && !args.noPromo && offers.length > 0 && promoOffered(result.json)) {
    throw actionError("Choose how to add scans.", {
      kind: "ask_human",
      humanPrompt: withWebBillingHint(withPromoHint(choosePackPrompt(offers), true), web),
      question: withWebBillingOption(
        topUpQuestion(
          buyOption(offers),
          "This account can still use a CleanSlop promo code. How do you want to add scans?"
        ),
        web
      ),
    });
  }
  if (agentPicks && offers.length > 1) {
    const step = await linkPaymentStep(deps);
    throw actionError("Choose a Link credit pack.", {
      kind: "ask_human",
      humanPrompt: withWebBillingHint(choosePackPrompt(offers) + approvalPromptTail(step), web),
      question: withWebBillingOption(packQuestion(offers, step), web),
    });
  }
  const offer = stripeSptOfferFromErrorBody(result.json, packHint);
  if (offer) return offer;
  const message =
    asRecord(asRecord(result.json)?.payment)?.message;
  const text =
    typeof message === "string" && message.trim()
      ? message.trim()
      : "Link credit packs are not available for this account.";
  throw new CliError(text, EXIT_PAYMENT, { kind: "ask_human", humanPrompt: text });
}

/**
 * Buys a Link credit pack. Default mode (a human at a terminal) creates the
 * spend request and waits up to 10 minutes. `--no-wait` creates it (or checks
 * the saved one), prints the approve block, and exits 10; `--resume` finishes
 * the saved request. A saved request for this origin is always reused rather
 * than replaced, so retries never send the person a second approval.
 */
export async function buyLinkCredits(
  deps: CliDeps,
  args: ParsedArgs,
  offer: StripeSptOffer | null = null,
  opts: { autoBuy?: boolean } = {}
): Promise<number> {
  const mode = linkAuthMode(args);
  const origin = resolveOrigin(deps);
  const stored = requireToken(deps, origin);
  const storedPending = readPendingSpend(deps);
  let existing =
    storedPending && storedPending.origin === origin ? storedPending : null;
  // The saved request was approved for its own pack and amount; another pack
  // needs its own request (as in `plan`). Only an approval, never a charge.
  if (
    existing &&
    isCreditPackId(args.pack) &&
    args.pack !== existing.pack &&
    !args.spendRequestId?.trim()
  ) {
    if (args.resume) {
      throw usageError(
        `The pending Link payment is for ${existing.pack}. Run \`${BUY_COMMAND} --resume\` without --pack to finish it, or drop --resume to start one for ${args.pack}.`
      );
    }
    deletePendingSpend(deps);
    existing = null;
  }
  if (args.resume && storedPending && !existing && !args.spendRequestId?.trim()) {
    throw actionError("Pending Link spend request is for another origin.", {
      kind: "ask_human",
      humanPrompt: `A pending Link spend request is for ${storedPending.origin}, but this CLI is using ${origin}. Drop --resume to start a new spend request, or set CLEANSLOP_ORIGIN back to ${storedPending.origin}.`,
    });
  }
  const resumeId = args.spendRequestId?.trim() || existing?.spendRequestId || null;

  let pending: PendingSpendRequest;
  let waitMs = linkApprovalWaitMs(args, opts);
  /** The create response, when Link already moved it past pending approval. */
  let first: SpendRequestSnapshot | undefined;
  if (resumeId) {
    const fromStore = existing && existing.spendRequestId === resumeId ? existing : null;
    pending = {
      version: 1,
      origin,
      spendRequestId: resumeId,
      pack: isCreditPackId(args.pack)
        ? args.pack
        : fromStore?.pack ?? offer?.pack ?? "p5",
      amount: args.amount ?? fromStore?.amount ?? offer?.amount ?? 0,
      currency: fromStore?.currency ?? offer?.currency ?? "usd",
      networkId:
        args.networkId?.trim() ||
        fromStore?.networkId ||
        deps.env.get("CLEANSLOP_STRIPE_PROFILE_ID")?.trim() ||
        offer?.networkId ||
        "",
      purchaseUrl: purchaseUrlFor(origin),
      createdAt: fromStore?.createdAt ?? deps.clock.now(),
      ...(fromStore?.approvalUrl ? { approvalUrl: fromStore.approvalUrl } : {}),
      ...(Array.isArray(fromStore?.reported) ? { reported: fromStore.reported } : {}),
    };
    if (!pending.amount || !pending.networkId) {
      throw usageError(
        "Resuming a spend request still needs the saved pack price and network id."
      );
    }
    const testMode = linkSpendRequestTestMode(deps, pending.networkId);
    // Older CLIs created live requests against test profiles. Link approves
    // those but never issues a token, so --resume would wait forever.
    const savedTestMode =
      fromStore?.testMode ??
      (fromStore ? deps.env.get("CLEANSLOP_LINK_TEST")?.trim() === "1" : testMode);
    if (savedTestMode !== testMode) {
      deletePendingSpend(deps);
      throw actionError("This Link spend request cannot be completed.", {
        kind: "ask_human",
        humanPrompt: `This Link payment was created in ${savedTestMode ? "test" : "live"} mode, but CleanSlop at ${origin} takes ${testMode ? "test" : "live"}-mode payments, so Link will never issue its token and no charge can go through. Tell the human they can cancel it in their Link app. Then run \`${BUY_COMMAND} --pack ${pending.pack} --no-wait\` for a new spend request.`,
        question: buyPackQuestion(
          "link_payment_restart",
          `Your earlier Link payment for ${pending.pack} cannot finish. After cancelling it in your Link app, start a new one?`,
          pending.pack,
          "Start a new payment"
        ),
      });
    }
    pending.testMode = testMode;
    await persistPending(deps, pending);
    // The session may have changed since the request was made (a new
    // `login --link`, or `link-cli auth logout`), and retrieve needs payments.
    await ensureLinkPaymentScope(deps, { mode, command: BUY_COMMAND });
  } else {
    const chosen =
      offer ??
      (args.amount == null
        ? await fetchStripeSptOffer(deps, origin, stored.token, args)
        : null);
    const pack: CreditPackId = isCreditPackId(args.pack)
      ? args.pack
      : chosen?.pack ?? "p5";
    const amount = args.amount ?? chosen?.amount ?? null;
    const networkId =
      args.networkId?.trim() ||
      deps.env.get("CLEANSLOP_STRIPE_PROFILE_ID")?.trim() ||
      chosen?.networkId ||
      "";
    if (!amount) {
      throw usageError("credits buy --link needs a pack price from CleanSlop or a test --amount");
    }
    if (!networkId) {
      throw usageError(
        "credits buy --link needs a Stripe network id from CleanSlop or CLEANSLOP_STRIPE_PROFILE_ID"
      );
    }
    const scans = CREDIT_PACKS[pack];
    const currency = chosen?.currency ?? "usd";
    const testMode = linkSpendRequestTestMode(deps, networkId);
    await ensureLinkPaymentScope(deps, {
      mode,
      command: `${BUY_COMMAND} --pack ${pack}`,
    });
    const created = await createLinkSpendRequest(deps, {
      networkId,
      amount,
      currency,
      context: spendRequestContext(pack, scans),
      lineItem: `name:CleanSlop ${scans} scan credits,unit_amount:${amount},quantity:1`,
      total: `type:total,display_text:Total,amount:${amount}`,
      idempotencyKey: deps.randomId(),
      testMode,
      expiresAt: packSpendRequestExpiry(deps),
    });
    pending = {
      version: 1,
      origin,
      spendRequestId: created.id,
      pack,
      amount,
      currency,
      networkId,
      purchaseUrl: purchaseUrlFor(origin),
      createdAt: deps.clock.now(),
      ...(created.approvalUrl ? { approvalUrl: created.approvalUrl } : {}),
      testMode,
    };
    await persistPending(deps, pending);
    await reportSpendRequest(deps, stored.token, pending, "created");
    // Link can attach an action (or a failure) at creation: same handling as a poll.
    const settled = created.status !== "pending" && created.status !== "unknown";
    if (settled) first = created;
    const autoApproved =
      !settled && (await autoApproveTestSpendRequest(deps, created.id, testMode));
    // The test helper's approval can lag a little, even under --no-wait.
    if (autoApproved) waitMs = Math.max(waitMs, AUTO_APPROVE_WAIT_MS);
    const price = formatPackPrice(amount, currency);
    const ask = created.approvalUrl
      ? `Ask the human to open this link and approve this CleanSlop credit pack (${pack}: ${scans} scans for ${price}). Link may also send a notification.`
      : `Ask the human to approve this CleanSlop credit pack (${pack}: ${scans} scans for ${price}) ${IN_LINK_APP}.`;
    const url = created.approvalUrl ? { url: created.approvalUrl } : {};
    const prompt = !settled && !autoApproved;
    if (prompt && mode !== "wait") {
      throw actionError("Link payment approval pending.", {
        kind: "approve",
        humanPrompt: `${ask} After they approve, run \`${BUY_COMMAND} --resume\`.`,
        ...url,
        question: paymentApprovalQuestion(
          `the CleanSlop credit pack (${pack}: ${scans} scans for ${price})`,
          created.approvalUrl
        ),
      });
    }
    if (prompt) {
      writeAction(deps, { kind: "approve", humanPrompt: `${ask} Waiting for approval.`, ...url });
    }
  }

  // Link refuses retrieve without the payment scope even when `auth status`
  // did not report the session's scopes: upgrade once, then retry.
  let regranted = false;
  const onMissingScope: OnMissingScope = async () => {
    if (regranted) return false;
    regranted = true;
    await grantLinkPayments(deps, { mode, command: BUY_COMMAND });
    return true;
  };
  const flow = packFlow(pending.pack);
  const outcome = await pollUntilApproved(
    deps,
    stored.token,
    pending,
    waitMs,
    onMissingScope,
    flow,
    first
  );
  const sharedPaymentToken =
    outcome !== "approved"
      ? await usedPaymentToken(deps, pending)
      : await retrieveSharedPaymentToken(deps, pending.spendRequestId, {
          testMode: pending.testMode,
          onMissingScope,
        });
  if (!sharedPaymentToken && outcome !== "approved") return alreadyPaid(deps, flow, outcome);
  if (!sharedPaymentToken) {
    await reportSpendRequest(deps, stored.token, pending, "token_missing");
    tokenMissingAction(pending.spendRequestId);
  }

  const paid = await postPurchase(
    deps,
    origin,
    pending,
    stored.token,
    sharedPaymentToken
  );
  deletePendingSpend(deps);
  deps.io.stdout(
    `Added ${paid.pack} scan credits. Balance: ${paid.credits}.\n`
  );
  return EXIT_OK;
}

export async function runCredits(
  deps: CliDeps,
  args: ParsedArgs
): Promise<number> {
  if (args.id && args.id !== "buy") {
    throw usageError("Usage: cleanslop credits buy --link");
  }
  if (args.id !== "buy") {
    throw usageError("Usage: cleanslop credits buy --link");
  }
  if (!args.link) {
    throw usageError("credits buy requires --link");
  }
  return buyLinkCredits(deps, args);
}

/**
 * If a scan 402 offers `stripe_spt`: a human at a terminal buys that pack in
 * place and the scan retries once. An agent (no TTY) gets a top-up block that
 * sends it through `credits buy --link --no-wait` / `--resume`, because a
 * 10-minute approval wait outlasts its shell call.
 */
export async function recoverOutOfScansIfOffered(
  deps: CliDeps,
  args: ParsedArgs,
  result: HttpResult,
  retry: () => Promise<HttpResult>
): Promise<HttpResult> {
  if (result.status !== 402) return result;
  const offer = stripeSptOfferFromErrorBody(result.json, args.pack);
  if (!offer) return result;
  if (!deps.io.stdinIsTTY) {
    const tail = " Then rerun the scan.";
    // An explicit --pack is the human's choice; otherwise offer every pack.
    const named = args.pack === offer.pack;
    const offers = stripeSptOffersFromErrorBody(result.json);
    const promo = promoOffered(result.json);
    // Promo first: the pack question (and what Link asks) comes from `credits buy`.
    const step: LinkPaymentStep = promo ? "approve" : await linkPaymentStep(deps);
    const web = monthlyPlanOffered(result.json);
    // Every pack plus "Not now" leaves no room for "Monthly plan": ask the
    // method first, unless the human already lets CleanSlop request Link
    // payments (they buy packs; the prompt still names the plan).
    const askMethod = web && !promo && !named && step !== "approve" && offers.length >= 3;
    throw new CliError("This account is out of scans.", EXIT_PAYMENT, {
      kind: "top-up",
      humanPrompt: withWebBillingHint(
        withPromoHint(
          (named
            ? `Ask the human whether to buy CleanSlop credit pack ${describePackOffer(offer)} with Link. If yes, run \`${BUY_COMMAND} --pack ${offer.pack} --no-wait\`, ${APPROVE_THEN_RESUME}${tail}`
            : choosePackPrompt(offers, tail)) + approvalPromptTail(step),
          promo
        ),
        web
      ),
      // Three packs plus "Not now" already fill a question, so a possible
      // promo code asks buy-or-promo first and `credits buy` asks the pack.
      question: askMethod
        ? webBillingQuestion(buyOption(offers), web)
        : withWebBillingOption(
            promo
              ? topUpQuestion(buyOption(named ? [offer] : offers))
              : named
                ? buyPackQuestion(
                    "link_credit_pack",
                    `This account is out of scans. Buy CleanSlop credit pack ${describePackOffer(offer)} with Link? ${approvalNote(step)}`,
                    offer.pack
                  )
                : packQuestion(offers, step, "This account is out of scans. "),
            web
          ),
    });
  }
  await buyLinkCredits(deps, args, offer, { autoBuy: true });
  return retry();
}
