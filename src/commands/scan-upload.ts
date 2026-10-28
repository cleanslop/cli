import { writeAction, writeResume } from "../action.js";
import {
  requireToken,
  resolveOrigin,
  storeLastScanId,
} from "../credentials.js";
import type { CliDeps, HttpResult } from "../deps.js";
import { CliError, EXIT_OK, EXIT_RUNNING, EXIT_SCAN_FAILED, EXIT_UNEXPECTED } from "../exit.js";
import { recoverOutOfScansIfOffered } from "./credits.js";
import { httpRequest, requireOk } from "../http.js";
import { writeJson, writeScanProgress } from "../output.js";
import { writeReport } from "../report-question.js";
import {
  formatPackSummary,
  packManifest,
  planPack,
  writePackArchive,
} from "../pack.js";
import type { ParsedArgs, StartScanResponse } from "../types.js";
import { fetchReport } from "./report.js";
import { isScanFinal, waitForScan } from "../wait.js";

export async function runUploadScan(
  deps: CliDeps,
  args: ParsedArgs
): Promise<number> {
  const origin = resolveOrigin(deps);
  const creds = requireToken(deps, origin);
  const plan = await planPack(deps);
  deps.io.stderr(formatPackSummary(plan, args.dryRun));
  if (args.dryRun) return EXIT_OK;

  const archive = await writePackArchive(plan);
  const manifest = packManifest(plan, archive);
  const reused = args.force
    ? null
    : await reuseScannedFiles(deps, origin, creds.token, manifest);
  const started =
    reused ?? (await uploadAndStart(deps, args, origin, creds.token, archive.bytes, manifest));
  requireOk(started);
  const payload = started.json as StartScanResponse | null;
  if (!payload?.scan?.id) {
    throw new CliError("Scan create response was invalid.", EXIT_UNEXPECTED);
  }
  const scan0 = payload.scan;
  await storeLastScanId(deps, origin, scan0.id);
  writeScanProgress(deps, scan0);

  let scan = scan0;
  if (!isScanFinal(scan) && args.wait) {
    scan = await waitForScan(deps, origin, creds.token, scan0.id, args.waitMs);
    writeScanProgress(deps, scan);
  }
  if (scan.status === "failed") {
    throw new CliError(scan.error?.message ?? "Scan failed.", EXIT_SCAN_FAILED);
  }
  const wantReport = isScanFinal(scan) || args.preview;
  if (!wantReport) {
    writeResume(deps, scan.id);
    throw new CliError("Scan is still running.", EXIT_RUNNING);
  }
  try {
    const fetched = await fetchReport(
      deps,
      origin,
      creds.token,
      scan.id,
      args.json ? "json" : "md",
      args.preview && !scan.final
    );
    if (args.json) {
      writeJson(deps, { scan, report: fetched.report });
    } else if (fetched.markdown) {
      writeReport(deps, fetched.markdown);
    }
  } catch (err) {
    if (err instanceof CliError && err.exitCode === EXIT_RUNNING) {
      writeResume(deps, scan.id);
      if (err.action) writeAction(deps, err.action);
    }
    throw err;
  }
  return EXIT_OK;
}

/**
 * Asks whether these exact files were scanned in the last 24h or are
 * scanning now. Returns that start response, or null to upload them.
 * Servers without the pre-check answer non-2xx, which also means upload.
 */
async function reuseScannedFiles(
  deps: CliDeps,
  origin: string,
  token: string,
  manifest: Record<string, unknown>
): Promise<HttpResult | null> {
  const res = await httpRequest(deps, origin, "POST", "/api/agent/v1/uploads/reuse", {
    token,
    body: { manifest, surface: "cli" },
  });
  const scanId = (res.json as { scan?: { id?: unknown } | null } | null)?.scan?.id;
  if (res.status !== 200 || typeof scanId !== "string") return null;
  deps.io.stderr(`Same files as scan ${scanId}; reusing it without uploading.\n`);
  return res;
}

async function uploadAndStart(
  deps: CliDeps,
  args: ParsedArgs,
  origin: string,
  token: string,
  bytes: Buffer,
  manifest: Record<string, unknown>
): Promise<HttpResult> {
  const uploaded = await httpRequest(deps, origin, "POST", "/api/agent/v1/uploads", {
    token,
    rawBody: new Uint8Array(bytes),
    contentType: "application/gzip",
    headers: { "CleanSlop-Upload-Manifest": JSON.stringify(manifest) },
  });
  requireOk(uploaded);
  const rec = uploaded.json as { uploadId?: string } | null;
  if (!rec || typeof rec.uploadId !== "string") {
    throw new CliError("Upload response was missing uploadId.", EXIT_UNEXPECTED);
  }

  const headers: Record<string, string> = {};
  if (args.force) headers["Idempotency-Key"] = deps.randomId();
  const startBody = {
    uploadId: rec.uploadId,
    force: args.force || undefined,
    surface: "cli",
  };
  const postStart = () =>
    httpRequest(deps, origin, "POST", "/api/agent/v1/scans", {
      token,
      headers,
      body: startBody,
    });
  return recoverOutOfScansIfOffered(deps, args, await postStart(), postStart);
}
