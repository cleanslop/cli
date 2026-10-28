import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { credentialsPath, storeToken } from "../src/credentials.js";
import { isLinkSpendRequestNotFound, linkScopeTokens } from "../src/link.js";
import { LINK_CLI_NPX_TIMEOUT_MS, LINK_CLI_PACKAGE } from "../src/config.js";
import type { CliDeps } from "../src/deps.js";
import { ensureLinkAuth, runLinkCli } from "../src/link.js";
import { runCli } from "../src/main.js";
import { startFakeServer } from "./fake-server.js";
import {
  TEST_TOKEN,
  assertNoToken,
  makeDeps,
  questionFrom,
  tempHome,
} from "./helpers.js";

const FAKE_LINK_CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "fake-link-cli.mjs"
);
chmodSync(FAKE_LINK_CLI, 0o755);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
  for (const key of linkEnvKeys) delete process.env[key];
});

const linkEnvKeys = [
  "FAKE_LINK_MODE",
  "FAKE_LINK_AUTH",
  "FAKE_LINK_PRESENTATION",
  "FAKE_LINK_STATE",
] as const;

function linkEnv(extra: Record<string, string | undefined> = {}) {
  process.env.FAKE_LINK_MODE = extra.FAKE_LINK_MODE ?? "ok";
  if (extra.FAKE_LINK_AUTH) process.env.FAKE_LINK_AUTH = extra.FAKE_LINK_AUTH;
  if (extra.FAKE_LINK_PRESENTATION) {
    process.env.FAKE_LINK_PRESENTATION = extra.FAKE_LINK_PRESENTATION;
  }
  if (extra.FAKE_LINK_STATE) process.env.FAKE_LINK_STATE = extra.FAKE_LINK_STATE;
  return {
    CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
    ...extra,
  };
}

function noSecrets(text: string) {
  assertNoToken(text);
  assert.doesNotMatch(text, /lsk_test_secret_prefix/);
  assert.doesNotMatch(text, /aat-test-token/);
  assert.doesNotMatch(text, /presentation-sig/);
  assert.doesNotMatch(text, /eyJhbGciOiJFUzI1NiJ9/);
}

test("login --link stores the token and never prints Link secrets", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.match(cap.out(), /Connected as p\*\*\*@e\*\*\*.com \(Link\)/);
  noSecrets(cap.out() + cap.err());
  const stored = JSON.parse(deps.fs.read(credentialsPath(deps))) as {
    origins: Record<string, { token: string }>;
  };
  assert.equal(stored.origins[fake.origin]?.token, TEST_TOKEN);
  assert.equal(fake.state.linkStarts.length, 1);
  assert.equal(fake.state.linkCompletes.length, 1);
  const started = fake.state.linkStarts[0] as {
    authorization?: string;
    body?: { consentSource?: string };
  };
  assert.match(String(started.authorization), /PrivateToken/);
  assert.equal(started.body?.consentSource, "flag");
});

test("login --link revokes the token it replaces, after storing the new one", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  await storeToken(deps, fake.origin, {
    token: "cslop_agt_OLDLINK00000000000000000000000000zzzz",
    githubLogin: null,
    grantId: "grant_old_link",
  });
  const orig = deps.request;
  let storedNewBeforeRevoke = false;
  let revokeFails = true;
  deps.request = async (url, init) => {
    if (String(url).includes("/oauth/revoke")) {
      const stored = JSON.parse(deps.fs.read(credentialsPath(deps))) as {
        origins: Record<string, { token: string }>;
      };
      storedNewBeforeRevoke = stored.origins[fake.origin]?.token === TEST_TOKEN;
      if (revokeFails) {
        revokeFails = false;
        throw new Error("network down");
      }
    }
    return orig(url, init);
  };
  const args = ["login", "--link", "--accept-terms", "--yes-share-email"];
  // A failed revoke does not fail the login, but says the old token still works.
  assert.equal(await runCli(args, deps), 0, cap.err());
  assert.equal(storedNewBeforeRevoke, true);
  assert.equal(fake.state.revoked.length, 0);
  assert.match(cap.err(), /Could not revoke the previous CleanSlop token; it still works/);

  await storeToken(deps, fake.origin, {
    token: "cslop_agt_OLDLINK00000000000000000000000000zzzz",
    githubLogin: null,
    grantId: "grant_old_link",
  });
  assert.equal(await runCli(args, deps), 0, cap.err());
  assert.ok(fake.state.revoked.some((row) => row.includes("cslop_agt_OLDLINK")));
  noSecrets(cap.out() + cap.err());
});

