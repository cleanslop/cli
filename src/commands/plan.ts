import { writeAction } from "../action.js";
import type { CliDeps } from "../deps.js";
import { asRecord, httpRequest, requireOk, throwHttpError } from "../http.js";
import {
  createLinkSpendRequest,
  ensureLinkPaymentScope,
  grantLinkPayments,
  linkAuthMode,
  linkPaymentStep,
  linkSpendRequestTestMode,
  retrieveSharedPaymentToken,
  type OnMissingScope,
} from "../link.js";
import {
  deletePendingSpend,
  readPendingSpend,
  requireToken,
  resolveOrigin,
  writePendingSpend,
  type PendingSpendRequest,
} from "../credentials.js";
import {
  type ActionQuestion,
  actionError,
  CliError,
  EXIT_OK,
  EXIT_PAYMENT,
  usageError,
} from "../exit.js";
import { BILLING_COMMAND, NOT_NOW, PLAN_COMMAND } from "../top-up.js";
import type { ParsedArgs } from "../types.js";
import { runBilling } from "./billing.js";
import {
  approvalNote,
  approvalPromptTail,
  formatPackPrice,
  IN_LINK_APP,
  LINK_APPROVAL_WAIT_MS,
  LINK_RESUME_WAIT_MS,
  paymentApprovalQuestion,
  pollUntilApproved,
  reportSpendRequest,
  tokenMissingAction,
  type SpendFlow,
} from "./credits.js";

/** The CLI's plan ids. The server's plan id for Max is `team`; it accepts `max`. */
export type CliPlanId = "starter" | "pro" | "max";

const PLAN_NAMES: Record<CliPlanId, string> = {
  starter: "Starter",
  pro: "Pro",
  max: "Max",
};

export type PlanOffer = {
  plan: CliPlanId;
  name: string;
  amount: number;
  currency: string;
  networkId: string;
  purchaseUrl: string;
};

/** `max`, and `team` as an alias for it; anything else is null. */
export function parsePlanId(raw: string | null): CliPlanId | null {
  const value = raw?.trim().toLowerCase();
  if (value === "team") return "max";
  return value === "starter" || value === "pro" || value === "max" ? value : null;
}

function asPlanOffer(value: unknown): PlanOffer | null {
  const rec = asRecord(value);
  const plan = parsePlanId(typeof rec?.plan === "string" ? rec.plan : null);
  if (!rec || !plan) return null;
  const amount = typeof rec.amount === "number" ? rec.amount : Number(rec.amount);
  if (!Number.isInteger(amount) || amount < 1) return null;
  const networkId = typeof rec.networkId === "string" ? rec.networkId.trim() : "";
  const purchaseUrl = typeof rec.purchaseUrl === "string" ? rec.purchaseUrl.trim() : "";
  if (!networkId || !purchaseUrl) return null;
  return {
    plan,
    name: typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : PLAN_NAMES[plan],
    amount,
    currency:
      typeof rec.currency === "string" && rec.currency.trim() ? rec.currency.trim() : "usd",
    networkId,
    purchaseUrl,
  };
}

/** Monthly plans in an offers or 402 body (`payment.plans`), in server order. */
export function planOffersFromBody(json: unknown): PlanOffer[] {
  const plans = asRecord(asRecord(json)?.payment)?.plans;
  return (Array.isArray(plans) ? plans : [])
    .map(asPlanOffer)
    .filter((offer): offer is PlanOffer => offer != null);
}

function monthlyPrice(amount: number, currency: string): string {
  return `${formatPackPrice(amount, currency)} per month`;
}

/** `Pro (49.00 USD per month)`. */
function describePlan(offer: PlanOffer): string {
  return `${offer.name} (${monthlyPrice(offer.amount, offer.currency)})`;
}

function startCommand(plan: string): string {
  return `${PLAN_COMMAND} ${plan} --no-wait`;
}

