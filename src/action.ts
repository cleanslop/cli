import type { CliDeps } from "./deps.js";
import type { ActionQuestion, ActionRequired } from "./exit.js";
import { formatEtaLine } from "./output.js";
import type { AgentScan } from "./types.js";

export function writeAction(deps: CliDeps, action: ActionRequired): void {
  const lines = [
    `CLEANSLOP_ACTION_REQUIRED: ${action.kind}`,
    "",
    action.humanPrompt,
  ];
  if (action.url) {
    lines.push("", action.url);
  }
  if (action.code) {
    lines.push("", `Code: ${action.code}`);
  }
  if (action.question) {
    lines.push("", ...questionLines(action.question));
  }
  lines.push(
    "",
    "Never open, approve, or pay yourself. Never enter credentials or payment details."
  );
  deps.io.stderr(`${lines.join("\n")}\n`);
}

export const QUESTION_TOOL_HINT =
  "If you have a multiple-choice question tool (for example AskUserQuestion), you must ask this with it, offering exactly these options; do not ask the human to type a reply such as \"Done\". Only without such a tool, ask in plain text. Never answer for the human. Then do what the chosen option says: run its command, follow its next step, or stop.";

/** Numbered options, the machine-readable line, and how to ask. */
export function questionLines(question: ActionQuestion): string[] {
  const options = question.options.map((option, i) => {
    const detail = option.description ? ` (${option.description})` : "";
    const next = option.run
      ? ` → run: ${option.run}`
      : option.next
        ? ` → next: ${option.next}`
        : " → stop";
    return `  ${i + 1}. ${option.label}${detail}${next}`;
  });
  return [
    `Options:`,
    ...options,
    "",
    `CLEANSLOP_QUESTION: ${JSON.stringify(question)}`,
    "",
    QUESTION_TOOL_HINT,
  ];
}

export function writeResume(
  deps: CliDeps,
  scanId: string,
  scan?: Pick<AgentScan, "eta" | "elapsedSec">
): void {
  const eta = scan ? formatEtaLine(scan) : null;
  const head = eta ? `Still running (${eta}).` : "Still running.";
  deps.io.stderr(
    `${head} Resume with:\n  cleanslop status ${scanId} --wait\n`
  );
}
