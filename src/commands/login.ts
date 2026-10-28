import { CLIENT_ID, DEVICE_GRANT_TYPE, PACKAGE_VERSION } from "../config.js";
import {
  deletePendingLogin,
  readPendingLogin,
  resolveOrigin,
  writePendingLogin,
} from "../credentials.js";
import { questionLines } from "../action.js";
import type { CliDeps } from "../deps.js";
import { doneQuestion } from "../done-question.js";
import {
  actionError,
  CliError,
  EXIT_ACTION,
  EXIT_OK,
  EXIT_UNEXPECTED,
  usageError,
} from "../exit.js";
import { detectAgentHint, gitToplevel, parseGithubRemote } from "../git.js";
import { asErrorBody, httpRequest } from "../http.js";
import { storeLoginToken } from "../token-rotation.js";
import type { DeviceStartResponse, DeviceTokenResponse, ParsedArgs } from "../types.js";
import { runLinkLogin } from "./link-login.js";

/** Matches server DEVICE_EXTEND_TTL_MS — first /connect view extends the code. */
export const DEVICE_POLL_GRACE_MS = 30 * 60 * 1000;

export function devicePollDeadline(expiresAt: number): number {
  return expiresAt + DEVICE_POLL_GRACE_MS;
}

async function repoHint(deps: CliDeps): Promise<string | undefined> {
  const top = await gitToplevel(deps, deps.env.cwd());
  if (!top) return undefined;
  const remote = await deps.git(["remote", "get-url", "origin"], top);
  if (!remote.ok) return undefined;
  return parseGithubRemote(remote.stdout)?.fullName;
}

export const GITHUB_RESUME_COMMAND = "cleanslop login --resume";

/** `--no-wait` exits after printing, so it also asks the human to say when they approved. */
function printApproval(
  deps: CliDeps,
  device: {
    verificationUriComplete: string;
    userCode: string;
  },
  opts: { askDone?: boolean } = {}
): void {
  const url = device.verificationUriComplete;
  const code = device.userCode;
  deps.io.stderr(`${url}\n`);
  deps.io.stderr(`${code}\n`);
  const lines = [
    "CLEANSLOP_ACTION_REQUIRED: approve",
    "",
    `Ask the human to open ${url} and confirm code ${code}.`,
    "Do not open or approve it yourself.",
  ];
  if (opts.askDone) {
    lines.push(
      "",
      ...questionLines(
        doneQuestion({
          id: "github_approval",
          header: "Approve",
          question: `Open ${url}, confirm code ${code}, and approve CleanSlop. Done?`,
          then: { run: GITHUB_RESUME_COMMAND },
        })
      )
    );
  }
  deps.io.stderr(`${lines.join("\n")}\n`);
}