function spendRequestContext(offer: PlanOffer): string {
  return `CleanSlop ${offer.name} plan, ${monthlyPrice(offer.amount, offer.currency)}. Approve this recurring Shared Payment Token so your coding agent can start a monthly CleanSlop plan. CleanSlop charges it once a month until you cancel the plan with \`${BILLING_COMMAND}\`.`;
}

function planFlow(plan: string): SpendFlow {
  const name = PLAN_NAMES[parsePlanId(plan) ?? "starter"];
  return {
    kind: "plan",
    command: PLAN_COMMAND,
    what: `CleanSlop ${name} plan`,
    restart: (status) => ({
      humanPrompt: `The Link approval was ${status}. Ask the person whether to try again; if yes, run \`${startCommand(plan)}\` for a new spend request.`,
      question: {
        id: "link_plan_retry",
        header: "Plan",
        question: `The Link approval for the ${name} plan was ${status}. Try again?`,
        options: [{ value: plan, label: "Try again", run: startCommand(plan) }, NOT_NOW],
      },
    }),
  };
}

/** Every plan plus "Not now": exactly four options. */
function planQuestion(offers: PlanOffer[], note: string): ActionQuestion {
  return {
    id: "link_plan",
    header: "Plan",
    question: `Which monthly CleanSlop plan should I start with Link? ${note}`,
    options: [
      ...offers.map((offer) => ({
        value: offer.plan,
        label: `${offer.name} · ${monthlyPrice(offer.amount, offer.currency)}`,
        run: startCommand(offer.plan),
      })),
      NOT_NOW,
    ],
  };
}

const PLAN_APPROVAL_NOTE =
  "Link charges it each month until you cancel the plan with `cleanslop billing`.";

type CurrentPlan = { name: string; status: "active" | "pending" };

/** `payment.currentPlan`: the account already has a plan, or one is being set up. */
export function currentPlanFromBody(json: unknown): CurrentPlan | null {
  const rec = asRecord(asRecord(asRecord(json)?.payment)?.currentPlan);
  if (!rec) return null;
  return {
    name: typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : "monthly",
    status: rec.status === "pending" ? "pending" : "active",
  };
}

/** Stops before any spend request: the server would refuse a second plan. */
function currentPlanError(current: CurrentPlan, approval: string): CliError {
  if (current.status === "pending") {
    return actionError("A monthly plan is already being set up.", {
      kind: "wait",
      humanPrompt: `A CleanSlop ${current.name} plan is already being set up for this account, so ${approval}. Check again in a few minutes with \`cleanslop whoami\`; do not start another plan.`,
    });
  }
  return actionError("This account already has a monthly plan.", {
    kind: "ask_human",
    humanPrompt: `This account already has the CleanSlop ${current.name} plan, so ${approval}. To change or cancel it, run \`${BILLING_COMMAND}\` and relay what it prints.`,
  });
}

/** Reads plan offers; none means Link plans are off and the plan lives on the website. */
async function choosePlan(
  deps: CliDeps,
  origin: string,
  token: string,
  args: ParsedArgs
): Promise<PlanOffer | null> {
  const wanted = parsePlanId(args.id);
  if (args.id && !wanted) throw usageError("Usage: cleanslop plan [starter|pro|max]");
  const result = await httpRequest(deps, origin, "GET", "/api/agent/v1/credits/offers", { token });
  requireOk(result);
  const current = currentPlanFromBody(result.json);
  if (current) throw currentPlanError(current, "no Link approval was requested");
  const offers = planOffersFromBody(result.json);
  if (offers.length === 0) return null;
  const offer = offers.find((o) => o.plan === wanted);
  if (offer) return offer;
  const step = await linkPaymentStep(deps);
  const list = new Intl.ListFormat("en", { type: "disjunction" }).format(offers.map(describePlan));
  throw actionError("Choose a monthly plan.", {
    kind: "ask_human",
    humanPrompt: `Ask the human which monthly CleanSlop plan to start with Link: ${list}. ${PLAN_APPROVAL_NOTE} If they pick one, run \`${PLAN_COMMAND} <plan> --no-wait\`, relay its approval prompt (Link notifies their Link app; there is usually no link), and after they approve run \`${PLAN_COMMAND} --resume\`.${approvalPromptTail(step)}`,
    question: planQuestion(offers, `${PLAN_APPROVAL_NOTE} ${approvalNote(step)}`),
  });
}

