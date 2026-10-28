import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_MARKER_BEGIN, SKILL_MARKER_END } from "./config.js";

export const SKILL_HEADINGS = [
  "When to scan",
  "Git preconditions",
  "Transport",
  "Connect",
  "Buy credits with Link",
  "Relay human actions",
  "Waiting",
  "Reading the report",
  "Fix loop",
  "Stop conditions",
  "Report back",
  "Email",
  "Never print tokens",
] as const;

export function skillCorePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "skill-core.md");
}

export function loadSkillCore(readFile: (path: string) => string = defaultRead): string {
  return readFile(skillCorePath()).replace(/\s+$/, "") + "\n";
}

function defaultRead(path: string): string {
  return readFileSync(path, "utf8");
}

export function renderSkillMd(core: string): string {
  const body = core.trim();
  return [
    "---",
    "name: cleanslop",
    "description: Run a CleanSlop readiness scan before claiming a change is done. Use at milestones, before a PR, or when asked to scan.",
    "---",
    "",
    "# CleanSlop",
    "",
    body,
    "",
  ].join("\n");
}

export function renderCursorMdc(core: string): string {
  const body = core.trim();
  return [
    "---",
    "description: CleanSlop readiness scan — run before claiming work is done",
    "alwaysApply: true",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

export function renderAgentsSnippet(core: string): string {
  const body = core.trim();
  return [
    SKILL_MARKER_BEGIN,
    "",
    "## CleanSlop readiness scan",
    "",
    body,
    "",
    SKILL_MARKER_END,
    "",
  ].join("\n");
}

export function wrapOwnedFile(content: string): string {
  const trimmed = content.replace(/\s+$/, "");
  if (trimmed.includes(SKILL_MARKER_BEGIN) && trimmed.includes(SKILL_MARKER_END)) {
    return `${trimmed}\n`;
  }
  return `${SKILL_MARKER_BEGIN}\n${trimmed}\n${SKILL_MARKER_END}\n`;
}

export function upsertMarkerBlock(existing: string, block: string): string {
  const begin = existing.indexOf(SKILL_MARKER_BEGIN);
  const end = existing.indexOf(SKILL_MARKER_END);
  if (begin >= 0 && end > begin) {
    const afterEnd = end + SKILL_MARKER_END.length;
    const before = existing.slice(0, begin);
    let after = existing.slice(afterEnd);
    if (after.startsWith("\n")) after = after.slice(1);
    const prefix = before.endsWith("\n") || before.length === 0 ? before : `${before}\n`;
    return `${prefix}${block}${after.startsWith("\n") || after.length === 0 ? after : `\n${after}`}`;
  }
  const prefix =
    existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  const spacer = prefix.length === 0 || prefix.endsWith("\n\n") ? "" : "\n";
  return `${prefix}${spacer}${block}`;
}

export function removeMarkerBlock(existing: string): string {
  const begin = existing.indexOf(SKILL_MARKER_BEGIN);
  const end = existing.indexOf(SKILL_MARKER_END);
  if (begin < 0 || end < begin) return existing;
  const afterEnd = end + SKILL_MARKER_END.length;
  const before = existing.slice(0, begin);
  let after = existing.slice(afterEnd);
  if (after.startsWith("\n")) after = after.slice(1);
  return `${before}${after}`.replace(/\n{3,}/g, "\n\n");
}

export function assertSkillCoreComplete(core: string): string[] {
  const missing: string[] = [];
  for (const heading of SKILL_HEADINGS) {
    if (!core.includes(`## ${heading}`)) missing.push(heading);
  }
  return missing;
}
