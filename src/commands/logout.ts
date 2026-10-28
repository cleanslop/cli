import {
  deleteAllLocalState,
  deleteOriginCreds,
  deletePendingFor,
  readCredentialsFile,
  resolveOrigin,
  resolveToken,
} from "../credentials.js";
import type { CliDeps } from "../deps.js";
import { EXIT_OK, EXIT_UNEXPECTED } from "../exit.js";
import { httpRequest } from "../http.js";
import type { ParsedArgs } from "../types.js";

/** Revokes `token` at `origin`; prints why and returns false when it could not. */
async function revoke(deps: CliDeps, origin: string, token: string): Promise<boolean> {
  try {
    const result = await httpRequest(deps, origin, "POST", "/oauth/revoke", {
      token,
      body: { token },
    });
    if (result.status >= 200 && result.status < 300) return true;
    deps.io.stderr(`Could not revoke the token for ${origin} (HTTP ${result.status}).\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.io.stderr(`Could not revoke the token for ${origin}: ${message}\n`);
  }
  return false;
}

const REVOKE_BY_HAND =
  "Revoke this agent under Account → Connected agents.";

export async function runLogout(deps: CliDeps, args: ParsedArgs): Promise<number> {
  if (args.all) return runLogoutAll(deps);
  const origin = resolveOrigin(deps);
  const creds = resolveToken(deps, origin);
  const revoked = creds ? await revoke(deps, origin, creds.token) : true;
  if (creds?.source !== "env") {
    await deleteOriginCreds(deps, origin);
  }
  deletePendingFor(deps, origin);
  if (creds?.source === "env") {
    deps.io.stdout(
      "Disconnected. File credentials were left in place because CLEANSLOP_TOKEN is set.\n"
    );
    return EXIT_OK;
  }
  if (!revoked) {
    deps.io.stdout(
      `Removed local credentials, but the server did not confirm revocation. ${REVOKE_BY_HAND}\n`
    );
    return EXIT_UNEXPECTED;
  }
  deps.io.stdout("Disconnected.\n");
  return EXIT_OK;
}

/**
 * Revokes every saved token at its own origin, then deletes every file the
 * CLI keeps (credentials, pending GitHub login, pending Link payment). Link's
 * own session and files are link-cli's; `link-cli auth logout` clears those.
 */
async function runLogoutAll(deps: CliDeps): Promise<number> {
  const failed: string[] = [];
  for (const [origin, creds] of Object.entries(readCredentialsFile(deps).origins)) {
    if (creds?.token && !(await revoke(deps, origin, creds.token))) failed.push(origin);
  }
  deleteAllLocalState(deps);
  const envNote = deps.env.get("CLEANSLOP_TOKEN")?.trim()
    ? " CLEANSLOP_TOKEN is still set in this environment; unset it too."
    : "";
  if (failed.length > 0) {
    deps.io.stdout(
      `Removed all local CleanSlop data, but ${failed.join(", ")} did not confirm revocation. ${REVOKE_BY_HAND}${envNote}\n`
    );
    return EXIT_UNEXPECTED;
  }
  deps.io.stdout(`Disconnected everywhere and removed all local CleanSlop data.${envNote}\n`);
  return EXIT_OK;
}
