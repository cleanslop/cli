import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { CliError } from "../src/exit.js";
import {
  claudeMcpAddCommand,
  codexMcpAddCommand,
  codexMcpLoginCommand,
  mcpEndpoint,
  mergeMcpServers,
  parseJsonObject,
  removeMcpServer,
  writeMcpJson,
} from "../src/mcp-config.js";
import { makeDeps, tempHome } from "./helpers.js";

test("mcp-config merges and removes HTTP servers without writing tokens", () => {
  assert.equal(mcpEndpoint("https://app.example/"), "https://app.example/mcp");
  assert.equal(parseJsonObject("nope"), null);
  assert.equal(parseJsonObject("[1]"), null);
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  const merged = mergeMcpServers({ other: true }, "cleanslop", {
    url: "https://app.example/mcp",
  });
  assert.deepEqual(merged.mcpServers, {
    cleanslop: { type: "http", url: "https://app.example/mcp" },
  });
  const emptied = removeMcpServer(merged, "cleanslop");
  assert.equal(emptied.mcpServers, undefined);
  assert.deepEqual(removeMcpServer({ a: 1 }, "cleanslop"), { a: 1 });
  assert.match(
    claudeMcpAddCommand("https://app.example"),
    /claude mcp add --transport http --scope user cleanslop https:\/\/app.example\/mcp/
  );
  assert.match(codexMcpAddCommand("https://app.example"), /codex mcp add cleanslop --url/);
  assert.equal(codexMcpLoginCommand(), "codex mcp login cleanslop");
  const home = tempHome();
  const { deps } = makeDeps({ origin: "https://app.example", home });
  const path = join(home, "mcp.json");
  writeMcpJson(deps, path, (current) => ({ ...current, a: 1 }));
  assert.deepEqual(JSON.parse(deps.fs.read(path)), { a: 1 });
  assert.equal(deps.fs.statMode(path), 0o644);
  deps.fs.chmod(path, 0o600);
  writeMcpJson(deps, path, (current) => ({ ...current, b: 2 }));
  assert.equal(deps.fs.statMode(path), 0o600);
  assert.deepEqual(JSON.parse(deps.fs.read(path)), { a: 1, b: 2 });
  assert.throws(
    () => {
      deps.fs.write(path, "[1]", 0o644);
      writeMcpJson(deps, path, (current) => current);
    },
    (err: unknown) => err instanceof CliError && err.exitCode === 2
  );
});
