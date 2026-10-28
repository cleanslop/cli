import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN } from "../src/config.js";
import { runCli } from "../src/main.js";
import {
  assertSkillCoreComplete,
  loadSkillCore,
  renderAgentsSnippet,
  renderCursorMdc,
  renderSkillMd,
  skillCorePath,
} from "../src/skill.js";
import { makeDeps, tempHome } from "./helpers.js";

test("generated skill assets stay in sync with skill-core.md", () => {
  const core = loadSkillCore();
  const missing = assertSkillCoreComplete(core);
  assert.deepEqual(missing, []);
  const skill = renderSkillMd(core);
  const mdc = renderCursorMdc(core);
  const snippet = renderAgentsSnippet(core);
  for (const heading of [
    "When to scan",
    "Git preconditions",
    "Transport",
    "Relay human actions",
    "Waiting",
    "Reading the report",
    "Fix loop",
    "Stop conditions",
    "Report back",
    "Email",
    "Never print tokens",
  ]) {
    assert.match(skill, new RegExp(`## ${heading}`));
    assert.match(mdc, new RegExp(`## ${heading}`));
    assert.match(snippet, new RegExp(`## ${heading}`));
  }
  assert.match(skill, /cleanslop scan --wait 75m/);
  assert.doesNotMatch(skill, /npx -y cleanslop@/);
  assert.doesNotMatch(skill, /npx (-y )?cleanslop\b/);
  assert.match(skill, /^---\nname: cleanslop\n/);
  assert.match(mdc, /^---\ndescription:/);
  assert.doesNotMatch(skill, /<!-- cleanslop:begin/);
  assert.doesNotMatch(mdc, /<!-- cleanslop:begin/);
  assert.match(mdc, /CLEANSLOP_ACTION_REQUIRED/);
  assert.match(snippet, /<!-- cleanslop:begin v1 -->/);
  assert.match(snippet, /<!-- cleanslop:end -->/);
  assert.equal(readFileSync(skillCorePath(), "utf8").includes("## When to scan"), true);
});

test("setup --dry-run prints a plan and writes nothing", async () => {
  const home = tempHome();
  const { deps, cap } = makeDeps({
    origin: "https://app.cleanslop.com",
    home,
  });
  const code = await runCli(["setup", "--dry-run"], deps);
  assert.equal(code, 0);
  assert.match(cap.out(), /Claude Code skill/);
  assert.match(cap.out(), /never writes a token/);
  assert.match(cap.out(), /register MCP/);
  assert.match(cap.out(), /claude mcp add --transport http/);
  assert.equal(
    deps.fs.exists(join(home, ".claude", "skills", "cleanslop", "SKILL.md")),
    false
  );
});

test("setup is idempotent and uninstall removes markers", async () => {
  const home = tempHome();
  const first = makeDeps({ origin: "https://app.cleanslop.com", home });
  const skillPath = join(home, ".claude", "skills", "cleanslop", "SKILL.md");
  const cursorPath = join(home, ".cursor", "rules", "cleanslop.mdc");
  const codexPath = join(home, ".codex", "AGENTS.md");
  first.deps.fs.mkdir(join(home, ".codex"), 0o755);
  first.deps.fs.write(codexPath, "# Codex\n\nexisting notes\n", 0o644);
  assert.equal(await runCli(["setup", "--yes"], first.deps), 0);
  const second = makeDeps({ origin: "https://app.cleanslop.com", home });
  assert.equal(await runCli(["setup", "--yes"], second.deps), 0);
  assert.equal(await runCli(["setup", "--yes"], second.deps), 0);
  const skill = second.deps.fs.read(skillPath);
  const cursor = second.deps.fs.read(cursorPath);
  const codex = second.deps.fs.read(codexPath);
  assert.match(skill, /^---\nname: cleanslop\n/);
  assert.match(cursor, /^---\ndescription:/);
  assert.doesNotMatch(skill, /<!-- cleanslop:begin/);
  assert.doesNotMatch(cursor, /<!-- cleanslop:begin/);
  assert.match(codex, /existing notes/);
  assert.equal(codex.split("<!-- cleanslop:begin v1 -->").length - 1, 1);
  assert.match(skill, /Never print tokens/);
  const cursorMcp = JSON.parse(
    second.deps.fs.read(join(home, ".cursor", "mcp.json"))
  ) as { mcpServers: { cleanslop: { url: string } } };
  assert.equal(cursorMcp.mcpServers.cleanslop.url, "https://app.cleanslop.com/mcp");
  assert.equal(second.deps.fs.exists(join(home, ".claude.json")), false);

  const uninstall = makeDeps({ origin: "https://app.cleanslop.com", home });
  assert.equal(await runCli(["setup", "--uninstall", "--yes"], uninstall.deps), 0);
  assert.equal(uninstall.deps.fs.exists(skillPath), false);
  assert.equal(uninstall.deps.fs.exists(cursorPath), false);
  const leftover = uninstall.deps.fs.read(codexPath);
  assert.doesNotMatch(leftover, /cleanslop:begin/);
  assert.match(leftover, /existing notes/);
  const leftoverCursor = JSON.parse(
    uninstall.deps.fs.read(join(home, ".cursor", "mcp.json"))
  ) as { mcpServers?: unknown };
  assert.equal(leftoverCursor.mcpServers, undefined);
});

