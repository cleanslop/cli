import type { ActionQuestion, ActionQuestionOption } from "./exit.js";

export const REDEEM_COMMAND = "cleanslop redeem <code>";

export const NOT_NOW: ActionQuestionOption = {
  value: "none",
  label: "Not now",
  description: "Buy nothing",
};

const PROMO_OPTION: ActionQuestionOption = {
  value: "promo",
  label: "Use a promo code",
  description: "Free scans from a CleanSlop promo code",
  next: `ask the human to type their promo code, run \`${REDEEM_COMMAND}\` with exactly what they type, then rerun the scan`,
};

const PROMO_HINT = ` If they have a CleanSlop promo code instead, run \`${REDEEM_COMMAND}\` with exactly the code they type, then rerun the scan.`;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A 402 carries `payment.promo` only while the account can still use a code. */
export function promoOffered(json: unknown): boolean {
  return record(record(record(json)?.payment)?.promo) !== null;
}

export function withPromoHint(prompt: string, promo: boolean): string {
  return promo ? `${prompt}${PROMO_HINT}` : prompt;
}

/** A promo code is still possible: buy (when offered), promo, or stop. */
export function topUpQuestion(
  buy: ActionQuestionOption | null,
  question = "This account is out of scans. How do you want to add scans?"
): ActionQuestion {
  return {
    id: "top_up_method",
    header: "Add scans",
    question,
    options: [...(buy ? [buy] : []), PROMO_OPTION, NOT_NOW],
  };
}

export const BILLING_COMMAND = "cleanslop billing";
export const PLAN_COMMAND = "cleanslop plan";

/**
 * Where a Link account starts a monthly plan: here with Link (`cleanslop plan`,
 * when the server lists `payment.plans`) or on the website (`cleanslop billing`).
 */
export type MonthlyPlanRoute = "link" | "web";

/** Questions hold at most four options (Claude Code AskUserQuestion). */
const MAX_QUESTION_OPTIONS = 4;

export const WEB_BILLING_OPTION: ActionQuestionOption = {
  value: "web_billing",
  label: "Monthly plan",
  description: "Subscribe on the CleanSlop website",
  run: BILLING_COMMAND,
};

export const LINK_PLAN_OPTION: ActionQuestionOption = {
  value: "link_plan",
  label: "Monthly plan",
  description: "Start a monthly plan paid with Link",
  run: PLAN_COMMAND,
};

function planOption(route: MonthlyPlanRoute): ActionQuestionOption {
  return route === "link" ? LINK_PLAN_OPTION : WEB_BILLING_OPTION;
}

/**
 * A 402 or offers body carries `payment.plans` when Link plans are on, and
 * `payment.webBilling` for a Link-only account with web billing on.
 */
export function monthlyPlanOffered(json: unknown): MonthlyPlanRoute | null {
  const payment = record(record(json)?.payment);
  if (Array.isArray(payment?.plans) && payment.plans.length > 0) return "link";
  const web = record(payment?.webBilling);
  return typeof web?.url === "string" && web.url.length > 0 ? "web" : null;
}

export function withWebBillingHint(prompt: string, route: MonthlyPlanRoute | null): string {
  if (!route) return prompt;
  const command = route === "link" ? PLAN_COMMAND : BILLING_COMMAND;
  return `${prompt} For a monthly plan instead, run \`${command}\` and relay what it prints.`;
}

/** Adds "Monthly plan" before the last option ("Not now") when the question has room. */
export function withWebBillingOption(
  question: ActionQuestion,
  route: MonthlyPlanRoute | null
): ActionQuestion {
  if (!route || question.options.length >= MAX_QUESTION_OPTIONS) return question;
  const options = [...question.options];
  options.splice(options.length - 1, 0, planOption(route));
  return { ...question, options };
}

/** Buy (when offered), "Monthly plan" or "Not now": for when the packs leave no room. */
export function webBillingQuestion(
  buy: ActionQuestionOption | null,
  route: MonthlyPlanRoute,
  question = "This account is out of scans. How do you want to add scans?"
): ActionQuestion {
  return {
    id: "top_up_method",
    header: "Add scans",
    question,
    options: [...(buy ? [buy] : []), planOption(route), NOT_NOW],
  };
}
