#!/usr/bin/env node
// Refreshes test/fixtures/link-simulation.json from Stripe's own samples:
// `link-cli spend-request simulate` (link-cli 1.3+) prints the `next_action`
// Link returns in each scenario. It creates no spend request and needs a Link
// session or LINK_ACCESS_TOKEN. The tests read the saved copy, so they never
// run link-cli.
//
//   node scripts/link-simulation-fixtures.mjs [path-to-link-cli]
//
// The link-cli defaults to CLEANSLOP_LINK_CLI, else `link-cli` on PATH.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../test/fixtures/link-simulation.json", import.meta.url));
const linkCli = process.argv[2] ?? process.env.CLEANSLOP_LINK_CLI ?? "link-cli";

function exec(args) {
  return execFileSync(linkCli, args, {
    encoding: "utf8",
    env: { ...process.env, LINK_CLI_SKIP_SKILL_INSTALL: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function run(args) {
  const parsed = JSON.parse(exec(args));
  // link-cli prints one result item in an array.
  return Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
}

const version = /\d+\.\d+\.\d+\S*/.exec(exec(["--version"]))?.[0];
const catalog = run(["spend-request", "simulate", "--list-scenarios", "--format", "json"]);
if (catalog?.catalog_version !== 1 || !Array.isArray(catalog.data)) {
  throw new Error(`Unexpected scenario catalog: ${JSON.stringify(catalog).slice(0, 200)}`);
}
const scenarios = catalog.data.map((entry) => {
  const sample = run(["spend-request", "simulate", "--scenario", entry.id, "--format", "json"]);
  if (!sample || !("next_action" in sample)) {
    throw new Error(`Scenario ${entry.id} printed no next_action`);
  }
  return {
    id: entry.id,
    resolution: entry.resolution,
    url_kind: entry.url_kind,
    evidence_kind: entry.evidence_kind,
    // `error_next_action`: Link sends it in an HTTP error, not on a spend request.
    source_envelope: entry.source_envelope,
    next_action: sample.next_action,
  };
});

writeFileSync(
  OUT,
  `${JSON.stringify({ link_cli: version ?? null, catalog_version: 1, scenarios }, null, 2)}\n`
);
process.stdout.write(`Wrote ${scenarios.length} scenarios from link-cli ${version ?? "?"}.\n`);
