import type { CliDeps } from "./deps.js";
import type { AgentScan } from "./types.js";

export function writeJson(deps: CliDeps, value: unknown): void {
  deps.io.stdout(`${JSON.stringify(value)}\n`);
}

export function writeMarkdownReport(deps: CliDeps, markdown: string): void {
  const text = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  deps.io.stdout(text);
}

export function scanLine(scan: AgentScan): string {
  const bits = [
    `id=${scan.id}`,
    `status=${scan.status}`,
    `final=${scan.final ? "true" : "false"}`,
  ];
  if (scan.commitSha) {
    bits.push(`commit=${scan.commitSha.slice(0, 7)}`);
  } else if (scan.upload?.gitCommit) {
    // Uploaded with uncommitted changes: name the base, not a commit it isn't.
    bits.push(`commit=${scan.upload.gitCommit.slice(0, 7)}+changes`);
  }
  if (typeof scan.findingCount === "number") {
    bits.push(`findings=${scan.findingCount}`);
  }
  return bits.join(" ");
}

export function formatEtaLine(
  scan: Pick<AgentScan, "eta" | "elapsedSec">
): string | null {
  if (!scan.eta) return null;
  const minMin = Math.max(1, Math.round(scan.eta.minSec / 60));
  const maxMin = Math.max(minMin, Math.round(scan.eta.maxSec / 60));
  const range = minMin === maxMin ? `${minMin} min` : `${minMin}–${maxMin} min`;
  const elapsed =
    scan.elapsedSec != null
      ? scan.elapsedSec < 90
        ? `${scan.elapsedSec}s elapsed`
        : `${Math.round(scan.elapsedSec / 60)} min elapsed`
      : null;
  return elapsed ? `ETA ${range} (${elapsed})` : `ETA ${range}`;
}

const printedAskEmailScanIds = new Set<string>();

export function writeScanNext(
  deps: CliDeps,
  scan: Pick<AgentScan, "id" | "next">
): void {
  if (scan.next?.action !== "ask_email") return;
  if (printedAskEmailScanIds.has(scan.id)) return;
  printedAskEmailScanIds.add(scan.id);
  deps.io.stderr(
    [
      "CLEANSLOP_ACTION_REQUIRED: ask_email",
      "",
      `This scan may take a while. Run \`cleanslop email ${scan.id}\` to get the exact masked-recipient question, ask the human, and if they agree rerun with \`--consent "<that exact question>"\`. Never open, approve, or pay yourself.`,
      "",
    ].join("\n")
  );
}

export function resetAskEmailPrintedForTests(): void {
  printedAskEmailScanIds.clear();
}

/** The credits a new scan holds, when the server says (size-based pricing). */
export function writeCreditsReserved(
  deps: CliDeps,
  started: { credits?: { reserved?: number } }
): void {
  const reserved = started.credits?.reserved;
  if (typeof reserved !== "number" || reserved <= 0) return;
  const noun = reserved === 1 ? "credit" : "credits";
  deps.io.stderr(
    `Reserved ${reserved} ${noun} for this scan. If it reads less, the difference comes back.\n`
  );
}

const FULL_SCAN_REASONS: Record<string, string> = {
  requested: "a full scan was asked for",
  unavailable: "incremental scans aren't available here",
  no_parent: "no earlier scan to build on",
  snapshot_unavailable: "the last scan's files are no longer kept",
};

/** Whether a new scan builds on an earlier one, or why it runs full. */
export function writeScanMode(
  deps: CliDeps,
  started: { created?: boolean; scan: AgentScan; fullScanReason?: string | null }
): void {
  if (started.created !== true) return;
  if (started.scan.incremental && started.scan.parentScanId) {
    deps.io.stderr(`Incremental scan building on ${started.scan.parentScanId}.\n`);
    return;
  }
  const reason = started.fullScanReason;
  if (reason) deps.io.stderr(`Full scan: ${FULL_SCAN_REASONS[reason] ?? reason}.\n`);
}

export function writeScanProgress(deps: CliDeps, scan: AgentScan): void {
  deps.io.stderr(`${scanLine(scan)}\n`);
  if (scan.progress) {
    deps.io.stderr(`${scan.progress.label}\n`);
  }
  const eta = formatEtaLine(scan);
  if (eta) {
    deps.io.stderr(`${eta}\n`);
  }
  if (scan.error) {
    deps.io.stderr(`${scan.error.message}\n`);
  }
  writeScanNext(deps, scan);
}
