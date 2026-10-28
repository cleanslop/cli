import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  deleteOriginCreds,
  readCredentialsFile,
  writeCredentialsFile,
} from "../src/credentials.js";
import { createDefaultDeps } from "../src/deps.js";
import { CliError } from "../src/exit.js";
import { parseOrigin } from "../src/config.js";
import { inspectGit, isPathInsideWorktree, parseGithubRemote } from "../src/git.js";
import { parseArgs } from "../src/args.js";
import {
  asRecord,
  retryAfterMs,
  throwHttpError,
} from "../src/http.js";
import { dispatch, runCli } from "../src/main.js";
import { writeMarkdownReport } from "../src/output.js";
import { tokenLast4 } from "../src/redact.js";
import {
  removeMarkerBlock,
  upsertMarkerBlock,
  wrapOwnedFile,
} from "../src/skill.js";
import { backoffSleep, fetchScan, waitForScan } from "../src/wait.js";
import { startFakeServer } from "./fake-server.js";
import {
  TEST_TOKEN,
  gitStub,
  makeDeps,
  tempHome,
} from "./helpers.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

test("login error paths: start failure, invalid payload, timeout, bad token", async () => {
  const startFail = await startFakeServer((state) => {
    state.deviceStartError = {
      status: 503,
      body: { error: "capacity", message: "Too many pending." },
    };
  });
  cleanups.push(startFail.close);
  const a = makeDeps({ origin: startFail.origin, home: tempHome() });
  assert.equal(await runCli(["login"], a.deps), 1);

  const invalid = await startFakeServer((state) => {
    state.deviceOverride = { nope: true };
  });
  cleanups.push(invalid.close);
  const b = makeDeps({ origin: invalid.origin, home: tempHome() });
  assert.equal(await runCli(["login"], b.deps), 1);

  const timeout = await startFakeServer((state) => {
    state.expiresIn = 0;
    state.pendingPolls = 10_000;
  });
  cleanups.push(timeout.close);
  const c = makeDeps({ origin: timeout.origin, home: tempHome() });
  assert.equal(await runCli(["login"], c.deps), 10);

  const missingToken = await startFakeServer((state) => {
    state.tokenOverride = { token_type: "Bearer" };
  });
  cleanups.push(missingToken.close);
  const d = makeDeps({ origin: missingToken.origin, home: tempHome() });
  assert.equal(await runCli(["login"], d.deps), 1);

  const expired = await startFakeServer((state) => {
    state.tokenError = {
      status: 400,
      body: { error: "expired_token", error_description: "expired" },
    };
  });
  cleanups.push(expired.close);
  const e = makeDeps({ origin: expired.origin, home: tempHome() });
  assert.equal(await runCli(["login"], e.deps), 10);

  const other = await startFakeServer((state) => {
    state.tokenError = {
      status: 400,
      body: { error: "invalid_client", error_description: "nope" },
    };
  });
  cleanups.push(other.close);
  const f = makeDeps({ origin: other.origin, home: tempHome() });
  assert.equal(await runCli(["login"], f.deps), 10);
});

test("report not ready, status json/failed, whoami json, scan invalid create", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  assert.equal(await runCli(["login"], makeDeps({ origin: fake.origin, home }).deps), 0);

  fake.state.reportError = {
    status: 409,
    body: {
      error: "report_not_ready",
      message: "not yet",
      action: { kind: "wait", humanPrompt: "Wait." },
    },
  };
  const report = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["report", "scan_1"], report.deps), 75);
  assert.match(report.cap.err(), /cleanslop status scan_1 --wait/);

  fake.state.reportError = null;
  const who = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["whoami", "--json"], who.deps), 0);
  assert.match(who.cap.out(), /"tokenLast4":"abcd"/);

  const statusJson = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["status", "scan_1", "--json"], statusJson.deps), 0);
  assert.match(statusJson.cap.out(), /"id":"scan_1"/);

  fake.state.scan.status = "failed";
  fake.state.scan.final = true;
  fake.state.scan.error = { code: "scan_failed", message: "boom" };
  const statusFail = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["status", "scan_1"], statusFail.deps), 20);

  fake.state.scanError = { status: 200, body: { created: true } };
  const bad = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan"], bad.deps), 1);

  fake.state.scanError = null;
  fake.state.scan = {
    ...fake.state.scan,
    id: "scan_1",
    status: "done",
    final: true,
    error: null,
  };
  fake.state.reportError = {
    status: 409,
    body: {
      error: "report_not_ready",
      message: "not yet",
      action: { kind: "wait", humanPrompt: "Wait." },
    },
  };
  const later = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan"], later.deps), 75);
});