test("isLinkSpendRequestNotFound reads link-cli NOT_FOUND JSON", () => {
  assert.equal(
    isLinkSpendRequestNotFound({
      ok: false,
      stdout: JSON.stringify({
        code: "NOT_FOUND",
        message: "Spend request lsrq_1 not found",
      }),
      stderr: "",
      code: 1,
    }),
    true
  );
  assert.equal(
    isLinkSpendRequestNotFound({
      ok: false,
      stdout: "",
      stderr: "could not retrieve spend request",
      code: 1,
    }),
    false
  );
});

test("linkScopeTokens splits Link status scope strings and arrays", () => {
  assert.deepEqual(linkScopeTokens("userinfo:read payment_methods.agentic"), [
    "userinfo:read",
    "payment_methods.agentic",
  ]);
  assert.deepEqual(linkScopeTokens(["payment_methods.agentic"]), [
    "payment_methods.agentic",
  ]);
  assert.deepEqual(linkScopeTokens(""), []);
  assert.deepEqual(linkScopeTokens(null), []);
});

test("login --link missing link-cli exits 10 with install guidance", async () => {
  const { deps, cap } = makeDeps({
    origin: "https://app.example",
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: { CLEANSLOP_LINK_CLI: "/no/such/link-cli" },
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 10);
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: ask_human/);
  assert.match(cap.err(), /link-cli/);
  noSecrets(cap.out() + cap.err());
});

test("login --link exits 10 when Link still issues no attestations after a refill", async () => {
  const { deps, cap } = makeDeps({
    origin: "https://app.example",
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "empty" }),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 10);
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: ask_human/);
  assert.match(cap.err(), /did not issue agent attestations/);
  assert.doesNotMatch(cap.err(), /link-cli identity/);
  noSecrets(cap.out() + cap.err());
});

function linkStateFile(home: string): string {
  return join(home, "fake-link-state.json");
}

function readLinkState(path: string): Record<string, number> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
}

test("login --link refills an empty attestation pool without asking the human", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = linkStateFile(home);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "empty-once", FAKE_LINK_STATE: statePath }),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.equal(readLinkState(statePath).attestationRequests, 1);
  assert.doesNotMatch(cap.err(), /CLEANSLOP_ACTION_REQUIRED/);
  noSecrets(cap.out() + cap.err());
});

test("login --link exits 10 when Link refuses the attestation refill", async () => {
  const { deps, cap } = makeDeps({
    origin: "https://app.example",
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "attest-request-fail" }),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 10);
  assert.match(cap.err(), /Link refused the attestation request/);
});

test("login --link requests a missing identity credential and retries", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = linkStateFile(home);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "no-saved-cred", FAKE_LINK_STATE: statePath }),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.equal(readLinkState(statePath).credentialRequests, 1);
  assert.match(cap.out(), /Connected as p\*\*\*@e\*\*\*.com \(Link\)/);
  noSecrets(cap.out() + cap.err());
});

test("login --link requests a new identity credential when the saved one expired", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = linkStateFile(home);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "expired-cred", FAKE_LINK_STATE: statePath }),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.equal(readLinkState(statePath).credentialRequests, 1);
  assert.match(cap.out(), /Connected as p\*\*\*@e\*\*\*.com \(Link\)/);
  noSecrets(cap.out() + cap.err());
});

