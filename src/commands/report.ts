import {
  requireToken,
  resolveOrigin,
  peekStoredCreds,
} from "../credentials.js";
import type { CliDeps } from "../deps.js";
import { CliError, EXIT_OK, EXIT_RUNNING, usageError } from "../exit.js";
import { asErrorBody, httpRequest, requireOk } from "../http.js";
import { writeJson } from "../output.js";
import { writeReport } from "../report-question.js";
import { writeResume } from "../action.js";
import type { ParsedArgs } from "../types.js";

export function resolveScanId(
  deps: CliDeps,
  origin: string,
  id: string | null
): string {
  if (id) return id;
  const stored = peekStoredCreds(deps, origin);
  if (stored?.lastScanId) return stored.lastScanId;
  throw usageError("Pass a scan id or run a scan first.");
}

/**
 * One page with every listed finding: the CLI has no cursor, so a paged
 * report would leave findings out. The server clamps this to its own cap
 * (the same cap as the whole report).
 */
const REPORT_LIMIT = "250";

export async function fetchReport(
  deps: CliDeps,
  origin: string,
  token: string,
  scanId: string,
  format: "md" | "json",
  preview: boolean
): Promise<{ markdown: string | null; report: unknown | null }> {
  const params = new URLSearchParams({ format, limit: REPORT_LIMIT });
  if (preview) params.set("preview", "1");
  const result = await httpRequest(
    deps,
    origin,
    "GET",
    `/api/agent/v1/scans/${encodeURIComponent(scanId)}/report?${params.toString()}`,
    {
      token,
      accept: format === "md" ? "text/markdown, application/json" : "application/json",
    }
  );
  if (result.status === 409) {
    const body = asErrorBody(result.json);
    if (body.error === "report_not_ready") {
      throw new CliError(
        body.message ?? "Report is not ready yet.",
        EXIT_RUNNING
      );
    }
  }
  requireOk(result);
  if (format === "md") {
    return { markdown: result.text, report: result.json };
  }
  return { markdown: null, report: result.json };
}

export async function runReport(
  deps: CliDeps,
  args: ParsedArgs
): Promise<number> {
  const origin = resolveOrigin(deps);
  const creds = requireToken(deps, origin);
  const scanId = resolveScanId(deps, origin, args.id);
  try {
    const fetched = await fetchReport(
      deps,
      origin,
      creds.token,
      scanId,
      args.json ? "json" : args.format,
      args.preview
    );
    if (args.json) {
      writeJson(deps, fetched.report);
    } else {
      writeReport(deps, fetched.markdown ?? "");
    }
    return EXIT_OK;
  } catch (err) {
    if (err instanceof CliError && err.exitCode === EXIT_RUNNING) {
      writeResume(deps, scanId);
    }
    throw err;
  }
}