type PlanPurchase = { name: string; status: string };

/** POSTs the approved token. Keeps the saved request only while the server says to retry it. */
async function postPlan(
  deps: CliDeps,
  pending: PendingSpendRequest,
  token: string,
  sharedPaymentToken: string
): Promise<PlanPurchase | "plans_off"> {
  const result = await httpRequest(deps, pending.origin, "POST", "/api/agent/v1/plans/purchases", {
    token,
    body: { plan: pending.pack, sharedPaymentToken, spendRequestId: pending.spendRequestId },
  });
  const body = asRecord(result.json);
  const reason = typeof body?.reason === "string" ? body.reason : null;
  if (result.status >= 200 && result.status < 300) {
    deletePendingSpend(deps, "plan");
    return {
      name: typeof body?.name === "string" ? body.name : PLAN_NAMES[parsePlanId(pending.pack) ?? "starter"],
      status: typeof body?.status === "string" ? body.status : "active",
    };
  }
  if (result.status === 404) {
    deletePendingSpend(deps, "plan");
    return "plans_off";
  }
  if (reason === "pending") {
    throw actionError("The plan payment is still processing.", {
      kind: "wait",
      humanPrompt: `Link approved the plan and CleanSlop is still charging it. Run \`${PLAN_COMMAND} --resume\` in a minute — do not create a new spend request.`,
      code: pending.spendRequestId,
    });
  }
  deletePendingSpend(deps, "plan");
  if (reason === "subscription_exists" || reason === "plan_in_progress") {
    const plan = typeof body?.plan === "string" ? parsePlanId(body.plan) : null;
    throw currentPlanError(
      { name: plan ? PLAN_NAMES[plan] : "monthly", status: reason === "plan_in_progress" ? "pending" : "active" },
      "the Link approval was not used and nothing was charged"
    );
  }
  if (result.status === 402) {
    const plan = parsePlanId(pending.pack) ?? "starter";
    throw new CliError(`The Link payment for the plan failed (${reason ?? "payment_failed"}).`, EXIT_PAYMENT, {
      kind: "ask_human",
      humanPrompt: `Link could not pay for the ${PLAN_NAMES[plan]} plan (${reason ?? "payment_failed"}), so no plan was started. Ask the person whether to try again with \`${startCommand(plan)}\`, or to subscribe on the website with \`${BILLING_COMMAND}\`.`,
    });
  }
  throwHttpError(result);
}

/**
 * `cleanslop plan [starter|pro|max]`: start a monthly plan paid each month
 * from a recurring Link spend request. Same approval modes as `credits buy
 * --link` (wait, `--no-wait`, `--resume`). When the server lists no plans,
 * the plan lives on the website: same as `cleanslop billing`.
 */