test("login --link starts Link sign-in when link-cli is not authenticated", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = linkStateFile(home);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "unauth-then-ok", FAKE_LINK_STATE: statePath }),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 0, cap.err());
  const err = cap.err();
  assert.equal(err.match(/CLEANSLOP_ACTION_REQUIRED: approve/g)?.length, 1);
  assert.match(err, /https:\/\/app\.link\.com\/device\/setup\?code=test/);
  assert.match(err, /Code: apple-banana-cherry/);
  assert.equal(readLinkState(statePath).logins, 1);
  assert.equal(fake.state.linkStarts.length, 1);
  noSecrets(cap.out() + err);
});

test("login --link does not request payment_methods.agentic", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = linkStateFile(home);
  const loginArgs: string[][] = [];
  const presentArgs: string[][] = [];
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "unauth-then-ok", FAKE_LINK_STATE: statePath }),
  });
  const inner = deps.execFile;
  deps.execFile = async (file, args, opts) => {
    if (args[0] === "auth" && args[1] === "login") loginArgs.push([...args]);
    if (args[0] === "identity" && args[1] === "credentials" && args[2] === "present") {
      presentArgs.push([...args]);
    }
    return inner(file, args, opts);
  };
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.equal(loginArgs.length, 1);
  const scopeAt = loginArgs[0]!.indexOf("--scope");
  assert.notEqual(scopeAt, -1);
  assert.equal(loginArgs[0]![scopeAt + 1], "userinfo:read");
  assert.doesNotMatch(loginArgs[0]!.join(" "), /payment_methods/);
  assert.equal(presentArgs.length, 1);
  const presented: string[] = [];
  for (let i = 0; i < presentArgs[0]!.length; i++) {
    if (presentArgs[0]![i] === "--claim") presented.push(presentArgs[0]![i + 1] ?? "");
  }
  assert.deepEqual(presented, ["email", "email_verified"]);
  noSecrets(cap.out() + cap.err());
});

/** A session from a cold `credits buy` on an older CLI: payments, no sign-in scope. */
function paymentOnlySession(home: string): string {
  const statePath = linkStateFile(home);
  writeFileSync(statePath, JSON.stringify({ scope: "payment_methods.agentic" }));
  return statePath;
}

test("login --link adds the sign-in scope to a payment-only Link session", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = paymentOnlySession(home);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_STATE: statePath }),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 0, cap.err());
  const state = readLinkState(statePath) as unknown as { upgrades: number; lastScope: string };
  assert.equal(state.upgrades, 1);
  assert.equal(state.lastScope, "userinfo:read");
  const err = cap.err();
  assert.match(err, /https:\/\/app\.link\.com\/device\/setup\?code=upgrade/);
  assert.match(err, /approve CleanSlop in Link\./);
  assert.doesNotMatch(err, /Link payments/);
  assert.match(cap.out(), /Connected as p\*\*\*@e\*\*\*.com \(Link\)/);
  noSecrets(cap.out() + err);
});

test("login --link upgrades once when Link refuses attestations for a scope it did not report", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = paymentOnlySession(home);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "scope-hidden", FAKE_LINK_STATE: statePath }),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 0, cap.err());
  const state = readLinkState(statePath);
  assert.equal(state.upgrades, 1);
  assert.equal(state.attestationRequests, 1);
  assert.doesNotMatch(cap.err(), /missing required scopes/);
  assert.equal(fake.state.linkStarts.length, 1);
  noSecrets(cap.out() + cap.err());
});

