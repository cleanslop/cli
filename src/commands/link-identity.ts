import { requireToken, resolveOrigin } from "../credentials.js";
import type { CliDeps } from "../deps.js";
import { CliError, EXIT_OK, EXIT_UNEXPECTED } from "../exit.js";
import {
  asRecord,
  hasIdentityPresentationChallenge,
  httpRequest,
  requireOk,
} from "../http.js";
import {
  ensureLinkAuth,
  linkAuthMode,
  presentLinkIdentity,
  readLinkClaimsChallenge,
} from "../link.js";
import type { ParsedArgs } from "../types.js";

export async function runLinkIdentity(
  deps: CliDeps,
  args: ParsedArgs
): Promise<number> {
  const authMode = linkAuthMode(args);
  const origin = resolveOrigin(deps);
  const creds = requireToken(deps, origin);
  // No separate email question: the human chose this in `link_existing`
  // ("Sign in with GitHub, then connect Link"), and the server only links the
  // email this account already has verified.
  await ensureLinkAuth(deps, {
    mode: authMode,
    command: "cleanslop link-identity",
  });

  const started = await httpRequest(
    deps,
    origin,
    "POST",
    "/api/agent/v1/identity/link",
    { token: creds.token, body: {} }
  );
  if (!hasIdentityPresentationChallenge(started)) {
    requireOk(started);
    throw new CliError("Link bridge did not return a claims challenge.", EXIT_UNEXPECTED);
  }
  const challenge = readLinkClaimsChallenge(started.json, origin);
  const presented = await presentLinkIdentity(deps, {
    aud: challenge.aud,
    nonce: challenge.nonce,
  });
  const completed = await httpRequest(
    deps,
    origin,
    "POST",
    "/api/agent/v1/identity/link",
    {
      token: creds.token,
      headers: {
        "Identity-Presentation": presented.presentation,
        "CleanSlop-Interaction": challenge.interactionId,
      },
    }
  );
  requireOk(completed);
  const rec = asRecord(completed.json);
  const emailMasked =
    rec && typeof rec.emailMasked === "string" ? rec.emailMasked : "your Link email";
  deps.io.stdout(`Linked ${emailMasked} to this account.\n`);
  return EXIT_OK;
}