export async function runPlan(deps: CliDeps, args: ParsedArgs): Promise<number> {
  const mode = linkAuthMode(args);
  const origin = resolveOrigin(deps);
  const stored = requireToken(deps, origin);
  const saved = readPendingSpend(deps, "plan");
  let pending = saved && saved.origin === origin ? saved : null;
  // A different plan replaces the saved request; it is only an approval, never a charge.
  if (pending && args.id && parsePlanId(args.id) !== parsePlanId(pending.pack)) {
    deletePendingSpend(deps, "plan");
    pending = null;
  }
  if (args.resume && !pending) {
    throw usageError(`No Link plan approval to resume. Run \`${PLAN_COMMAND} <starter|pro|max> --no-wait\`.`);
  }

  if (pending) {
    await ensureLinkPaymentScope(deps, { mode, command: PLAN_COMMAND });
  } else {
    const offer = await choosePlan(deps, origin, stored.token, args);
    if (!offer) return runBilling(deps, args);
    const networkId =
      args.networkId?.trim() || deps.env.get("CLEANSLOP_STRIPE_PROFILE_ID")?.trim() || offer.networkId;
    const testMode = linkSpendRequestTestMode(deps, networkId);
    await ensureLinkPaymentScope(deps, { mode, command: `${PLAN_COMMAND} ${offer.plan}` });
    const created = await createLinkSpendRequest(deps, {
      networkId,
      amount: offer.amount,
      currency: offer.currency,
      context: spendRequestContext(offer),
      lineItem: `name:CleanSlop ${offer.name} plan (monthly),unit_amount:${offer.amount},quantity:1`,
      total: `type:total,display_text:Total per month,amount:${offer.amount}`,
      idempotencyKey: deps.randomId(),
      testMode,
      recurringInterval: "month",
    });
    pending = {
      version: 1,
      origin,
      spendRequestId: created.id,
      pack: offer.plan,
      amount: offer.amount,
      currency: offer.currency,
      networkId,
      purchaseUrl: offer.purchaseUrl,
      createdAt: deps.clock.now(),
      ...(created.approvalUrl ? { approvalUrl: created.approvalUrl } : {}),
      testMode,
    };
    await writePendingSpend(deps, pending, "plan");
    await reportSpendRequest(deps, stored.token, pending, "created", "plan");
    const what = `the CleanSlop ${offer.name} plan (${monthlyPrice(offer.amount, offer.currency)}, charged each month until they cancel with \`${BILLING_COMMAND}\`)`;
    const ask = created.approvalUrl
      ? `Ask the human to open this link and approve ${what}. Link may also send a notification.`
      : `Ask the human to approve ${what} ${IN_LINK_APP}.`;
    const url = created.approvalUrl ? { url: created.approvalUrl } : {};
    if (mode !== "wait") {
      throw actionError("Link plan approval pending.", {
        kind: "approve",
        humanPrompt: `${ask} After they approve, run \`${PLAN_COMMAND} --resume\`.`,
        ...url,
        question: paymentApprovalQuestion(
          `the CleanSlop ${offer.name} plan (${monthlyPrice(offer.amount, offer.currency)})`,
          created.approvalUrl,
          PLAN_COMMAND
        ),
      });
    }
    writeAction(deps, { kind: "approve", humanPrompt: `${ask} Waiting for approval.`, ...url });
  }

  let regranted = false;
  const onMissingScope: OnMissingScope = async () => {
    if (regranted) return false;
    regranted = true;
    await grantLinkPayments(deps, { mode, command: PLAN_COMMAND });
    return true;
  };
  const waitMs = mode === "no-wait" ? 0 : mode === "resume" ? LINK_RESUME_WAIT_MS : LINK_APPROVAL_WAIT_MS;
  await pollUntilApproved(deps, stored.token, pending, waitMs, onMissingScope, planFlow(pending.pack));
  const sharedPaymentToken = await retrieveSharedPaymentToken(deps, pending.spendRequestId, {
    testMode: pending.testMode,
    onMissingScope,
  });
  if (!sharedPaymentToken) {
    await reportSpendRequest(deps, stored.token, pending, "token_missing", "plan");
    tokenMissingAction(pending.spendRequestId, PLAN_COMMAND);
  }
  const started = await postPlan(deps, pending, stored.token, sharedPaymentToken);
  if (started === "plans_off") return runBilling(deps, args);
  deps.io.stdout(
    `Started the CleanSlop ${started.name} plan (${started.status}). Change or cancel it with \`${BILLING_COMMAND}\`.\n`
  );
  return EXIT_OK;
}