test("login --link --resume starts the scope upgrade instead of polling for it", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = paymentOnlySession(home);
  const flags = ["login", "--link", "--accept-terms", "--yes-share-email", "--resume"];
  const env = () => linkEnv({ FAKE_LINK_MODE: "scope-hidden", FAKE_LINK_STATE: statePath });
  const first = makeDeps({ origin: fake.origin, home, stdinIsTTY: false, envExtra: env() });
  assert.equal(await runCli(flags, first.deps), 10);
  assert.match(first.cap.err(), /code=upgrade/);
  assert.match(first.cap.err(), /--resume instead of --no-wait/);
  assert.equal(fake.state.linkStarts.length, 0);

  const second = makeDeps({ origin: fake.origin, home, stdinIsTTY: false, envExtra: env() });
  assert.equal(await runCli(flags, second.deps), 0, second.cap.err());
  assert.equal(readLinkState(statePath).upgrades, 1);
  assert.match(second.cap.out(), /Connected as/);
  noSecrets(first.cap.out() + first.cap.err() + second.cap.out() + second.cap.err());
});

test("login --link offers GitHub when Link will not issue an identity credential", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "cred-request-fail" }),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 10);
  assert.match(cap.err(), /Link could not issue an identity credential/);
  assert.doesNotMatch(cap.err(), /pending CleanSlop request/);
  assert.equal(questionFrom(cap.err())?.id, "link_failed");
  noSecrets(cap.out() + cap.err());
});

test("login --link times out when the Link sign-in is never approved", async () => {
  const { deps, cap } = makeDeps({
    origin: "https://app.example",
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "unauth" }),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 10);
  assert.match(cap.err(), /Link approval timed out/);
  assert.match(cap.err(), /not completed in time/);
  noSecrets(cap.out() + cap.err());
});

test("login --link --no-wait prints the Link approval and --resume finishes it", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = linkStateFile(home);
  const flags = ["login", "--link", "--accept-terms", "--yes-share-email"];
  const first = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "unauth-then-ok", FAKE_LINK_STATE: statePath }),
  });
  assert.equal(await runCli([...flags, "--no-wait"], first.deps), 10);
  const err = first.cap.err();
  assert.equal(err.match(/CLEANSLOP_ACTION_REQUIRED: approve/g)?.length, 1);
  assert.match(err, /https:\/\/app\.link\.com\/device\/setup\?code=test/);
  assert.match(err, /Code: apple-banana-cherry/);
  assert.match(err, /--resume instead of --no-wait/);
  const question = questionFrom(err);
  assert.equal(question?.id, "link_approval");
  assert.match(question?.question ?? "", /code=test.*apple-banana-cherry.*approve CleanSlop in Link/);
  assert.match(question?.options[0]?.next ?? "", /--resume in place of --no-wait/);
  assert.equal(fake.state.linkStarts.length, 0);

  const second = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "unauth-then-ok", FAKE_LINK_STATE: statePath }),
  });
  assert.equal(await runCli([...flags, "--resume"], second.deps), 0, second.cap.err());
  assert.doesNotMatch(second.cap.err(), /CLEANSLOP_ACTION_REQUIRED/);
  assert.match(second.cap.out(), /Connected as p\*\*\*@e\*\*\*.com \(Link\)/);
  assert.equal(readLinkState(statePath).logins, 1);
  noSecrets(first.cap.out() + err + second.cap.out() + second.cap.err());
});

test("login --link --no-wait goes straight through when Link is signed in", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email", "--no-wait"],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.match(cap.out(), /Connected as/);
});

test("login --link --resume times out without starting a new Link sign-in", async () => {
  const home = tempHome();
  const statePath = linkStateFile(home);
  const { deps, cap } = makeDeps({
    origin: "https://app.example",
    home,
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "unauth", FAKE_LINK_STATE: statePath }),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email", "--resume"],
    deps
  );
  assert.equal(code, 10);
  assert.match(cap.err(), /Run `cleanslop login --link --no-wait` again for a new link/);
  // A Link sign-in would have written the fake's state file.
  assert.equal(existsSync(statePath), false);
});