async function pollDeviceToken(
  deps: CliDeps,
  origin: string,
  device: {
    deviceCode: string;
    userCode: string;
    verificationUriComplete: string;
    interval: number;
    expiresAt: number;
  }
): Promise<number> {
  let intervalMs = Math.max(3, device.interval) * 1000;
  const deadline = devicePollDeadline(device.expiresAt);

  while (deps.clock.now() < deadline) {
    await deps.clock.sleep(intervalMs);
    let tokenRes;
    try {
      tokenRes = await httpRequest(deps, origin, "POST", "/oauth/token", {
        body: {
          grant_type: DEVICE_GRANT_TYPE,
          device_code: device.deviceCode,
          client_id: CLIENT_ID,
        },
      });
    } catch (err) {
      if (err instanceof CliError && err.exitCode === EXIT_UNEXPECTED) {
        continue;
      }
      throw err;
    }
    if (tokenRes.status >= 500) {
      continue;
    }
    const body = asErrorBody(tokenRes.json);
    const err = body.error;
    if (tokenRes.status >= 200 && tokenRes.status < 300) {
      const issued = tokenRes.json as DeviceTokenResponse | null;
      if (!issued || typeof issued.access_token !== "string") {
        throw new CliError("Token response was missing access_token.", EXIT_UNEXPECTED);
      }
      const login = issued.account?.github_login ?? null;
      await storeLoginToken(deps, origin, {
        token: issued.access_token,
        githubLogin: login,
        grantId: issued.grant_id ?? null,
      });
      deletePendingLogin(deps);
      const label = login ? `@${login}` : "your GitHub account";
      deps.io.stdout(`Connected as ${label}\n`);
      return EXIT_OK;
    }
    if (err === "authorization_pending") {
      continue;
    }
    if (err === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (err === "access_denied" || err === "expired_token" || err === "invalid_grant") {
      deletePendingLogin(deps);
      throw actionError(
        body.error_description ?? body.message ?? err,
        {
          kind: "approve",
          humanPrompt:
            body.error_description ??
            "The human denied or the code expired. Run `cleanslop login` again.",
          url: device.verificationUriComplete,
          code: device.userCode,
        }
      );
    }
    throw new CliError(
      body.error_description ?? body.message ?? "Token poll failed.",
      EXIT_ACTION
    );
  }

  deletePendingLogin(deps);
  throw actionError("Device login timed out.", {
    kind: "approve",
    humanPrompt: "The device code expired. Run `cleanslop login` again.",
    url: device.verificationUriComplete,
    code: device.userCode,
  });
}

export async function runLogin(
  deps: CliDeps,
  args: ParsedArgs
): Promise<number> {
  if (args.link) {
    return runLinkLogin(deps, args);
  }
  if (args.noWait && args.resume) {
    throw usageError("Use either --no-wait or --resume, not both.");
  }

  const origin = resolveOrigin(deps);

  if (args.resume) {
    const pending = readPendingLogin(deps);
    if (!pending || pending.origin !== origin) {
      throw actionError("No pending device login for this origin.", {
        kind: "approve",
        humanPrompt: "Run `cleanslop login --no-wait` and ask the human to approve the code.",
      });
    }
    if (deps.clock.now() >= devicePollDeadline(pending.expiresAt)) {
      deletePendingLogin(deps);
      throw actionError("The pending device code expired.", {
        kind: "approve",
        humanPrompt: "Run `cleanslop login` again.",
        url: pending.verificationUriComplete,
        code: pending.userCode,
      });
    }
    printApproval(deps, {
      verificationUriComplete: pending.verificationUriComplete,
      userCode: pending.userCode,
    });
    return pollDeviceToken(deps, origin, {
      deviceCode: pending.deviceCode,
      userCode: pending.userCode,
      verificationUriComplete: pending.verificationUriComplete,
      interval: pending.interval,
      expiresAt: pending.expiresAt,
    });
  }

  const started = await httpRequest(
    deps,
    origin,
    "POST",
    "/oauth/device_authorization",
    {
      body: {
        client_id: CLIENT_ID,
        client: { name: CLIENT_ID, version: PACKAGE_VERSION },
        agent: detectAgentHint(deps.env),
        host: deps.env.hostname().slice(0, 64),
        repo: await repoHint(deps),
      },
    }
  );
  if (started.status >= 400) {
    const body = asErrorBody(started.json);
    throw new CliError(
      body.message ?? body.error_description ?? "Could not start device login.",
      started.status === 503 ? EXIT_UNEXPECTED : EXIT_ACTION
    );
  }
  const device = started.json as DeviceStartResponse | null;
  if (
    !device ||
    typeof device.device_code !== "string" ||
    typeof device.user_code !== "string" ||
    typeof device.verification_uri_complete !== "string"
  ) {
    throw new CliError("Device authorization response was invalid.", EXIT_UNEXPECTED);
  }

  const intervalSec = Math.max(3, Number(device.interval) || 5);
  const expiresSec = Number(device.expires_in);
  const ttlSec = Number.isFinite(expiresSec) ? expiresSec : 600;
  const expiresAt = deps.clock.now() + ttlSec * 1000;

  printApproval(
    deps,
    {
      verificationUriComplete: device.verification_uri_complete,
      userCode: device.user_code,
    },
    { askDone: args.noWait }
  );

  if (args.noWait) {
    await writePendingLogin(deps, {
      version: 1,
      origin,
      deviceCode: device.device_code,
      userCode: device.user_code,
      verificationUriComplete: device.verification_uri_complete,
      expiresAt,
      interval: intervalSec,
    });
    return EXIT_ACTION;
  }

  return pollDeviceToken(deps, origin, {
    deviceCode: device.device_code,
    userCode: device.user_code,
    verificationUriComplete: device.verification_uri_complete,
    interval: intervalSec,
    expiresAt,
  });
}
