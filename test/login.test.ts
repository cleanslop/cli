import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { credentialsPath, pendingLoginPath, pendingSpendPath } from "../src/credentials.js";
import type { CliDeps } from "../src/deps.js";
import { runCli } from "../src/main.js";
import { startFakeServer } from "./fake-server.js";
import {
  TEST_TOKEN,
  assertNoToken,
  gitStub,
  makeDeps,
  questionFrom,
  tempHome,
} from "./helpers.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

test("login stores 0600 credentials and never prints the token", async () => {
  const fake = await startFakeServer((state) => {
    state.pendingPolls = 1;
    state.slowDownOnce = true;
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub(),
  });
  const code = await runCli(["login"], deps);
  assert.equal(code, 0);
  assert.match(cap.out(), /Connected as @octocat/);
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: approve/);
  assert.match(cap.err(), /WDJB-MJHT/);
  assert.match(cap.err(), /verification|connect\/WDJB-MJHT/);
  assertNoToken(cap.out() + cap.err());
  assert.doesNotMatch(cap.out() + cap.err(), new RegExp(TEST_TOKEN));

  const path = credentialsPath(deps);
  assert.equal(deps.fs.statMode(path), 0o600);
  assert.equal(deps.fs.statMode(join(home, ".config", "cleanslop")), 0o700);
  const stored = JSON.parse(deps.fs.read(path)) as {
    origins: Record<string, { token: string; last4: string }>;
  };
  assert.equal(stored.origins[fake.origin]?.token, TEST_TOKEN);
  assert.equal(stored.origins[fake.origin]?.last4, "abcd");
});

test("login --no-wait prints the link, stores the device code, and exits 10", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const { deps, cap } = makeDeps({ origin: fake.origin, home: tempHome() });
  const code = await runCli(["login", "--no-wait"], deps);
  assert.equal(code, 10);
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: approve/);
  assert.match(cap.err(), /WDJB-MJHT/);
  const question = questionFrom(cap.err());
  assert.equal(question?.id, "github_approval");
  assert.match(question?.question ?? "", /WDJB-MJHT/);
  assert.deepEqual(
    question?.options.map((o) => [o.label, o.run ?? null]),
    [
      ["Done", "cleanslop login --resume"],
      ["Not now", null],
    ]
  );
  assert.equal(deps.fs.exists(credentialsPath(deps)), false);
  assert.equal(deps.fs.exists(pendingLoginPath(deps)), true);
  assertNoToken(cap.out() + cap.err());
});