test("login --link rejects combining --no-wait and --resume", async () => {
  const { deps, cap } = makeDeps({
    origin: "https://app.example",
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  const code = await runCli(["login", "--link", "--no-wait", "--resume"], deps);
  assert.equal(code, 2);
  assert.match(cap.err(), /either --no-wait or --resume/);
});

for (const [mode, pattern] of [
  ["auth-status-fail", /Link auth status failed/],
  ["auth-login-fail", /Link login failed/],
  ["auth-login-no-url", /did not return a Link approval link/],
] as const) {
  test(`login --link surfaces ${mode}`, async () => {
    const { deps, cap } = makeDeps({
      origin: "https://app.example",
      home: tempHome(),
      stdinIsTTY: false,
      envExtra: linkEnv({ FAKE_LINK_MODE: mode }),
    });
    const code = await runCli(
      ["login", "--link", "--accept-terms", "--yes-share-email"],
      deps
    );
    assert.notEqual(code, 0);
    assert.match(cap.err(), pattern);
  });
}

test("login --link refuses an audience mismatch", async () => {
  const fake = await startFakeServer((state) => {
    state.linkChallenge = {
      error: "identity_presentation_required",
      message: "present",
      aud: "https://other.example",
      nonce: "n",
      claims: ["email", "email_verified"],
      interaction_id: "ixn",
    };
  });
  cleanups.push(fake.close);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 10);
  assert.match(cap.err(), /audience/);
  noSecrets(cap.out() + cap.err());
});

test("login --link refuses extra claims", async () => {
  const fake = await startFakeServer();
  fake.state.linkChallenge = {
    error: "identity_presentation_required",
    message: "present",
    aud: fake.origin,
    nonce: "n",
    claims: ["email", "email_verified", "name"],
    interaction_id: "ixn",
  };
  cleanups.push(fake.close);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 10);
  assert.match(cap.err(), /claims/);
  noSecrets(cap.out() + cap.err());
});

/** Counts attestation pops so a test can tell how many sign-in attempts ran. */
function countPops(deps: CliDeps): () => number {
  let pops = 0;
  const inner = deps.execFile;
  deps.execFile = async (file, args, opts) => {
    if (args.includes("pop")) pops += 1;
    return inner(file, args, opts);
  };
  return () => pops;
}

test("login --link asks the terms only for a new account, after the Link email is presented", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  const pops = countPops(deps);
  const code = await runCli(["login", "--link"], deps);
  assert.equal(code, 10);
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: ask_human/);
  assert.match(cap.err(), new RegExp(`${fake.origin}/terms`));
  assert.match(
    cap.err(),
    /Create a CleanSlop account \(http:\/\/127\.0\.0\.1:\d+\) with your Link-verified email, and agree to the CleanSlop terms \(http:\/\/127\.0\.0\.1:\d+\/terms\)\?/
  );
  assert.equal(cap.err().match(/CLEANSLOP_ACTION_REQUIRED/g)?.length, 1);
  assert.doesNotMatch(cap.err(), /--agree|--accept-terms|--yes-share-email/);
  // The presentation went first, without terms; nothing was created.
  assert.equal(pops(), 1);
  const started = fake.state.linkStarts[0] as { body?: Record<string, unknown> };
  assert.equal(started.body?.acceptTerms, undefined);
  assert.equal(started.body?.consentSource, undefined);
  assert.equal(fake.state.linkCompletes.length, 1);
  const question = questionFrom(cap.err());
  assert.equal(question?.id, "link_signup_consent");
  assert.match(question?.question ?? "", /^Create a CleanSlop account/);
  assert.deepEqual(
    question?.options.map((o) => [o.value, o.run ?? null, Boolean(o.next)]),
    [
      ["yes", null, true],
      ["no", null, false],
    ]
  );
  assert.match(cap.err(), /1\. Yes → next: continue as your CleanSlop instructions say for a yes/);
});

test("login --link asks the terms when an older server refuses the first call without them", async () => {
  const fake = await startFakeServer((state) => {
    state.linkError = {
      status: 400,
      body: { error: "terms_required", message: "Accept the current CleanSlop terms to continue." },
    };
  });
  cleanups.push(fake.close);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  assert.equal(await runCli(["login", "--link"], deps), 10);
  assert.equal(questionFrom(cap.err())?.id, "link_signup_consent");
  assert.equal(fake.state.linkCompletes.length, 0);
});

