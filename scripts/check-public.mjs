#!/usr/bin/env node
// Fails when the CLI tree names something that only exists upstream: deploy
// hosts, the upstream repo, Linear tickets, or app paths. The tree is mirrored
// to a public repo, so this runs in `npm test` and again on the mirrored copy.
//
//   node scripts/check-public.mjs [dir]
//
// The patterns use character classes so this file doesn't match itself.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage"]);

export const PATTERNS = [
  { pattern: /h[c]to/i, reason: "upstream repo or deploy name" },
  { pattern: /prototype[.]cleanslop/i, reason: "non-production deploy" },
  { pattern: /s[h]bvca/i, reason: "upstream GitHub owner" },
  { pattern: /\bC[L]E-\d+/, reason: "Linear ticket" },
  { pattern: /docs[/](architecture|ops|launch)[/]/, reason: "upstream docs path" },
  { pattern: /src[/](lib|app)[/]/, reason: "upstream app path" },
];

function* walk(dir, root) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name), root);
    } else if (entry.isFile()) {
      yield path.relative(root, path.join(dir, entry.name));
    }
  }
}

export function findLeaks(root) {
  const leaks = [];
  for (const file of walk(root, root)) {
    const text = readFileSync(path.join(root, file), "utf8");
    if (text.includes("\0")) continue;
    // Line 0 is the file's own path.
    const lines = [file, ...text.split("\n")];
    lines.forEach((line, i) => {
      for (const { pattern, reason } of PATTERNS) {
        const match = line.match(pattern);
        if (match) leaks.push({ file, line: i, match: match[0], reason });
      }
    });
  }
  return leaks;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  const root = path.resolve(
    process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url))
  );
  const leaks = findLeaks(root);
  for (const { file, line, match, reason } of leaks) {
    const where = line === 0 ? `${file} (path)` : `${file}:${line}`;
    process.stderr.write(`${where}: "${match}" (${reason})\n`);
  }
  if (leaks.length > 0) {
    process.stderr.write(
      "This tree is mirrored to a public repo; remove the references above.\n"
    );
    process.exit(1);
  }
}
