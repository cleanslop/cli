import { CLIENT_ID, TERMS_UPDATED_ON } from "../config.js";
import { offerGithubAfterLinkFailure } from "../connect.js";
import { resolveOrigin } from "../credentials.js";
import type { CliDeps, HttpResult } from "../deps.js";
import { CliError, EXIT_OK, EXIT_POLICY, EXIT_UNEXPECTED } from "../exit.js";
import {
  asErrorBody,
  hasIdentityPresentationChallenge,
  httpRequest,
  throwHttpError,
} from "../http.js";
import {
  linkAttestation,
  linkAuthMode,
  linkSignupBody,
  presentLinkIdentity,
  readLinkClaimsChallenge,
  linkTermsAgreed,
  requireLinkTermsConsent,
  type LinkConsentSource,
} from "../link.js";
import { storeLoginToken } from "../token-rotation.js";
import type { DeviceTokenResponse, ParsedArgs } from "../types.js";

/** The server answers `terms_required` when the Link-verified email is new. */
function needsTerms(result: HttpResult): boolean {
  return asErrorBody(result.json).error === "terms_required";
}

export async function runLinkLogin(
  deps: CliDeps,
  args: ParsedArgs
): Promise<number> {
  const origin = resolveOrigin(deps);
  // Choosing Link and approving it in Link covers sharing the verified email.
  // The terms are asked only when that email has no CleanSlop account yet.
  const agreed: LinkConsentSource | null = linkTermsAgreed(args) ? "flag" : null;
  const first = await signInWithLink(deps, args, origin, agreed);
  if (first !== "terms_required") return first;
  const consentSource = await requireLinkTermsConsent(deps, origin);
  const second = await signInWithLink(deps, args, origin, consentSource);
  if (second === "terms_required") {
    throw new CliError("CleanSlop still asks for the current terms.", EXIT_UNEXPECTED);
  }
  return second;
}

async function signInWithLink(
  deps: CliDeps,
  args: ParsedArgs,
  origin: string,
  consentSource: LinkConsentSource | null
): Promise<number | "terms_required"> {
  const acceptTerms = consentSource ? TERMS_UPDATED_ON : null;
  const attestation = await linkAttestation(deps, { mode: linkAuthMode(args) }).catch(
    offerGithubAfterLinkFailure
  );

  const started = await httpRequest(deps, origin, "POST", "/oauth/link", {
    headers: { Authorization: attestation.authorization },
    body: linkSignupBody(deps, acceptTerms, consentSource),
  });
  if (!hasIdentityPresentationChallenge(started)) {
    // A server from before terms-on-create refuses here instead.
    if (!consentSource && needsTerms(started)) return "terms_required";
    throwHttpError(started);
  }
  const challenge = readLinkClaimsChallenge(started.json, origin);
  const presented = await presentLinkIdentity(deps, {
    aud: challenge.aud,
    nonce: challenge.nonce,
  }).catch(offerGithubAfterLinkFailure);
  const completed = await httpRequest(deps, origin, "POST", "/oauth/link", {
    headers: {
      Authorization: attestation.authorization,
      "Identity-Presentation": presented.presentation,
      "CleanSlop-Interaction": challenge.interactionId,
    },
    body: {
      client: CLIENT_ID,
      ...(acceptTerms ? { acceptTerms } : {}),
      ...(consentSource ? { consentSource } : {}),
    },
  });
  if (!consentSource && needsTerms(completed)) return "terms_required";
  const body = asErrorBody(completed.json);
  if (completed.status >= 400) {
    if (body.error === "link_pilot_required") {
      throw new CliError("Link pilot access required.", EXIT_POLICY, {
        kind: "beta",
        humanPrompt:
          "This Link email is not in the CleanSlop Link pilot yet. Ask the CleanSlop team for access, then run `cleanslop login --link` again.",
      });
    }
    throwHttpError(completed);
  }
  const issued = completed.json as DeviceTokenResponse | null;
  if (!issued || typeof issued.access_token !== "string") {
    throw new CliError("Link login response was missing access_token.", EXIT_UNEXPECTED);
  }
  const account = issued.account as
    | { email_masked?: string; emailMasked?: string; github_login?: string | null }
    | undefined;
  const emailMasked =
    (typeof account?.emailMasked === "string" && account.emailMasked) ||
    (typeof account?.email_masked === "string" && account.email_masked) ||
    null;
  await storeLoginToken(deps, origin, {
    token: issued.access_token,
    githubLogin: issued.account?.github_login ?? null,
    grantId: issued.grant_id ?? null,
  });
  const label = emailMasked || "your Link email";
  deps.io.stdout(`Connected as ${label} (Link)\n`);
  return EXIT_OK;
}