test("login --link signs a returning Link user in without asking about terms", async () => {
  const fake = await startFakeServer((state) => {
    state.linkReturning = true;
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  const code = await runCli(["login", "--link"], deps);
  assert.equal(code, 0, cap.err());
  assert.doesNotMatch(cap.err(), /ask_human|terms/);
  assert.match(cap.out(), /Connected as p\*\*\*@e\*\*\*\.com \(Link\)/);
  const completed = fake.state.linkCompletes[0] as { body?: Record<string, unknown> };
  assert.equal(completed.body?.acceptTerms, undefined);
});

test("login --link --agree signs up without asking", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  const code = await runCli(["login", "--link", "--agree"], deps);
  assert.equal(code, 0, cap.err());
  assert.doesNotMatch(cap.err(), /ask_human/);
  const started = fake.state.linkStarts[0] as { body?: { consentSource?: string } };
  assert.equal(started.body?.consentSource, "flag");
});

test("login --link with only one legacy consent flag still asks the human", async () => {
  for (const flag of ["--accept-terms", "--yes-share-email"]) {
    const fake = await startFakeServer();
    cleanups.push(fake.close);
    const { deps, cap } = makeDeps({
      origin: fake.origin,
      home: tempHome(),
      stdinIsTTY: false,
      envExtra: linkEnv(),
    });
    assert.equal(await runCli(["login", "--link", flag], deps), 10, flag);
    assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: ask_human/);
  }
});

test("login --link declined terms exits 10 and creates nothing", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    stdinIsTTY: true,
    confirm: async () => false,
    envExtra: linkEnv(),
  });
  const pops = countPops(deps);
  const code = await runCli(["login", "--link"], deps);
  assert.equal(code, 10);
  assert.match(cap.err(), /Sign-up was declined/);
  assert.equal(pops(), 1);
  assert.equal(fake.state.linkCompletes.length, 1);
  noSecrets(cap.out() + cap.err());
});

test("login --link TTY terms consent asks once, then signs up with consentSource tty", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const asked: string[] = [];
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    stdinIsTTY: true,
    confirm: async (question) => {
      asked.push(question);
      return true;
    },
    envExtra: linkEnv(),
  });
  const code = await runCli(["login", "--link"], deps);
  assert.equal(code, 0, cap.err());
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /^Create a CleanSlop account .* with your Link-verified email, and agree to the CleanSlop terms/);
  // First attempt without terms, then a fresh one with them.
  const second = fake.state.linkStarts[1] as { body?: { consentSource?: string; acceptTerms?: string } };
  assert.equal(second.body?.consentSource, "tty");
  assert.ok(second.body?.acceptTerms);
});

test("login --link account_exists exits 10 with link_existing", async () => {
  const fake = await startFakeServer((state) => {
    state.linkCompleteError = {
      status: 409,
      body: {
        error: "account_exists",
        message: "A CleanSlop account already uses this email.",
        action: {
          kind: "link_existing",
          humanPrompt:
            "Sign in with npx @cleanslop/cli login (GitHub), then run npx @cleanslop/cli link-identity.",
        },
      },
    };
  });
  cleanups.push(fake.close);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 10);
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: link_existing/);
  assert.match(cap.err(), /link-identity/);
  const question = questionFrom(cap.err());
  assert.equal(question?.id, "link_existing");
  assert.match(question?.options[0]?.next ?? "", /cleanslop login --no-wait.*cleanslop link-identity --no-wait/);
  noSecrets(cap.out() + cap.err());
});

