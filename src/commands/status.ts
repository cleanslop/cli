import { writeResume } from "../action.js";
import {
  requireToken,
  resolveOrigin,
} from "../credentials.js";
import type { CliDeps } from "../deps.js";
import { CliError, EXIT_OK, EXIT_RUNNING, EXIT_SCAN_FAILED } from "../exit.js";
import { writeJson, writeScanProgress } from "../output.js";
import type { ParsedArgs } from "../types.js";
import { resolveScanId } from "./report.js";
import { fetchScan, waitForScan } from "../wait.js";

export async function runStatus(
  deps: CliDeps,
  args: ParsedArgs
): Promise<number> {
  const origin = resolveOrigin(deps);
  const creds = requireToken(deps, origin);
  const scanId = resolveScanId(deps, origin, args.id);
  const scan = args.wait
    ? await waitForScan(deps, origin, creds.token, scanId, args.waitMs)
    : await fetchScan(deps, origin, creds.token, scanId, 0);

  if (args.json) {
    writeJson(deps, { scan });
  } else {
    writeScanProgress(deps, scan);
  }

  if (scan.status === "failed") {
    throw new CliError(scan.error?.message ?? "Scan failed.", EXIT_SCAN_FAILED);
  }
  if (!scan.final && args.wait) {
    writeResume(deps, scan.id, scan);
    throw new CliError("Scan is still running.", EXIT_RUNNING);
  }
  return EXIT_OK;
}
