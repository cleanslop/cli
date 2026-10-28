import { LONGPOLL_MAX_SEC } from "./config.js";
import type { CliDeps } from "./deps.js";
import { CliError, EXIT_RUNNING, EXIT_UNEXPECTED } from "./exit.js";
import { httpRequest, requireOk, retryAfterMs } from "./http.js";
import { formatEtaLine, writeScanNext } from "./output.js";
import type { AgentScan } from "./types.js";

export function isScanFinal(scan: AgentScan): boolean {
  return scan.final === true;
}

export function clampPollMs(
  pollAfterSec: number | undefined,
  minPollMs: number
): number {
  const fromServer = (pollAfterSec ?? 10) * 1000;
  return Math.max(minPollMs, fromServer);
}

export async function fetchScan(
  deps: CliDeps,
  origin: string,
  token: string,
  scanId: string,
  waitSec: number
): Promise<AgentScan> {
  const q = waitSec > 0 ? `?waitSec=${waitSec}` : "";
  const result = await httpRequest(
    deps,
    origin,
    "GET",
    `/api/agent/v1/scans/${encodeURIComponent(scanId)}${q}`,
    { token }
  );
  if (result.status === 429) {
    throw new CliError("Rate limited while waiting for the scan.", EXIT_RUNNING);
  }
  requireOk(result);
  const rec = result.json as AgentScan | null;
  if (!rec || typeof rec !== "object" || typeof rec.id !== "string") {
    throw new CliError("Scan status response was not valid JSON.", EXIT_UNEXPECTED);
  }
  return rec;
}

export async function waitForScan(
  deps: CliDeps,
  origin: string,
  token: string,
  scanId: string,
  budgetMs: number
): Promise<AgentScan> {
  const deadline = deps.clock.now() + budgetMs;
  let last: AgentScan | null = null;
  let first = true;

  while (first || deps.clock.now() < deadline) {
    first = false;
    const remainingMs = Math.max(0, deadline - deps.clock.now());
    const waitSec = Math.min(
      LONGPOLL_MAX_SEC,
      Math.max(0, Math.floor(remainingMs / 1000))
    );
    try {
      last = await fetchScan(deps, origin, token, scanId, waitSec);
    } catch (err) {
      if (err instanceof CliError && err.exitCode === EXIT_RUNNING) {
        const remaining = deadline - deps.clock.now();
        if (remaining <= 0) break;
        await deps.clock.sleep(Math.min(deps.minPollMs, remaining));
        continue;
      }
      throw err;
    }
    if (isScanFinal(last)) {
      return last;
    }
    if (last.progress) {
      deps.io.stderr(`${last.progress.label}\n`);
    }
    const eta = formatEtaLine(last);
    if (eta) {
      deps.io.stderr(`${eta}\n`);
    }
    writeScanNext(deps, last);
    const remaining = deadline - deps.clock.now();
    if (remaining <= 0) break;
    const gap = clampPollMs(last.pollAfterSec, deps.minPollMs);
    await deps.clock.sleep(Math.min(gap, remaining));
  }

  if (last) return last;
  throw new CliError("Timed out waiting for the scan.", EXIT_RUNNING);
}

export async function backoffSleep(
  deps: CliDeps,
  attempt: number,
  result?: { status: number; headers: Headers; json: unknown }
): Promise<void> {
  const base = Math.min(30_000, 2000 * 2 ** Math.min(attempt, 4));
  if (result && result.status === 429) {
    await deps.clock.sleep(
      retryAfterMs(
        {
          status: result.status,
          headers: result.headers,
          text: "",
          json: result.json,
        },
        base
      )
    );
    return;
  }
  await deps.clock.sleep(base);
}
