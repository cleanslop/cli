import { requireToken, resolveOrigin } from "../credentials.js";
import type { CliDeps } from "../deps.js";
import { EXIT_OK } from "../exit.js";
import { httpRequest, requireOk } from "../http.js";
import { writeJson } from "../output.js";
import { BILLING_COMMAND, PLAN_COMMAND } from "../top-up.js";
import type { MeResponse, ParsedArgs } from "../types.js";

/** ` (30 scans per month)`; empty when the server did not send a limit. */
function scansPerMonth(limit: number | undefined): string {
  if (typeof limit !== "number") return "";
  return ` (${limit} ${limit === 1 ? "scan" : "scans"} per month)`;
}

export async function runWhoami(
  deps: CliDeps,
  args: ParsedArgs
): Promise<number> {
  const origin = resolveOrigin(deps);
  const creds = requireToken(deps, origin);
  const result = await httpRequest(deps, origin, "GET", "/api/agent/v1/me", {
    token: creds.token,
  });
  requireOk(result);
  const me = (result.json ?? {}) as MeResponse;
  const login = me.user?.githubLogin ?? creds.githubLogin;
  const emailMasked = me.user?.emailMasked ?? me.link?.emailMasked ?? null;
  const payload = {
    origin,
    githubLogin: login ?? null,
    emailMasked,
    uploads: me.uploads === true,
    grantId: me.grant?.id ?? creds.grantId,
    tokenLast4: creds.last4,
    source: creds.source,
    quota: me.quota ?? null,
    webBilling: me.webBilling?.url ? me.webBilling : null,
    linkPlans: me.linkPlans === true,
  };
  if (args.json) {
    writeJson(deps, payload);
    return EXIT_OK;
  }
  const label = login
    ? `@${login}`
    : emailMasked
      ? `${emailMasked} (Link)`
      : "unknown account";
  deps.io.stdout(`Connected as ${label}\n`);
  deps.io.stdout(`origin ${origin}\n`);
  deps.io.stdout(`token …${creds.last4}\n`);
  if (payload.grantId) deps.io.stdout(`grant ${payload.grantId}\n`);
  const plan = me.quota?.plan;
  const planName = me.quota?.planName || plan;
  if (planName) deps.io.stdout(`plan ${planName}${scansPerMonth(me.quota?.scanLimit)}\n`);
  if (me.quota && typeof me.quota.remaining === "number") {
    deps.io.stdout(`quota ${me.quota.remaining} remaining\n`);
  }
  const paid = Boolean(plan) && plan !== "free";
  if (paid && payload.webBilling) {
    deps.io.stdout(`manage your ${planName} plan or buy credits on the web: run \`${BILLING_COMMAND}\`\n`);
  } else {
    if (payload.linkPlans && !paid) {
      deps.io.stdout(`start a monthly plan with Link: run \`${PLAN_COMMAND}\`\n`);
    }
    if (payload.webBilling) {
      deps.io.stdout(
        payload.linkPlans
          ? `billing on the web: run \`${BILLING_COMMAND}\` to buy credits\n`
          : `billing on the web: run \`${BILLING_COMMAND}\` to buy credits or manage a monthly plan\n`
      );
    }
  }
  return EXIT_OK;
}
