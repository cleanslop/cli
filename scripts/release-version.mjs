#!/usr/bin/env node
// Picks the version CI publishes for @cleanslop/cli (not shipped in the package).
//
//   node scripts/release-version.mjs release
//   node scripts/release-version.mjs beta <run-number> <run-attempt>
//
// A release is the next patch after the highest stable version on npm, or
// package.json's version when that is higher (bump it there for a minor or
// major). A beta is that same next version with `-beta.<run>[.<attempt>]`, so
// betas always sort above the current release.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

function parseStable(version) {
  const match = STABLE.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function nextStableVersion(published, floor) {
  let next = parseStable(floor);
  if (!next) {
    throw new Error(`package.json version ${floor} must be a plain x.y.z`);
  }
  const top = published
    .map(parseStable)
    .filter(Boolean)
    .sort(compare)
    .at(-1);
  if (top) {
    const bumped = [top[0], top[1], top[2] + 1];
    if (compare(bumped, next) > 0) next = bumped;
  }
  return next.join(".");
}

export function betaVersion(published, floor, run, attempt) {
  if (!/^\d+$/.test(String(run))) throw new Error(`run number ${run} must be digits`);
  const retry = attempt && String(attempt) !== "1" ? `.${attempt}` : "";
  return `${nextStableVersion(published, floor)}-beta.${run}${retry}`;
}

function publishedVersions(name) {
  try {
    const out = execFileSync(
      "npm",
      ["view", name, "versions", "--json", "--prefer-online"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    const text = `${err?.stdout ?? ""}${err?.stderr ?? ""}`;
    if (text.includes("E404")) return [];
    throw err;
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  const [mode, run, attempt] = process.argv.slice(2);
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  if (mode !== "release" && !(mode === "beta" && run)) {
    process.stderr.write(
      "Usage: release-version.mjs release | beta <run-number> <run-attempt>\n"
    );
    process.exit(2);
  }
  const published = publishedVersions(pkg.name);
  const version =
    mode === "release"
      ? nextStableVersion(published, pkg.version)
      : betaVersion(published, pkg.version, run, attempt);
  process.stdout.write(`${version}\n`);
}
