import { writeAction, writeResume } from "../action.js";
import {
  requireToken,
  resolveOrigin,
  storeLastScanId,
} from "../credentials.js";
import type { CliDeps } from "../deps.js";
import {
  CliError,
  EXIT_OK,
  EXIT_POLICY,
  EXIT_RUNNING,
  EXIT_SCAN_FAILED,
  EXIT_SOURCE,
  EXIT_UNEXPECTED,
  sourceError,
} from "../exit.js";
import { assertGithubReady, inspectGit, uploadLocalQuestion, uploadOption } from "../git.js";
import { recoverOutOfScansIfOffered } from "./credits.js";
import { httpRequest, requireOk } from "../http.js";
import { writeJson, writeScanProgress } from "../output.js";
import { writeReport } from "../report-question.js";
import type { GitSnapshot, MeResponse, ParsedArgs, StartScanResponse } from "../types.js";
import { fetchReport } from "./report.js";
import { runUploadScan } from "./scan-upload.js";
import { isScanFinal, waitForScan } from "../wait.js";

/** No git checkout or no origin: a GitHub grant that may upload uploads instead. */
async function inspectGitOrNull(deps: CliDeps): Promise<GitSnapshot | null> {
  try {
    return await inspectGit(deps);
  } catch (err) {
    if (err instanceof CliError && err.exitCode === EXIT_SOURCE) return null;
    throw err;
  }
}

/** The repo has no GitHub App install: also offer to upload the local files. */
function offerUploadOnInstall(err: unknown): unknown {
  const question = err instanceof CliError ? err.action?.question : undefined;
  if (question?.id !== "github_install") return err;
  // After Done, before Not now.
  question.options.splice(
    1,
    0,
    uploadOption("Upload this folder's files instead. No project history or triage")
  );
  return err;
}

export async function runScan(
  deps: CliDeps,
  args: ParsedArgs
): Promise<number> {
  const origin = resolveOrigin(deps);
  const creds = requireToken(deps, origin);
  const meRes = await httpRequest(deps, origin, "GET", "/api/agent/v1/me", {
    token: creds.token,
  });
  requireOk(meRes);
  const me = (meRes.json ?? {}) as MeResponse;
  const canUpload = me.uploadFallback === true;
  if (me.uploads === true) {
    return runUploadScan(deps, args);
  }
  if (args.upload) {
    if (!canUpload) {
      throw new CliError(
        "This agent can't upload files. Run cleanslop login again to approve a new agent.",
        EXIT_POLICY
      );
    }
    return runUploadScan(deps, args);
  }
  const git = canUpload ? await inspectGitOrNull(deps) : await inspectGit(deps);
  if (!git || (canUpload && !git.github)) {
    // A GitHub sign-in never uploads unasked: `--upload` above is the yes.
    const why = "no commits, no origin, or a non-GitHub origin";
    throw sourceError(`This folder isn't on GitHub (${why}).`, {
      kind: "ask_human",
      humanPrompt:
        "This folder isn't on GitHub. Ask the human whether to scan its files by uploading them to CleanSlop.",
      question: uploadLocalQuestion(),
    });
  }
  assertGithubReady(git, { canUpload });

  const headers: Record<string, string> = {};
  if (args.force) {
    headers["Idempotency-Key"] = deps.randomId();
  }

  const startBody = {
    remote: git.remote,
    commitSha: git.commitSha,
    branch: git.branch,
    force: args.force || undefined,
    surface: "cli",
  };
  const postStart = () =>
    httpRequest(deps, origin, "POST", "/api/agent/v1/scans", {
      token: creds.token,
      headers,
      body: startBody,
    });
  const started = await recoverOutOfScansIfOffered(
    deps,
    args,
    await postStart(),
    postStart
  );
  try {
    requireOk(started);
  } catch (err) {
    throw canUpload ? offerUploadOnInstall(err) : err;
  }
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
    writeResume(deps, scan.id, scan);
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
      writeResume(deps, scan.id, scan);
      if (err.action) writeAction(deps, err.action);
    }
    throw err;
  }

  return EXIT_OK;
}
