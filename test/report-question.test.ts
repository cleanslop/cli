import assert from "node:assert/strict";
import { test } from "node:test";
import { findingsDigest, fixFindingsQuestion, writeReport } from "../src/report-question.js";
import { makeDeps, questionFrom, tempHome } from "./helpers.js";

function md(opts: { final?: boolean; confirmed: number; needsInput?: number }): string {
  return [
    `<!-- cleanslop:v1 scan=scan_1 final=${opts.final === false ? "false" : "true"} confirmed=${opts.confirmed} new=0 resolved=0 -->`,
    "",
    "## Summary",
    "",
    "| Metric | Count |",
    "| --- | ---: |",
    `| Confirmed | ${opts.confirmed} |`,
    ...(opts.needsInput === undefined ? [] : [`| Needs input | ${opts.needsInput} |`]),
    "",
  ].join("\n");
}

test("a finished report with confirmed findings asks fix, show first, or not now", () => {
  const question = fixFindingsQuestion(md({ confirmed: 10, needsInput: 3 }));
  assert.equal(question?.id, "fix_findings");
  assert.equal(question?.question, "Fix the 10 confirmed findings now? 3 more need your input.");
  assert.deepEqual(question?.options.map((o) => o.value), ["fix", "plan", "stop"]);
  assert.match(question?.options[0]?.next ?? "", /rescan once/);
  assert.match(question?.options[1]?.next ?? "", /ask the human before editing any file/);

  assert.equal(fixFindingsQuestion(md({ confirmed: 1, needsInput: 1 }))?.question, "Fix the 1 confirmed finding now? 1 more needs your input.");
  assert.equal(fixFindingsQuestion(md({ confirmed: 2, needsInput: 0 }))?.question, "Fix the 2 confirmed findings now?");
  assert.equal(fixFindingsQuestion(md({ confirmed: 2 }))?.question, "Fix the 2 confirmed findings now?");
});

test("only needs-input findings ask to go through them", () => {
  const many = fixFindingsQuestion(md({ confirmed: 0, needsInput: 4 }));
  assert.equal(many?.question, "4 findings need your input. Go through them now?");
  assert.deepEqual(many?.options.map((o) => o.value), ["review", "stop"]);
  assert.equal(
    fixFindingsQuestion(md({ confirmed: 0, needsInput: 1 }))?.question,
    "1 finding needs your input. Go through it now?"
  );
});

test("nothing to fix, a preview, or an unrecognized report asks nothing", () => {
  assert.equal(fixFindingsQuestion(md({ confirmed: 0, needsInput: 0 })), null);
  assert.equal(fixFindingsQuestion(md({ final: false, confirmed: 5, needsInput: 2 })), null);
  assert.equal(fixFindingsQuestion("# Some other markdown\n"), null);
});

test("writeReport prints the report on stdout before the question on stderr", () => {
  const { deps, cap } = makeDeps({ origin: "http://127.0.0.1:1", home: tempHome() });
  writeReport(deps, md({ confirmed: 2, needsInput: 0 }));
  assert.match(cap.out(), /\| Confirmed \| 2 \|/);
  assert.doesNotMatch(cap.out(), /CLEANSLOP_QUESTION/);
  assert.match(cap.err(), /^CLEANSLOP_ACTION_REQUIRED: fix_findings/);
  assert.match(cap.err(), /The human cannot see the report above\. Before you call any question tool, list the findings/);
  assert.match(cap.err(), /Only then ask the question\. Do not edit code before they answer\./);
  assert.equal(questionFrom(cap.err())?.id, "fix_findings");

  const quiet = makeDeps({ origin: "http://127.0.0.1:1", home: tempHome() });
  writeReport(quiet.deps, md({ confirmed: 0, needsInput: 0 }));
  assert.equal(quiet.cap.err(), "");
});

function finding(n: number, title: string, opts: { severity?: string; location?: string; reviewNote?: string } = {}): string[] {
  return [
    `### ${n}. ${title}`,
    "",
    "- id: `f`",
    `- severity: ${opts.severity ?? "high"}`,
    ...(opts.reviewNote ? [`- reviewNote: ${opts.reviewNote}`] : []),
    "",
    "Summary text.",
    "",
    "Recommendation text.",
    ...(opts.location ? ["", `Location: ${opts.location}`, "```", "### 9. not a finding", "Location: fake.ts:1", "```"] : []),
    "",
  ];
}

const FULL = [
  md({ confirmed: 2, needsInput: 1 }),
  "## Confirmed",
  "",
  ...finding(1, "SQL built from user input", { severity: "critical", location: "src/db.ts:10-14" }),
  ...finding(2, "Missing   rate  limit", { location: "src/api.ts:3" }),
  "## Needs input",
  "",
  ...finding(1, "Public bucket", { severity: "medium", reviewNote: "Is this bucket meant to be public?" }),
  "## Suspected",
  "",
  ...finding(1, "Maybe unused export", { severity: "low", location: "src/x.ts:1" }),
  "## Next steps",
  "",
  "- Fix by priority",
].join("\n");

test("findingsDigest lists confirmed and needs-input findings, not suspected ones", () => {
  assert.equal(
    findingsDigest(FULL),
    [
      "Confirmed (2):",
      "1. [critical] SQL built from user input (src/db.ts:10-14)",
      "2. [high] Missing rate limit (src/api.ts:3)",
      "",
      "Needs input (1):",
      "1. [medium] Public bucket Question: Is this bucket meant to be public?",
    ].join("\n")
  );
  assert.equal(findingsDigest(md({ confirmed: 2, needsInput: 0 })), null);
});

test("findingsDigest caps each section and shortens long titles", () => {
  const rows = Array.from({ length: 23 }, (_, i) => finding(i + 1, i === 0 ? "x".repeat(200) : `Issue ${i + 1}`)).flat();
  const digest = findingsDigest([md({ confirmed: 23 }), "## Confirmed", "", ...rows].join("\n")) ?? "";
  assert.match(digest, /^Confirmed \(23\):/);
  assert.match(digest, /^1\. \[high\] x{159}…$/m);
  assert.match(digest, /^20\. \[high\] Issue 20$/m);
  assert.doesNotMatch(digest, /Issue 21/);
  assert.match(digest, /…and 3 more in the full report\.$/);
});

test("writeReport hands the agent the list to show word for word", () => {
  const { deps, cap } = makeDeps({ origin: "http://127.0.0.1:1", home: tempHome() });
  writeReport(deps, FULL);
  assert.match(cap.err(), /write the list below to the human as plain text in your reply, word for word\. Only then ask the question\./);
  assert.match(cap.err(), /\n\nConfirmed \(2\):\n1\. \[critical\] SQL built from user input \(src\/db\.ts:10-14\)\n/);
  assert.ok(cap.err().indexOf("Public bucket") < cap.err().indexOf("CLEANSLOP_QUESTION:"));
  assert.doesNotMatch(cap.err(), /Maybe unused export/);
  assert.equal(questionFrom(cap.err())?.id, "fix_findings");
});
