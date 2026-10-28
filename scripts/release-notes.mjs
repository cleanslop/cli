#!/usr/bin/env node
// Prints a release's notes from CHANGELOG.md, for its GitHub release (not
// shipped in the package).
//
//   node scripts/release-notes.mjs <version>
//
// A section starts at `## <version>` (optionally followed by ` - <date>`) and
// runs to the next `## ` heading. Prints nothing when there is no section (or
// it is empty), so the caller can flag the missing entry.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STABLE = /^\d+\.\d+\.\d+$/;

export function releaseNotes(changelog, version) {
  if (!STABLE.test(version)) {
    throw new Error(`version ${version} must be a plain x.y.z`);
  }
  const lines = changelog.split("\n");
  const heading = new RegExp(`^## ${version.replaceAll(".", "\\.")}(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const next = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  const body = lines
    .slice(start + 1, next === -1 ? undefined : next)
    .join("\n")
    .trim();
  return body || null;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    process.stderr.write("Usage: release-notes.mjs <version>\n");
    process.exit(2);
  }
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const notes = releaseNotes(changelog, version);
  if (notes) process.stdout.write(`${notes}\n`);
}