test("login --resume finishes a pending --no-wait device login", async () => {
  const fake = await startFakeServer((state) => {
    state.pendingPolls = 1;
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const first = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login", "--no-wait"], first.deps), 10);
  const second = makeDeps({ origin: fake.origin, home });
  const code = await runCli(["login", "--resume"], second.deps);
  assert.equal(code, 0);
  assert.match(second.cap.out(), /Connected as @octocat/);
  assert.equal(second.deps.fs.exists(pendingLoginPath(second.deps)), false);
  assert.equal(second.deps.fs.exists(credentialsPath(second.deps)), true);
  assertNoToken(second.cap.out() + second.cap.err());
});

test("login --resume without a pending device code exits 10", async () => {
  const { deps, cap } = makeDeps({ origin: "https://app.example", home: tempHome() });
  const code = await runCli(["login", "--resume"], deps);
  assert.equal(code, 10);
  assert.match(cap.err(), /pending device login/);
});

test("login rejects combining --no-wait and --resume", async () => {
  const { deps, cap } = makeDeps({ origin: "https://app.example", home: tempHome() });
  const code = await runCli(["login", "--no-wait", "--resume"], deps);
  assert.equal(code, 2);
  assert.match(cap.err(), /either --no-wait or --resume/);
});

test("login keeps polling authorization_pending through the /connect TTL extend", async () => {
  const fake = await startFakeServer((state) => {
    state.pendingPolls = 2;
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const { deps, cap, clock } = makeDeps({ origin: fake.origin, home });
  const { writePendingLogin } = await import("../src/credentials.js");
  const { devicePollDeadline } = await import("../src/commands/login.js");
  const expiresAt = clock.now() - 60_000;
  assert.ok(clock.now() < devicePollDeadline(expiresAt));
  await writePendingLogin(deps, {
    version: 1,
    origin: fake.origin,
    deviceCode: "grace",
    userCode: "WDJB-MJHT",
    verificationUriComplete: `${fake.origin}/connect/WDJB-MJHT`,
    expiresAt,
    interval: 5,
  });
  const code = await runCli(["login", "--resume"], deps);
  assert.equal(code, 0);
  assert.match(cap.out(), /Connected as @octocat/);
});

test("login stores the new token before revoking the prior one", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const first = makeDeps({ origin: fake.origin, home });
  const { storeToken } = await import("../src/credentials.js");
  await storeToken(first.deps, fake.origin, {
    token: "cslop_agt_OLDTOKEN0000000000000000000000000zzzz",
    githubLogin: "old",
    grantId: "grant_old",
  });
  const orig = first.deps.request;
  let storedNewBeforeRevoke = false;
  first.deps.request = async (url, init) => {
    if (String(url).includes("/oauth/revoke")) {
      const stored = JSON.parse(first.deps.fs.read(credentialsPath(first.deps))) as {
        origins: Record<string, { token: string }>;
      };
      storedNewBeforeRevoke = stored.origins[fake.origin]?.token === TEST_TOKEN;
    }
    return orig(url, init);
  };
  const code = await runCli(["login"], first.deps);
  assert.equal(code, 0);
  assert.equal(storedNewBeforeRevoke, true);
  assert.ok(
    fake.state.revoked.some((row) => row.includes("cslop_agt_OLDTOKEN"))
  );
});

test("login --resume expires a stale pending device code", async () => {
  const home = tempHome();
  const { deps, cap } = makeDeps({ origin: "https://app.example", home });
  const { writePendingLogin } = await import("../src/credentials.js");
  await writePendingLogin(deps, {
    version: 1,
    origin: "https://app.example",
    deviceCode: "stale",
    userCode: "WDJB-MJHT",
    verificationUriComplete: "https://app.example/connect/WDJB-MJHT",
    expiresAt: 1,
    interval: 5,
  });
  const code = await runCli(["login", "--resume"], deps);
  assert.equal(code, 10);
  assert.match(cap.err(), /expired/);
  assert.equal(deps.fs.exists(pendingLoginPath(deps)), false);
});

test("login refuses a credentials path inside the git worktree", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const repo = mkdtempSync(join(tmpdir(), "cleanslop-wt-"));
  cleanups.push(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  const init = spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  mkdirSync(join(repo, ".xdg"), { recursive: true });
  const realGit = (await import("../src/deps.js")).createDefaultDeps().git;
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home: repo,
    cwd: repo,
    envExtra: { XDG_CONFIG_HOME: join(repo, ".xdg") },
    git: realGit,
  });
  const code = await runCli(["login"], deps);
  assert.equal(code, 2);
  assert.match(cap.err(), /worktree/);
});

test("login retries a token poll network error and 5xx", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub(),
  });
  const orig = deps.request;
  let polls = 0;
  deps.request = async (url, init) => {
    if (url.includes("/oauth/token")) {
      polls += 1;
      if (polls === 1) throw new Error("ECONNRESET");
      if (polls === 2) {
        return new Response(JSON.stringify({ error: "upstream" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return orig(url, init);
  };
  const code = await runCli(["login"], deps);
  assert.equal(code, 0);
  assert.ok(polls >= 3);
  assert.match(cap.out(), /Connected as @octocat/);
});

test("login access_denied exits 10", async () => {
  const fake = await startFakeServer((state) => {
    state.approved = false;
  });
  cleanups.push(fake.close);
  const { deps } = makeDeps({ origin: fake.origin, home: tempHome() });
  const code = await runCli(["login"], deps);
  assert.equal(code, 10);
});

test("logout revokes the bearer and deletes local creds", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const { deps } = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], deps), 0);
  assert.equal(deps.fs.exists(credentialsPath(deps)), true);
  const again = makeDeps({ origin: fake.origin, home });
  const code = await runCli(["logout"], again.deps);
  assert.equal(code, 0);
  assert.match(again.cap.out(), /Disconnected/);
  assert.equal(fake.state.revoked.length, 1);
  assert.match(fake.state.revoked[0] ?? "", /Bearer cslop_agt_/);
  assert.equal(again.deps.fs.exists(credentialsPath(again.deps)), false);
});

