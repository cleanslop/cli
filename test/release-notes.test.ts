import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- plain .mjs CI helper without type declarations
import { releaseNotes } from "../scripts/release-notes.mjs";

const SAMPLE = `# Changelog

## 0.1.10

- Tenth.

## 0.1.1 - 2026-10-22

- First line.
- Second line.

## 0.1.0 and earlier

Old.
`;

test("returns the section for a version, with or without a date", () => {
  assert.equal(releaseNotes(SAMPLE, "0.1.10"), "- Tenth.");
  assert.equal(releaseNotes(SAMPLE, "0.1.1"), "- First line.\n- Second line.");
});

test("does not match a longer version or a missing one", () => {
  assert.equal(releaseNotes(SAMPLE, "0.1.2"), null);
  assert.equal(releaseNotes("## 0.1.10\n\n- x\n", "0.1.1"), null);
});

test("an empty section counts as missing", () => {
  assert.equal(releaseNotes("## 0.2.0\n\n## 0.1.0\n\n- x\n", "0.2.0"), null);
});

test("the version must be a plain x.y.z", () => {
  assert.throws(() => releaseNotes(SAMPLE, "0.1.1-beta.2"), /plain x\.y\.z/);
  assert.throws(() => releaseNotes(SAMPLE, "0x1x1"), /plain x\.y\.z/);
});

const CHANGELOG = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));

test("CHANGELOG.md headings are versions, newest first", () => {
  const headings = readFileSync(CHANGELOG, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("## "));
  const versions = headings.map((line) => {
    const match = /^## (\d+)\.(\d+)\.(\d+)( - \d{4}-\d{2}-\d{2}| and earlier)?$/.exec(line);
    assert.ok(match, `unexpected CHANGELOG heading: ${line}`);
    return match.slice(1, 4).map(Number);
  });
  for (let i = 1; i < versions.length; i += 1) {
    const [a, b] = [versions[i - 1]!, versions[i]!];
    const newer = a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
    assert.ok(newer > 0, `${headings[i - 1]} must come before ${headings[i]}`);
  }
});

test("prints the notes from the command line, or nothing", () => {
  const script = fileURLToPath(new URL("../scripts/release-notes.mjs", import.meta.url));
  const run = (version: string) =>
    execFileSync(process.execPath, [script, version], { encoding: "utf8" });
  assert.match(run("0.1.4"), /^- Open source under the MIT license/);
  assert.equal(run("9.9.9"), "");
});
