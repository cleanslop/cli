import { peekStoredCreds, storeToken } from "./credentials.js";
import type { CliDeps } from "./deps.js";
import { httpRequest } from "./http.js";

/**
 * After `login` (GitHub or Link): store the new token first, then revoke the
 * one it replaces. A failed revoke never fails the login; the human is told
 * the old token still works.
 */
export async function storeLoginToken(
  deps: CliDeps,
  origin: string,
  creds: { token: string; githubLogin: string | null; grantId: string | null }
): Promise<void> {
  const prior = peekStoredCreds(deps, origin);
  await storeToken(deps, origin, creds);
  let revoked = false;
  if (prior?.token && prior.token !== creds.token) {
    try {
      const res = await httpRequest(deps, origin, "POST", "/oauth/revoke", {
        token: prior.token,
        body: { token: prior.token },
      });
      revoked = res.status >= 200 && res.status < 300;
    } catch {
      // Transport failure: reported below.
    }
    if (!revoked) {
      deps.io.stderr(
        "Could not revoke the previous CleanSlop token; it still works. Revoke it from the security email sent when it was created, or under Account → Connected agents.\n"
      );
    }
  }
  const envToken = deps.env.get("CLEANSLOP_TOKEN")?.trim();
  if (envToken && revoked && envToken === prior?.token) {
    deps.io.stderr(
      "CLEANSLOP_TOKEN holds the token this login just revoked, so commands will fail until you unset it (or set it to the new token).\n"
    );
  } else if (envToken) {
    deps.io.stderr(
      "CLEANSLOP_TOKEN is set, so commands keep using that token instead of this login. Unset it to use the new one.\n"
    );
  }
}