test("logout warns when revoke fails and keeps file creds when CLEANSLOP_TOKEN is set", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const login = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], login.deps), 0);

  const failing = makeDeps({ origin: fake.origin, home });
  failing.deps.request = async () =>
    new Response(JSON.stringify({ error: "upstream" }), { status: 500 });
  assert.equal(await runCli(["logout"], failing.deps), 1);
  assert.match(
    failing.cap.out(),
    /Removed local credentials, but the server did not confirm revocation\. Revoke this agent under Account → Connected agents\./
  );
  assert.equal(failing.deps.fs.exists(credentialsPath(failing.deps)), false);

  const loginAgain = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], loginAgain.deps), 0);
  const envLogout = makeDeps({
    origin: fake.origin,
    home,
    envExtra: { CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  assert.equal(await runCli(["logout"], envLogout.deps), 0);
  assert.match(
    envLogout.cap.out(),
    /Disconnected\. File credentials were left in place because CLEANSLOP_TOKEN is set\./
  );
  assert.equal(envLogout.deps.fs.exists(credentialsPath(envLogout.deps)), true);

  const netFail = makeDeps({
    origin: fake.origin,
    home,
    envExtra: { CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  netFail.deps.request = async () => {
    throw new Error("ECONNRESET");
  };
  assert.equal(await runCli(["logout"], netFail.deps), 0);
  assert.match(netFail.cap.err(), /Could not revoke the token for .+: Network error/);
  assert.equal(netFail.deps.fs.exists(credentialsPath(netFail.deps)), true);
});

const OTHER_ORIGIN = "https://other.example";

function savePending(deps: CliDeps, loginOrigin: string, spendOrigin: string) {
  deps.fs.mkdir(dirname(credentialsPath(deps)), 0o700);
  deps.fs.write(
    pendingLoginPath(deps),
    JSON.stringify({
      version: 1,
      origin: loginOrigin,
      deviceCode: "dev",
      userCode: "WDJB-MJHT",
      verificationUriComplete: `${loginOrigin}/connect`,
      expiresAt: Date.now() + 60_000,
      interval: 5,
    }),
    0o600
  );
  deps.fs.write(
    pendingSpendPath(deps),
    JSON.stringify({
      version: 1,
      origin: spendOrigin,
      spendRequestId: "lsrq_test",
      pack: "p5",
      amount: 2000,
      currency: "usd",
      networkId: "profile_test",
      purchaseUrl: `${spendOrigin}/api/agent/v1/credits/purchases`,
      createdAt: Date.now(),
    }),
    0o600
  );
}

test("logout drops this origin's pending Link payment and keeps another origin's login", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const { deps } = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], deps), 0);
  savePending(deps, OTHER_ORIGIN, fake.origin);
  const out = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["logout"], out.deps), 0);
  assert.equal(out.deps.fs.exists(pendingSpendPath(out.deps)), false);
  assert.equal(out.deps.fs.exists(pendingLoginPath(out.deps)), true);

  // A pending file that no longer parses goes with any logout.
  out.deps.fs.write(pendingSpendPath(out.deps), "not json", 0o600);
  savePending(out.deps, fake.origin, OTHER_ORIGIN);
  const again = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["logout"], again.deps), 0);
  assert.equal(again.deps.fs.exists(pendingLoginPath(again.deps)), false);
  assert.equal(again.deps.fs.exists(pendingSpendPath(again.deps)), true);
});

test("logout --all revokes every origin's token and deletes all local data", async () => {
  const first = await startFakeServer();
  const second = await startFakeServer();
  cleanups.push(first.close, second.close);
  const home = tempHome();
  assert.equal(await runCli(["login"], makeDeps({ origin: first.origin, home }).deps), 0);
  const secondLogin = makeDeps({ origin: second.origin, home });
  assert.equal(await runCli(["login"], secondLogin.deps), 0);
  savePending(secondLogin.deps, first.origin, second.origin);

  const all = makeDeps({ origin: first.origin, home });
  assert.equal(await runCli(["logout", "--all"], all.deps), 0, all.cap.err());
  assert.match(all.cap.out(), /Disconnected everywhere and removed all local CleanSlop data\.\n$/);
  assert.equal(first.state.revoked.length, 1);
  assert.equal(second.state.revoked.length, 1);
  for (const path of [
    credentialsPath(all.deps),
    pendingLoginPath(all.deps),
    pendingSpendPath(all.deps),
  ]) {
    assert.equal(all.deps.fs.exists(path), false, path);
  }
  assertNoToken(all.cap.out() + all.cap.err());
});

test("logout --all still deletes local data when an origin does not confirm revocation", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  assert.equal(await runCli(["login"], makeDeps({ origin: fake.origin, home }).deps), 0);
  const all = makeDeps({ origin: fake.origin, home, envExtra: { CLEANSLOP_TOKEN: TEST_TOKEN } });
  all.deps.request = async () => new Response("{}", { status: 500 });
  assert.equal(await runCli(["logout", "--all"], all.deps), 1);
  assert.match(all.cap.err(), /Could not revoke the token for .+ \(HTTP 500\)/);
  assert.match(all.cap.out(), /did not confirm revocation\. Revoke this agent under Account → Connected agents\./);
  assert.match(all.cap.out(), /CLEANSLOP_TOKEN is still set/);
  assert.equal(all.deps.fs.exists(credentialsPath(all.deps)), false);

  // Nothing saved: still a clean exit.
  const empty = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["logout", "--all"], empty.deps), 0);
});