test("wait helpers, http extras, credentials, skill markers, default io", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const { deps } = makeDeps({ origin: fake.origin, home });

  fake.state.scanGetError = { status: 429, body: { error: "rate_limited" } };
  await assert.rejects(
    () => fetchScan(deps, fake.origin, TEST_TOKEN, "scan_1", 0),
    (err: unknown) => err instanceof CliError && err.exitCode === 75
  );

  fake.state.scanGetError = { status: 200, body: "not-json" };
  await assert.rejects(
    () => fetchScan(deps, fake.origin, TEST_TOKEN, "scan_1", 5),
    /not valid JSON/
  );

  fake.state.scanGetError = { status: 429, body: { error: "rate_limited" } };
  await assert.rejects(
    () => waitForScan(deps, fake.origin, TEST_TOKEN, "scan_1", 0),
    /Timed out/
  );

  fake.state.scanGetError = null;
  fake.state.scan.status = "done";
  fake.state.scan.final = false;
  fake.state.scan.progress = { phase: "review", label: "Reviewing" };
  const inner = deps.request;
  deps.request = async (url, init) => {
    const res = await inner(url, init);
    fake.state.scan.final = true;
    return res;
  };
  const done = await waitForScan(deps, fake.origin, TEST_TOKEN, "scan_1", 1000);
  assert.equal(done.final, true);
  deps.request = inner;
  fake.state.scan.status = "done";
  fake.state.scan.final = true;

  await backoffSleep(deps, 0);
  await backoffSleep(deps, 1, {
    status: 429,
    headers: new Headers({ "retry-after": "1" }),
    json: { action: { retryAfterSec: 1 } },
  });
  assert.equal(
    retryAfterMs(
      {
        status: 429,
        headers: new Headers({ "retry-after": "2" }),
        text: "",
        json: null,
      },
      100
    ),
    2000
  );
  assert.equal(
    retryAfterMs(
      {
        status: 429,
        headers: new Headers(),
        text: "",
        json: { action: { retryAfterSec: 3 } },
      },
      100
    ),
    3000
  );
  assert.equal(
    retryAfterMs(
      { status: 429, headers: new Headers(), text: "", json: {} },
      50
    ),
    50
  );

  assert.equal(asRecord(null), null);
  assert.equal(asRecord([1]), null);
  try {
    throwHttpError({
      status: 400,
      headers: new Headers(),
      text: "",
      json: { error: "authorization_pending", error_description: "wait" },
    });
  } catch (err) {
    assert.equal((err as CliError).exitCode, 10);
  }
  try {
    throwHttpError({
      status: 400,
      headers: new Headers(),
      text: "",
      json: { error: "slow_down" },
    });
  } catch (err) {
    assert.equal((err as CliError).exitCode, 10);
  }
  try {
    throwHttpError({
      status: 426,
      headers: new Headers(),
      text: "",
      json: { error: "cli_outdated", message: "Run npx -y @cleanslop/cli@latest" },
    });
  } catch (err) {
    assert.equal((err as CliError).exitCode, 2);
    assert.equal((err as CliError).message, "Run npx -y @cleanslop/cli@latest");
    assert.equal((err as CliError).action, undefined);
  }
  try {
    throwHttpError({
      status: 409,
      headers: new Headers(),
      text: "",
      json: { error: "scan_in_progress", message: "busy" },
    });
  } catch (err) {
    assert.equal((err as CliError).exitCode, 75);
  }
  try {
    throwHttpError({
      status: 401,
      headers: new Headers(),
      text: "",
      json: { message: "no code" },
    });
  } catch (err) {
    assert.equal((err as CliError).exitCode, 10);
  }
  try {
    throwHttpError({
      status: 402,
      headers: new Headers(),
      text: "",
      json: { message: "pay" },
    });
  } catch (err) {
    assert.equal((err as CliError).exitCode, 11);
  }
  try {
    throwHttpError({
      status: 403,
      headers: new Headers(),
      text: "",
      json: { message: "no" },
    });
  } catch (err) {
    assert.equal((err as CliError).exitCode, 12);
  }

  const path = join(home, ".config", "cleanslop", "credentials.json");
  deps.fs.mkdir(join(home, ".config", "cleanslop"), 0o700);
  deps.fs.write(path, "not-json", 0o600);
  assert.deepEqual(readCredentialsFile(deps).origins, {});
  deps.fs.write(path, JSON.stringify({ version: 2, origins: {} }), 0o600);
  assert.deepEqual(readCredentialsFile(deps).origins, {});
  deps.fs.write(path, JSON.stringify(null), 0o600);
  assert.deepEqual(readCredentialsFile(deps).origins, {});

  await writeCredentialsFile(deps, {
    version: 1,
    origins: {
      "https://a.example": {
        token: "cslop_agt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111",
        last4: "1111",
      },
      [fake.origin]: { token: TEST_TOKEN, last4: "abcd" },
    },
  });
  await deleteOriginCreds(deps, fake.origin);
  assert.equal(readCredentialsFile(deps).origins[fake.origin], undefined);
  assert.ok(readCredentialsFile(deps).origins["https://a.example"]);
  await deleteOriginCreds(deps, "https://missing.example");
  assert.ok(readCredentialsFile(deps).origins["https://a.example"]);

  assert.match(wrapOwnedFile("<!-- cleanslop:begin v1 -->\nhi\n<!-- cleanslop:end -->"), /hi/);
  assert.equal(removeMarkerBlock("no markers"), "no markers");
  const updated = upsertMarkerBlock("intro\n", "<!-- cleanslop:begin v1 -->\nB\n<!-- cleanslop:end -->\n");
  assert.match(updated, /intro/);
  const replaced = upsertMarkerBlock(updated, "<!-- cleanslop:begin v1 -->\nC\n<!-- cleanslop:end -->\n");
  assert.match(replaced, /C/);
  assert.doesNotMatch(replaced, /\nB\n/);

  writeMarkdownReport(deps, "no-newline");
  assert.equal(tokenLast4("ab"), "ab");
  assert.equal(parseGithubRemote("git://github.com/acme/app"), null);
  assert.equal(parseOrigin("   "), null);
  assert.equal(parseOrigin("https://app.cleanslop.com/path"), null);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["-v"]).version, true);
  assert.equal(isPathInsideWorktree("/repo/file", "/repo/"), true);
  assert.equal(isPathInsideWorktree("/repo-other/file", "/repo/"), false);
  const wtBase = mkdtempSync(join(tmpdir(), "cleanslop-wt-real-"));
  cleanups.push(() => {
    rmSync(wtBase, { recursive: true, force: true });
  });
  const realRoot = join(wtBase, "real");
  mkdirSync(realRoot);
  const linkRoot = join(wtBase, "link");
  symlinkSync(realRoot, linkRoot);
  assert.equal(isPathInsideWorktree(join(linkRoot, "creds.json"), realRoot), true);
  assert.equal(
    isPathInsideWorktree(join(linkRoot, "missing", "creds.json"), realRoot),
    true
  );
  assert.equal(
    isPathInsideWorktree(join(wtBase, "outside", "creds.json"), realRoot),
    false
  );
  const noHead = makeDeps({
    origin: fake.origin,
    home,
    git: async (args) => {
      if (args.join(" ") === "rev-parse HEAD") {
        return { ok: false, stdout: "", stderr: "bad", code: 1 };
      }
      return gitStub()(args, home);
    },
  });
  await assert.rejects(() => inspectGit(noHead.deps), /HEAD/);
  const noContains = makeDeps({
    origin: fake.origin,
    home,
    git: async (args) => {
      if (args.join(" ").startsWith("branch -r")) {
        return { ok: false, stdout: "", stderr: "bad", code: 1 };
      }
      return gitStub()(args, home);
    },
  });
  const snap = await inspectGit(noContains.deps);
  assert.equal(snap.unpushed, true);

  const real = createDefaultDeps();
  real.io.stdout(`redact ${TEST_TOKEN}\n`);
  real.io.stderr("e\n");
  const tmp = tempHome();
  writeFileSync(join(tmp, "mode"), "x");
  real.fs.chmod(join(tmp, "mode"), 0o600);
  await real.clock.sleep(1);

  const cap = makeDeps({ origin: fake.origin, home });
  await dispatch(cap.deps, {
    command: "nope" as never,
    help: false,
    version: false,
    id: null,
    json: false,
    wait: false,
    waitMs: 1,
    noWait: false,
    resume: false,
    force: false,
    preview: false,
    format: "md",
    dryRun: false,
    uninstall: false,
    project: false,
    yes: false,
    consent: null,
    reply: null,
    link: false,
    acceptTerms: false,
    yesShareEmail: false,
  }).catch(() => undefined);

  const thrown = makeDeps({
    origin: fake.origin,
    home,
    envExtra: { CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  thrown.deps.git = async () => {
    throw new Error("unexpected git crash");
  };
  assert.equal(await runCli(["scan"], thrown.deps), 1);
});
