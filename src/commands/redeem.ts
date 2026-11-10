import { requireToken, resolveOrigin } from "../credentials.js";
import type { CliDeps } from "../deps.js";
import { EXIT_OK, usageError } from "../exit.js";
import { asRecord, httpRequest, requireOk } from "../http.js";
import { writeJson } from "../output.js";
import type { ParsedArgs } from "../types.js";

/**
 * `cleanslop redeem <code>`: redeem a promo (invite) code the human gave for
 * free scans. One code per account.
 */
export async function runRedeem(deps: CliDeps, args: ParsedArgs): Promise<number> {
  const code = args.id?.trim();
  if (!code) throw usageError("Pass the promo code: cleanslop redeem <code>");
  const origin = resolveOrigin(deps);
  const creds = requireToken(deps, origin);
  const result = await httpRequest(deps, origin, "POST", "/api/agent/v1/credits/redeem", {
    token: creds.token,
    body: { code },
  });
  requireOk(result);
  const rec = asRecord(result.json);
  const scans = typeof rec?.scanCredits === "number" ? rec.scanCredits : 0;
  const reviews = typeof rec?.reviewCredits === "number" ? rec.reviewCredits : 0;
  const balance = typeof rec?.credits === "number" ? rec.credits : null;
  // Credits-aware servers also send amounts in credits (4 per scan).
  const granted = typeof rec?.creditsGranted === "number" ? rec.creditsGranted : null;
  const purchased = typeof rec?.purchasedCredits === "number" ? rec.purchasedCredits : null;
  if (args.json) {
    writeJson(deps, {
      redeemed: true,
      scanCredits: scans,
      reviewCredits: reviews,
      credits: balance,
      ...(granted == null ? {} : { creditsGranted: granted }),
      ...(purchased == null ? {} : { purchasedCredits: purchased }),
    });
    return EXIT_OK;
  }
  const extra = reviews > 0 ? ` and ${reviews} review credits` : "";
  if (granted != null) {
    const tail = purchased == null ? "" : ` Balance: ${purchased} credits.`;
    deps.io.stdout(`Promo code applied: added ${granted} credits (${scans} scans)${extra}.${tail}\n`);
    return EXIT_OK;
  }
  const tail = balance == null ? "" : ` Balance: ${balance}.`;
  deps.io.stdout(`Promo code applied: added ${scans} scan credits${extra}.${tail}\n`);
  return EXIT_OK;
}
