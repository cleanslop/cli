import { requireToken, resolveOrigin } from "../credentials.js";
import type { CliDeps } from "../deps.js";
import { actionError, EXIT_OK, type ActionQuestion } from "../exit.js";
import { httpRequest, requireOk } from "../http.js";
import { stripeSptOffersFromErrorBody } from "./credits.js";
import { writeJson } from "../output.js";
import type { MeResponse, ParsedArgs } from "../types.js";

type WebBilling = { url: string; emailMasked: string };

type SignInLinkResponse = {
  sent?: boolean;
  reason?: string;
  webBilling?: { url?: string; emailMasked?: string } | null;
  expiresAt?: string;
};

function webBillingFrom(
  raw: { url?: string; emailMasked?: string } | null | undefined
): WebBilling | null {
  return raw?.url && raw.emailMasked ? { url: raw.url, emailMasked: raw.emailMasked } : null;
}

function typedAddressPrompt({ url, emailMasked }: WebBilling): string {
  return `To subscribe, buy credits or cancel your plan, go to ${url} and enter ${emailMasked}. You'll get a sign-in link by email.`;
}

/**
 * Where a Link account manages its plan. The server emails the sign-in link
 * to the account's Link address (the CLI never sees it); when it cannot, or
 * an older server has no such route, the human types the masked address at
 * `/signin/email`.
 */
export async function runBilling(
  deps: CliDeps,
  args: ParsedArgs
): Promise<number> {
  const origin = resolveOrigin(deps);
  const creds = requireToken(deps, origin);
  const result = await httpRequest(
    deps,
    origin,
    "POST",
    "/api/agent/v1/billing/sign-in-link",
    { token: creds.token }
  );
  if (result.status === 404) return typedAddress(deps, args, origin, creds.token);
  requireOk(result);
  const body = (result.json ?? {}) as SignInLinkResponse;
  const webBilling = webBillingFrom(body.webBilling);
  if (!webBilling) return notAvailable(deps, args);
  const sent = body.sent === true;
  if (args.json) {
    writeJson(deps, {
      sent,
      ...(sent ? { expiresAt: body.expiresAt ?? null } : { reason: body.reason ?? null }),
      webBilling,
    });
  }
  const { url, emailMasked } = webBilling;
  const humanPrompt = sent
    ? `We emailed a sign-in link to ${emailMasked}. Open it to subscribe, buy credits or cancel your plan. It works once and expires in 15 minutes. No email? Go to ${url} and enter ${emailMasked}.`
    : body.reason === "rate_limited"
      ? `Sign-in links already went to ${emailMasked} in the last 15 minutes. Open the newest one to subscribe, buy credits or cancel your plan.`
      : typedAddressPrompt(webBilling);
  const question = await doneOnWebQuestion(
    deps,
    origin,
    creds.token,
    sent
      ? `Open the sign-in link we emailed to ${emailMasked} and finish on the CleanSlop website. Done?`
      : body.reason === "rate_limited"
        ? `Open the newest sign-in link sent to ${emailMasked} and finish on the CleanSlop website. Done?`
        : typedAddressQuestion(webBilling)
  );
  throw actionError("", { kind: "ask_human", humanPrompt, url, question });
}

function typedAddressQuestion({ url, emailMasked }: WebBilling): string {
  return `Go to ${url}, enter ${emailMasked}, sign in from the email and finish on the CleanSlop website. Done?`;
}

/**
 * Done on the web, buy a Link pack here instead (only when Link packs are on
 * offer), or stop. A failed offers check just leaves the Link answer out.
 */
async function doneOnWebQuestion(
  deps: CliDeps,
  origin: string,
  token: string,
  question: string
): Promise<ActionQuestion> {
  let offersLinkPacks = false;
  try {
    const offers = await httpRequest(deps, origin, "GET", "/api/agent/v1/credits/offers", { token });
    offersLinkPacks = offers.status === 200 && stripeSptOffersFromErrorBody(offers.json).length > 0;
  } catch {
    offersLinkPacks = false;
  }
  return {
    id: "web_billing",
    header: "Billing",
    question,
    options: [
      {
        value: "done",
        label: "Done",
        description: "Finished on the website",
        next: "rerun the scan that ran out of scans, if any; otherwise run `cleanslop whoami` to show the plan",
      },
      ...(offersLinkPacks
        ? [
            {
              value: "link",
              label: "Buy with Link instead",
              description: "Buy a credit pack here",
              run: "cleanslop credits buy --link --no-wait",
            },
          ]
        : []),
      { value: "stop", label: "Not now", description: "Stop here" },
    ],
  };
}

async function typedAddress(
  deps: CliDeps,
  args: ParsedArgs,
  origin: string,
  token: string
): Promise<number> {
  const result = await httpRequest(deps, origin, "GET", "/api/agent/v1/me", { token });
  requireOk(result);
  const webBilling = webBillingFrom((result.json as MeResponse | null)?.webBilling);
  if (!webBilling) return notAvailable(deps, args);
  if (args.json) writeJson(deps, { sent: false, reason: null, webBilling });
  throw actionError("", {
    kind: "ask_human",
    humanPrompt: typedAddressPrompt(webBilling),
    url: webBilling.url,
    question: await doneOnWebQuestion(deps, origin, token, typedAddressQuestion(webBilling)),
  });
}

function notAvailable(deps: CliDeps, args: ParsedArgs): number {
  if (args.json) writeJson(deps, { webBilling: null });
  else deps.io.stdout("Not available for this account.\n");
  return EXIT_OK;
}
