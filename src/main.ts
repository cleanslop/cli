import { writeAction } from "./action.js";
import { HELP_TEXT, parseArgs } from "./args.js";
import { runBilling } from "./commands/billing.js";
import { runCredits } from "./commands/credits.js";
import { runLinkIdentity } from "./commands/link-identity.js";
import { runLogin } from "./commands/login.js";
import { runLogout } from "./commands/logout.js";
import { runEmail } from "./commands/email.js";
import { runPlan } from "./commands/plan.js";
import { runFeedback } from "./commands/feedback.js";
import { runRedeem } from "./commands/redeem.js";
import { runReport } from "./commands/report.js";
import { runScan } from "./commands/scan.js";
import { runSetup } from "./commands/setup.js";
import { runStatus } from "./commands/status.js";
import { runWhoami } from "./commands/whoami.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./config.js";
import { mergeDeps, type CliDeps } from "./deps.js";
import { withConnectChoice } from "./connect.js";
import { CliError, EXIT_OK, EXIT_UNEXPECTED, NotConnectedError } from "./exit.js";
import type { ParsedArgs } from "./types.js";

export function printHelp(deps: CliDeps): number {
  deps.io.stdout(HELP_TEXT);
  return EXIT_OK;
}

export function printVersion(deps: CliDeps): number {
  deps.io.stdout(`${PACKAGE_NAME} ${PACKAGE_VERSION}\n`);
  return EXIT_OK;
}

export async function dispatch(
  deps: CliDeps,
  args: ParsedArgs
): Promise<number> {
  if (args.help) return printHelp(deps);
  if (args.version) return printVersion(deps);
  switch (args.command) {
    case "login":
      return runLogin(deps, args);
    case "logout":
      return runLogout(deps, args);
    case "whoami":
      return runWhoami(deps, args);
    case "scan":
      return runScan(deps, args);
    case "status":
      return runStatus(deps, args);
    case "report":
      return runReport(deps, args);
    case "setup":
      return runSetup(deps, args);
    case "email":
      return runEmail(deps, args);
    case "link-identity":
      return runLinkIdentity(deps, args);
    case "credits":
      return runCredits(deps, args);
    case "redeem":
      return runRedeem(deps, args);
    case "billing":
      return runBilling(deps, args);
    case "plan":
      return runPlan(deps, args);
    case "feedback":
      return runFeedback(deps, args);
    default: {
      const _exhaustive: never = args.command;
      return _exhaustive;
    }
  }
}

export async function runCli(
  argv: string[],
  overrides: Partial<CliDeps> = {}
): Promise<number> {
  const deps = mergeDeps(overrides);
  try {
    const args = parseArgs(argv, deps.defaultWaitMs);
    return await dispatch(deps, args);
  } catch (caught) {
    const err =
      caught instanceof NotConnectedError ? await withConnectChoice(deps, caught) : caught;
    if (err instanceof CliError) {
      if (err.action) writeAction(deps, err.action);
      if (err.message) deps.io.stderr(`${err.message}\n`);
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.io.stderr(`${message}\n`);
    return EXIT_UNEXPECTED;
  }
}