test("setup --uninstall skips a missing Cursor mcp.json", async () => {
  const home = tempHome();
  const mcpPath = join(home, ".cursor", "mcp.json");
  const { deps } = makeDeps({ origin: "https://app.cleanslop.com", home });
  assert.equal(await runCli(["setup", "--uninstall", "--yes"], deps), 0);
  assert.equal(deps.fs.exists(mcpPath), false);
});

test("setup non-TTY without --yes only prints the plan", async () => {
  const home = tempHome();
  const { deps, cap } = makeDeps({
    origin: "https://app.cleanslop.com",
    home,
    stdinIsTTY: false,
  });
  assert.equal(await runCli(["setup"], deps), 0);
  assert.match(cap.err(), /--yes/);
  assert.equal(
    deps.fs.exists(join(home, ".claude", "skills", "cleanslop", "SKILL.md")),
    false
  );
});

test("setup refuses to wipe invalid Cursor mcp.json", async () => {
  const home = tempHome();
  const mcpPath = join(home, ".cursor", "mcp.json");
  const { deps, cap } = makeDeps({ origin: "https://app.cleanslop.com", home });
  deps.fs.mkdir(join(home, ".cursor"), 0o755);
  deps.fs.write(mcpPath, "{not-json", 0o644);
  assert.equal(await runCli(["setup", "--yes"], deps), 2);
  assert.match(cap.err(), /invalid JSON/);
  assert.equal(deps.fs.read(mcpPath), "{not-json");
});

test("setup uses CLEANSLOP_ORIGIN, defaultOrigin, and the shipped default", async () => {
  const home = tempHome();
  const envOrigin = makeDeps({
    origin: "https://app.cleanslop.com",
    home,
    envExtra: { CLEANSLOP_ORIGIN: "https://staging.example" },
  });
  assert.equal(await runCli(["setup", "--dry-run"], envOrigin.deps), 0);
  assert.match(envOrigin.cap.out(), /https:\/\/staging\.example\/mcp/);

  const explicit = makeDeps({
    origin: "https://custom.example",
    home,
    envExtra: { CLEANSLOP_ORIGIN: undefined },
  });
  assert.equal(await runCli(["setup", "--dry-run"], explicit.deps), 0);
  assert.match(explicit.cap.out(), /https:\/\/custom\.example\/mcp/);
  assert.doesNotMatch(explicit.cap.out(), /staging\.example/);

  assert.equal(DEFAULT_ORIGIN, "https://cleanslop.com");
  const shipped = makeDeps({
    origin: DEFAULT_ORIGIN,
    home,
    envExtra: { CLEANSLOP_ORIGIN: undefined },
  });
  assert.equal(await runCli(["setup", "--dry-run"], shipped.deps), 0);
  assert.match(shipped.cap.out(), /https:\/\/cleanslop\.com\/mcp/);
});

test("setup --project writes Cursor rule and AGENTS.md", async () => {
  const home = tempHome();
  const cwd = join(home, "repo");
  const { deps } = makeDeps({
    origin: "https://app.cleanslop.com",
    home,
    cwd,
  });
  deps.fs.mkdir(cwd, 0o755);
  assert.equal(await runCli(["setup", "--project", "--yes"], deps), 0);
  assert.equal(deps.fs.exists(join(cwd, ".cursor", "rules", "cleanslop.mdc")), true);
  assert.match(deps.fs.read(join(cwd, "AGENTS.md")), /cleanslop:begin v1/);
  assert.equal(
    deps.fs.exists(join(home, ".claude", "skills", "cleanslop", "SKILL.md")),
    false
  );
});