test("login --link link_pilot_required exits 12", async () => {
  const fake = await startFakeServer((state) => {
    state.linkCompleteError = {
      status: 403,
      body: {
        error: "link_pilot_required",
        message: "This email is not in the Link identity pilot.",
      },
    };
  });
  cleanups.push(fake.close);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  const code = await runCli(
    ["login", "--link", "--accept-terms", "--yes-share-email"],
    deps
  );
  assert.equal(code, 12);
  const err = cap.err();
  assert.match(err, /CLEANSLOP_ACTION_REQUIRED: beta/);
  assert.equal(err.match(/not in the CleanSlop Link pilot/g)?.length, 1);
});

test("link-identity completes the GitHub email bridge", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const home = tempHome();
  assert.equal(await runCli(["login"], makeDeps({ origin: fake.origin, home }).deps), 0);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  const code = await runCli(["link-identity", "--yes-share-email"], deps);
  assert.equal(code, 0, cap.err());
  assert.match(cap.out(), /Linked p\*\*\*@e\*\*\*.com/);
  assert.equal(fake.state.bridgeStarts.length, 1);
  assert.equal(fake.state.bridgeCompletes.length, 1);
  noSecrets(cap.out() + cap.err());
});

test("link-identity requests a new identity credential when the saved one expired", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const home = tempHome();
  assert.equal(await runCli(["login"], makeDeps({ origin: fake.origin, home }).deps), 0);
  const statePath = linkStateFile(home);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "expired-cred", FAKE_LINK_STATE: statePath }),
  });
  const code = await runCli(["link-identity", "--yes-share-email"], deps);
  assert.equal(code, 0, cap.err());
  assert.equal(readLinkState(statePath).credentialRequests, 1);
  assert.match(cap.out(), /Linked p\*\*\*@e\*\*\*.com/);
  assert.equal(fake.state.bridgeCompletes.length, 1);
  noSecrets(cap.out() + cap.err());
});

test("link-identity --resume names its own command on timeout", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  assert.equal(await runCli(["login"], makeDeps({ origin: fake.origin, home }).deps), 0);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv({ FAKE_LINK_MODE: "unauth" }),
  });
  const code = await runCli(["link-identity", "--yes-share-email", "--resume"], deps);
  assert.equal(code, 10);
  assert.match(cap.err(), /Run `cleanslop link-identity --no-wait` again/);
  assert.equal(fake.state.bridgeStarts.length, 0);
});

test("link-identity accepts --agree", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const home = tempHome();
  assert.equal(await runCli(["login"], makeDeps({ origin: fake.origin, home }).deps), 0);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  const code = await runCli(["link-identity", "--agree"], deps);
  assert.equal(code, 0, cap.err());
  assert.match(cap.out(), /Linked p\*\*\*@e\*\*\*.com/);
});

test("link-identity connects Link without a separate email question", async () => {
  const fake = await startFakeServer((state) => {
    state.emailMasked = "p***@e***.com";
  });
  cleanups.push(fake.close);
  const home = tempHome();
  assert.equal(await runCli(["login"], makeDeps({ origin: fake.origin, home }).deps), 0);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    stdinIsTTY: false,
    envExtra: linkEnv(),
  });
  const code = await runCli(["link-identity"], deps);
  assert.equal(code, 0, cap.err());
  assert.doesNotMatch(cap.err(), /ask_human|Connect your Link-verified email/);
  assert.match(cap.out(), /Linked p\*\*\*@e\*\*\*.com/);
});

