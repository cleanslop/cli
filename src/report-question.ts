import { questionLines } from "./action.js";
import type { CliDeps } from "./deps.js";
import type { ActionQuestion } from "./exit.js";
import { writeMarkdownReport } from "./output.js";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Counts from the server's report markdown: the header comment and the summary table. */
function reportCounts(markdown: string): { confirmed: number; needsInput: number } | null {
  const header = /<!-- cleanslop:v1 [^>]*\bfinal=true\b[^>]*\bconfirmed=(\d+)/.exec(markdown);
  if (!header) return null;
  const needsInput = /^\| Needs input \| (\d+) \|$/m.exec(markdown);
  return { confirmed: Number(header[1]), needsInput: needsInput ? Number(needsInput[1]) : 0 };
}

/**
 * What to do with a finished report. Agents tend to summarize a report and
 * stop; a question puts fixing (or not) to the human. Null when there is
 * nothing to fix or the report is not final.
 */
export function fixFindingsQuestion(markdown: string): ActionQuestion | null {
  const counts = reportCounts(markdown);
  if (!counts) return null;
  const { confirmed, needsInput } = counts;
  const notNow = { value: "stop", label: "Not now", description: "Leave the code as it is" };
  if (confirmed > 0) {
    const also = needsInput > 0 ? ` ${plural(needsInput, "more needs", "more need")} your input.` : "";
    return {
      id: "fix_findings",
      header: "Fix findings",
      question: `Fix the ${plural(confirmed, "confirmed finding", "confirmed findings")} now?${also}`,
      options: [
        {
          value: "fix",
          label: "Fix them",
          description: "Edit the code, run tests, rescan once",
          next: "fix the confirmed findings by priority using each one's location and recommendation, ask the human about any needs-input findings, run the repo's tests, then rescan once",
        },
        {
          value: "plan",
          label: "Show me first",
          description: "List the planned changes before editing",
          next: "list the change you plan for each confirmed finding and ask the human before editing any file",
        },
        notNow,
      ],
    };
  }
  if (needsInput === 0) return null;
  return {
    id: "fix_findings",
    header: "Fix findings",
    question: `${plural(needsInput, "finding needs", "findings need")} your input. Go through ${needsInput === 1 ? "it" : "them"} now?`,
    options: [
      {
        value: "review",
        label: "Go through them",
        description: "Answer each review question",
        next: "ask the human about each needs-input finding (its review note says what is unclear), fix the ones they confirm, run the repo's tests, then rescan once",
      },
      notNow,
    ],
  };
}

type DigestRow = { severity: string; title: string; location: string | null; reviewNote: string | null };

const DIGEST_MAX_ROWS = 20;
const DIGEST_SECTIONS = { "## Confirmed": "Confirmed", "## Needs input": "Needs input" } as const;

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Confirmed and needs-input rows from the server's report markdown (`### n. title`, `- severity:`, `Location:`). */
function digestRows(markdown: string): Record<"Confirmed" | "Needs input", DigestRow[]> {
  const rows: Record<"Confirmed" | "Needs input", DigestRow[]> = { Confirmed: [], "Needs input": [] };
  let section: "Confirmed" | "Needs input" | null = null;
  let row: DigestRow | null = null;
  // Snippets are repository content: skip fenced blocks so they cannot fake a heading or row.
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    if (fence) {
      if (line === fence) fence = null;
    } else if (/^`{3,}$/.test(line)) {
      fence = line;
    } else if (line.startsWith("## ")) {
      section = DIGEST_SECTIONS[line.trim() as keyof typeof DIGEST_SECTIONS] ?? null;
      row = null;
    } else if (section && /^### \d+\. /.test(line)) {
      row = { severity: "unknown", title: oneLine(line.replace(/^### \d+\. /, "")), location: null, reviewNote: null };
      rows[section].push(row);
    } else if (row && line.startsWith("- severity: ")) {
      row.severity = oneLine(line.slice("- severity: ".length), 20);
    } else if (row && line.startsWith("- reviewNote: ")) {
      row.reviewNote = oneLine(line.slice("- reviewNote: ".length));
    } else if (row && !row.location && line.startsWith("Location: ")) {
      row.location = oneLine(line.slice("Location: ".length), 120);
    }
  }
  return rows;
}

/** A plain-text list the agent pastes into its reply, since the human never sees tool output. */
export function findingsDigest(markdown: string): string | null {
  const rows = digestRows(markdown);
  const out: string[] = [];
  for (const [heading, list] of Object.entries(rows)) {
    if (list.length === 0) continue;
    out.push(`${heading} (${list.length}):`);
    list.slice(0, DIGEST_MAX_ROWS).forEach((row, i) => {
      const where = row.location ? ` (${row.location})` : "";
      const ask = row.reviewNote ? ` Question: ${row.reviewNote}` : "";
      out.push(`${i + 1}. [${row.severity}] ${row.title}${where}${ask}`);
    });
    if (list.length > DIGEST_MAX_ROWS) {
      out.push(`…and ${list.length - DIGEST_MAX_ROWS} more in the full report.`);
    }
    out.push("");
  }
  return out.length > 0 ? out.join("\n").trimEnd() : null;
}

/** The report on stdout, then (when there is something to fix) the question on stderr. Exit code stays 0. */
export function writeReport(deps: CliDeps, markdown: string): void {
  writeMarkdownReport(deps, markdown);
  const question = fixFindingsQuestion(markdown);
  if (!question) return;
  // The human does not see tool output: hand the agent the exact list to show.
  const digest = findingsDigest(markdown);
  const lead = digest
    ? [
        "The human cannot see the report above. Before you call any question tool, write the list below to the human as plain text in your reply, word for word. Only then ask the question. Do not edit code before they answer.",
        "",
        digest,
      ]
    : [
        "The human cannot see the report above. Before you call any question tool, list the findings in your reply: for each confirmed and needs-input finding, its severity, title and file, plus each needs-input finding's question. Only then ask the question. Do not edit code before they answer.",
      ];
  deps.io.stderr(
    `${["CLEANSLOP_ACTION_REQUIRED: fix_findings", "", ...lead, "", ...questionLines(question)].join("\n")}\n`
  );
}