test("generic Identity-Presentation 401 maps to present_identity", async () => {
  const fake = await startFakeServer((state) => {
    state.meStatus = 401;
  });
  cleanups.push(fake.close);
  const home = tempHome();
  assert.equal(await runCli(["login"], makeDeps({ origin: fake.origin, home }).deps), 0);
  fake.state.meStatus = 200;
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: { CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  const { throwHttpError } = await import("../src/http.js");
  try {
    throwHttpError({
      status: 401,
      headers: new Headers({
        "WWW-Authenticate": 'Identity-Presentation realm="link"',
      }),
      text: "",
      json: { error: "invalid_token", message: "Present identity." },
    });
    assert.fail("expected throw");
  } catch (err) {
    assert.equal((err as { exitCode: number }).exitCode, 10);
    assert.equal((err as { action?: { kind?: string } }).action?.kind, "present_identity");
  }
  noSecrets(cap.out() + cap.err());
});

type ExecCall = {
  file: string;
  args: string[];
  timeout: number | undefined;
  skipSkill: string | undefined;
};

function recordingExec(missing: string[]): {
  calls: ExecCall[];
  execFile: CliDeps["execFile"];
} {
  const calls: ExecCall[] = [];
  const execFile: CliDeps["execFile"] = async (file, args, opts) => {
    calls.push({
      file,
      args: [...args],
      timeout: opts?.timeout,
      skipSkill: opts?.env?.LINK_CLI_SKIP_SKILL_INSTALL,
    });
    if (missing.includes(file)) {
      return { ok: false, stdout: "", stderr: `spawn ${file} ENOENT`, code: 127 };
    }
    return {
      ok: true,
      stdout: JSON.stringify([{ authenticated: true }]),
      stderr: "",
      code: 0,
    };
  };
  return { calls, execFile };
}

test("runLinkCli uses link-cli on PATH and does not probe again", async () => {
  const rec = recordingExec([]);
  const { deps } = makeDeps({
    origin: "https://app.example",
    home: tempHome(),
    execFile: rec.execFile,
  });
  await runLinkCli(deps, ["auth", "status"]);
  await runLinkCli(deps, ["auth", "status"]);
  assert.deepEqual(
    rec.calls.map((call) => call.file),
    ["link-cli", "link-cli"]
  );
  assert.equal(rec.calls[0]!.skipSkill, "1");
});

test("runLinkCli falls back to the pinned npx link-cli when it is not on PATH", async () => {
  const rec = recordingExec(["link-cli"]);
  const { deps } = makeDeps({
    origin: "https://app.example",
    home: tempHome(),
    execFile: rec.execFile,
  });
  const first = await runLinkCli(deps, ["auth", "status", "--format", "json"]);
  assert.equal(first.ok, true);
  await runLinkCli(deps, ["identity", "attestations", "pop"]);
  assert.deepEqual(
    rec.calls.map((call) => call.file),
    ["link-cli", "npx", "npx"]
  );
  assert.deepEqual(rec.calls[1]!.args, [
    "--yes",
    "--package",
    LINK_CLI_PACKAGE,
    "--",
    "link-cli",
    "auth",
    "status",
    "--format",
    "json",
  ]);
  assert.equal(rec.calls[1]!.timeout, LINK_CLI_NPX_TIMEOUT_MS);
  assert.equal(rec.calls[1]!.skipSkill, "1");
  assert.match(LINK_CLI_PACKAGE, /^@stripe\/link-cli@\d+\.\d+\.\d+$/);
});

test("Link commands explain how to get link-cli when npx is missing too", async () => {
  const rec = recordingExec(["link-cli", "npx"]);
  const { deps } = makeDeps({
    origin: "https://app.example",
    home: tempHome(),
    execFile: rec.execFile,
  });
  await assert.rejects(ensureLinkAuth(deps), (err: unknown) => {
    assert.match((err as Error).message, /npx is unavailable/);
    const question = (err as { action?: { question?: { id: string } } }).action?.question;
    assert.equal(question?.id, "install_link_cli");
    return true;
  });
});

test("CLEANSLOP_LINK_CLI skips the PATH probe and the npx fallback", async () => {
  const rec = recordingExec(["/opt/link-cli"]);
  const { deps } = makeDeps({
    origin: "https://app.example",
    home: tempHome(),
    execFile: rec.execFile,
    envExtra: { CLEANSLOP_LINK_CLI: "/opt/link-cli" },
  });
  const result = await runLinkCli(deps, ["auth", "status"]);
  assert.equal(result.code, 127);
  assert.deepEqual(
    rec.calls.map((call) => call.file),
    ["/opt/link-cli"]
  );
});
