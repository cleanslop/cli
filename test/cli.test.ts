import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { parseArgs, parseWaitMs } from "../src/args.js";
import { PACKAGE_NAME, PACKAGE_VERSION, parseOrigin } from "../src/config.js";
import { configDir, storeToken } from "../src/credentials.js";
import { createDefaultDeps } from "../src/deps.js";
import { CliError, EXIT_USAGE } from "../src/exit.js";
import { detectAgentHint, parseGithubRemote } from "../src/git.js";
import { throwHttpError } from "../src/http.js";
import { runCli } from "../src/main.js";
import { resetAskEmailPrintedForTests } from "../src/output.js";
import { redactSecrets } from "../src/redact.js";
import { clampPollMs } from "../src/wait.js";
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
  resetAskEmailPrintedForTests();
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

test("parseArgs: default scan, wait durations, and usage errors", () => {
  assert.equal(parseArgs([]).command, "scan");
  assert.equal(parseArgs(["email", "s1", "--consent", "ask e***@s***.com?"]).consent, "ask e***@s***.com?");
  assert.equal(parseArgs(["email", "s1", "--reply", "yes"]).reply, "yes");
  assert.throws(() => parseArgs(["email", "--consent"]), /--consent/);
  assert.throws(() => parseArgs(["email", "--reply"]), /--reply/);
  assert.equal(parseArgs(["login", "--no-wait"]).noWait, true);
  assert.equal(parseArgs(["login", "--resume"]).resume, true);
  assert.equal(parseArgs(["login", "--link"]).link, true);
  assert.equal(parseArgs(["login", "--link", "--accept-terms"]).acceptTerms, true);
  assert.equal(parseArgs(["login", "--link", "--agree"]).agree, true);
  assert.equal(parseArgs(["login", "--link"]).agree, false);
  assert.equal(parseArgs(["link-identity", "--yes-share-email"]).yesShareEmail, true);
  assert.equal(parseArgs(["link-identity"]).command, "link-identity");
  assert.equal(parseArgs(["credits", "buy", "--link", "--pack", "p15"]).pack, "p15");
  assert.equal(parseArgs(["credits", "buy", "--amount", "1000"]).amount, 1000);
  assert.equal(parseArgs(["credits", "buy", "--network-id", "profile_test"]).networkId, "profile_test");
  assert.equal(parseArgs(["credits", "buy", "--spend-request-id", "sr_1"]).spendRequestId, "sr_1");
  assert.throws(() => parseArgs(["credits", "buy", "--pack", "nope"]), /--pack/);
  assert.throws(() => parseArgs(["credits", "buy", "--amount", "0"]), /--amount/);
  assert.throws(() => parseArgs(["credits", "buy", "--network-id"]), /--network-id/);
  assert.throws(() => parseArgs(["credits", "buy", "--spend-request-id"]), /--spend-request-id/);
  assert.equal(parseArgs(["--wait"]).wait, true);
  assert.equal(parseArgs(["--wait"]).waitMs, 8 * 60 * 1000);
  assert.equal(parseArgs(["--wait", "75m"]).waitMs, 75 * 60 * 1000);
  assert.equal(parseWaitMs("30s"), 30_000);
  assert.equal(parseWaitMs("1h"), 3600_000);
  assert.equal(parseArgs(["report", "abc", "--format", "json"]).json, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["--version"]).version, true);
  assert.throws(() => parseArgs(["--nope"]), (err: Error) => err.message.includes("Unknown flag"));
  assert.throws(() => parseArgs(["--format", "xml"]), /format/);
  assert.throws(() => parseArgs(["status", "a", "b"]), /extra/);
  assert.throws(() => parseWaitMs("nope"), /Invalid --wait/);
});

test("help and version", async () => {
  const { deps, cap } = makeDeps({ origin: "https://app.cleanslop.com", home: tempHome() });
  assert.equal(await runCli(["--help"], deps), 0);
  assert.match(cap.out(), /cleanslop/);
  assert.match(cap.out(), /8 minutes/);
  assert.match(cap.out(), /credits buy --link/);
  assert.match(cap.out(), /Price and network id come from CleanSlop/);
  assert.doesNotMatch(cap.out(), /--amount|--network-id|--spend-request-id/);
  assert.doesNotMatch(cap.out(), /CLEANSLOP_STRIPE_PROFILE_ID/);
  assert.doesNotMatch(cap.out(), /CLEANSLOP_LINK_TEST/);
  const v = makeDeps({ origin: "https://app.cleanslop.com", home: tempHome() });
  assert.equal(await runCli(["--version"], v.deps), 0);
  assert.equal(v.cap.out(), `@cleanslop/cli ${PACKAGE_VERSION}\n`);
});

test("PACKAGE_NAME and PACKAGE_VERSION match package.json (CI stamps both)", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { name: string; version: string };
  assert.equal(PACKAGE_NAME, pkg.name);
  assert.equal(PACKAGE_VERSION, pkg.version);
});

test("email previews the prompt and records consent", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const login = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], login.deps), 0);

  const preview = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["email", "scan_1"], preview.deps), 10);
  assert.match(preview.cap.out(), /Should CleanSlop email this report/);
  const question = questionFrom(preview.cap.err());
  assert.equal(question?.id, "scan_email");
  assert.match(
    question?.options[0]?.run ?? "",
    /^cleanslop email scan_1 --consent 'Should CleanSlop email this report to .+\?' --reply yes$/
  );

  const jsonPreview = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["email", "scan_1", "--json"], jsonPreview.deps), 0);
  assert.match(jsonPreview.cap.out(), /recipientMasked/);

  const granted = makeDeps({ origin: fake.origin, home });
  assert.equal(
    await runCli(
      ["email", "scan_1", "--consent", "Should CleanSlop email this report to o***@e***.com?", "--reply", "yes"],
      granted.deps
    ),
    0
  );
  assert.match(granted.cap.out(), /Email consent recorded/);
  assert.equal(fake.state.emailPosts.length, 1);

  const scan = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan"], scan.deps), 0);
  const jsonGrant = makeDeps({ origin: fake.origin, home });
  assert.equal(
    await runCli(
      ["email", "--json", "--consent", "Should CleanSlop email this report to o***@e***.com?"],
      jsonGrant.deps
    ),
    0
  );
  assert.match(jsonGrant.cap.out(), /emailDoneAlert/);

  fake.state.emailPost = { emailDoneAlert: true, sends: "now" };
  const nowSend = makeDeps({ origin: fake.origin, home });
  assert.equal(
    await runCli(
      ["email", "scan_1", "--consent", "Should CleanSlop email this report to o***@e***.com?"],
      nowSend.deps
    ),
    0
  );
  assert.match(nowSend.cap.out(), /will send now/);

  const fresh = tempHome();
  const noIdLogin = makeDeps({ origin: fake.origin, home: fresh });
  assert.equal(await runCli(["login"], noIdLogin.deps), 0);
  const missingId = makeDeps({ origin: fake.origin, home: fresh });
  assert.equal(await runCli(["email"], missingId.deps), 2);

  const quoteFail = await startFakeServer((state) => {
    state.emailError = {
      status: 422,
      body: {
        error: "prompt_must_quote_recipient",
        message: "promptText must quote the masked recipient.",
      },
    };
  });
  cleanups.push(quoteFail.close);
  const qHome = tempHome();
  const qLogin = makeDeps({ origin: quoteFail.origin, home: qHome });
  assert.equal(await runCli(["login"], qLogin.deps), 0);
  const q = makeDeps({ origin: quoteFail.origin, home: qHome });
  assert.equal(await runCli(["email", "scan_1", "--consent", "wrong"], q.deps), 2);
});

test("whoami shows last4 only; unexpected errors exit 1", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const login = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], login.deps), 0);
  const who = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["whoami"], who.deps), 0);
  assert.match(who.cap.out(), /Connected as @octocat/);
  assert.match(who.cap.out(), /token …abcd/);
  assert.doesNotMatch(who.cap.out(), /billing/);
  assertNoToken(who.cap.out());

  fake.state.webBilling = { url: `${fake.origin}/signin/email`, emailMasked: "s***@p***.io" };
  const linkWho = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["whoami"], linkWho.deps), 0);
  assert.match(linkWho.cap.out(), /billing on the web: run `cleanslop billing`/);
  const linkJson = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["whoami", "--json"], linkJson.deps), 0);
  assert.deepEqual(JSON.parse(linkJson.cap.out()).webBilling, fake.state.webBilling);

  // Link plans on, free plan: point at `cleanslop plan`; billing is for credits.
  fake.state.meQuota = { plan: "free", planName: "Free", scanLimit: 1, remaining: 1 };
  fake.state.linkPlans = true;
  const free = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["whoami"], free.deps), 0);
  assert.match(free.cap.out(), /plan Free \(1 scan per month\)/);
  assert.match(free.cap.out(), /start a monthly plan with Link: run `cleanslop plan`/);
  assert.match(free.cap.out(), /billing on the web: run `cleanslop billing` to buy credits\n/);
  const freeJson = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["whoami", "--json"], freeJson.deps), 0);
  assert.equal(JSON.parse(freeJson.cap.out()).linkPlans, true);

  // On a paid plan: name it and send changes to `cleanslop billing`.
  fake.state.meQuota = { plan: "team", planName: "Max", scanLimit: 500, remaining: 480 };
  const paid = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["whoami"], paid.deps), 0);
  assert.match(paid.cap.out(), /plan Max \(500 scans per month\)/);
  assert.match(paid.cap.out(), /manage your Max plan or buy credits on the web: run `cleanslop billing`/);
  assert.doesNotMatch(paid.cap.out(), /cleanslop plan`/);

  // Paid plan without web billing (GitHub account): plan line only.
  fake.state.webBilling = null;
  fake.state.linkPlans = false;
  fake.state.meQuota = { plan: "pro", remaining: 100 };
  const github = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["whoami"], github.deps), 0);
  assert.match(github.cap.out(), /plan pro\n/);
  assert.doesNotMatch(github.cap.out(), /billing/);
  fake.state.meQuota = { plan: "free", remaining: 3 };

  const missing = makeDeps({ origin: fake.origin, home: tempHome() });
  assert.equal(await runCli(["whoami"], missing.deps), 10);

  const revoked = makeDeps({ origin: fake.origin, home });
  fake.state.meStatus = 401;
  assert.equal(await runCli(["whoami"], revoked.deps), 10);

  const boom = makeDeps({ origin: fake.origin, home });
  boom.deps.request = async () => {
    throw new Error("socket hang up");
  };
  assert.equal(await runCli(["whoami"], boom.deps), 1);
});

test("billing has the server email the sign-in link to a Link account", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const login = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], login.deps), 0);
  const run = async (argv: string[]) => {
    const { deps, cap } = makeDeps({ origin: fake.origin, home });
    const code = await runCli(argv, deps);
    return { code, out: cap.out(), err: cap.err() };
  };

  // No webBilling: the route 404s and /me has none either.
  const none = await run(["billing"]);
  assert.equal(none.code, 0);
  assert.match(none.out, /Not available for this account/);
  const noneJson = await run(["billing", "--json"]);
  assert.equal(noneJson.code, 0);
  assert.deepEqual(JSON.parse(noneJson.out), { webBilling: null });

  fake.state.webBilling = {
    url: `${fake.origin}/signin/email?from=agent`,
    emailMasked: "s***@p***.io",
  };
  const sent = await run(["billing"]);
  assert.equal(sent.code, 10);
  assert.match(sent.err, /CLEANSLOP_ACTION_REQUIRED: ask_human/);
  assert.match(sent.err, /We emailed a sign-in link to s\*\*\*@p\*\*\*\.io\. Open it to subscribe/);
  assert.match(sent.err, /No email\? Go to http:\/\/127\.0\.0\.1:\d+\/signin\/email\?from=agent and enter s\*\*\*@p\*\*\*\.io\./);
  const sentQ = questionFrom(sent.err);
  assert.equal(sentQ?.id, "web_billing");
  assert.match(sentQ?.question ?? "", /Open the sign-in link we emailed to s\*\*\*@p\*\*\*\.io/);
  assert.deepEqual(sentQ?.options.map((o) => o.value), ["done", "link", "stop"]);
  assert.match(sentQ?.options[0]?.next ?? "", /rerun the scan that ran out of scans/);
  assert.equal(sentQ?.options[1]?.run, "cleanslop credits buy --link --no-wait");

  // No Link packs on offer: no "Buy with Link instead".
  fake.state.offers = { payment: { methods: [] } };
  assert.deepEqual(
    questionFrom((await run(["billing"])).err)?.options.map((o) => o.value),
    ["done", "stop"]
  );
  fake.state.offers = null;

  const sentJson = await run(["billing", "--json"]);
  assert.equal(sentJson.code, 10);
  assert.deepEqual(JSON.parse(sentJson.out), {
    sent: true,
    expiresAt: "2026-10-16T12:15:00.000Z",
    webBilling: fake.state.webBilling,
  });
  assertNoToken(sent.out + sent.err + sentJson.out);

  fake.state.billingLinkReply = {
    status: 200,
    body: { sent: false, reason: "rate_limited", webBilling: fake.state.webBilling },
  };
  const limited = await run(["billing"]);
  assert.equal(limited.code, 10);
  assert.match(limited.err, /Sign-in links already went to s\*\*\*@p\*\*\*\.io in the last 15 minutes/);
  assert.match(questionFrom(limited.err)?.question ?? "", /Open the newest sign-in link/);

  fake.state.billingLinkReply = {
    status: 200,
    body: { sent: false, reason: "email_unavailable", webBilling: fake.state.webBilling },
  };
  const typed = await run(["billing"]);
  assert.equal(typed.code, 10);
  assert.match(typed.err, /go to http:\/\/127\.0\.0\.1:\d+\/signin\/email\?from=agent and enter s\*\*\*@p\*\*\*\.io/);
  const typedJson = await run(["billing", "--json"]);
  assert.deepEqual(JSON.parse(typedJson.out), {
    sent: false,
    reason: "email_unavailable",
    webBilling: fake.state.webBilling,
  });

  fake.state.billingLinkReply = { status: 200, body: { sent: false, webBilling: null } };
  assert.match((await run(["billing"])).out, /Not available for this account/);

  // An older server has no route: read webBilling from /me and type the address.
  fake.state.billingLinkReply = { status: 404, body: { error: "not_found" } };
  const old = await run(["billing"]);
  assert.equal(old.code, 10);
  assert.match(old.err, /go to .*\/signin\/email\?from=agent and enter s\*\*\*@p\*\*\*\.io/);
  assert.match(questionFrom(old.err)?.question ?? "", /^Go to .*\/signin\/email\?from=agent, enter s\*\*\*@p\*\*\*\.io/);
  const oldJson = await run(["billing", "--json"]);
  assert.deepEqual(JSON.parse(oldJson.out), {
    sent: false,
    reason: null,
    webBilling: fake.state.webBilling,
  });

  fake.state.billingLinkReply = { status: 500, body: { error: "boom" } };
  assert.notEqual((await run(["billing"])).code, 0);
  assert.equal(fake.state.billingLinkPosts, 12);
});

test("status and report use the last scan id", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const login = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], login.deps), 0);
  const scan = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan"], scan.deps), 0);

  const status = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["status"], status.deps), 0);
  assert.match(status.cap.err(), /id=scan_1/);

  const report = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["report", "--format", "md"], report.deps), 0);
  assert.match(report.cap.out(), /<!-- cleanslop:v1/);
  // A finished report with a confirmed finding still exits 0, then asks.
  assert.equal(questionFrom(report.cap.err())?.id, "fix_findings");

  const reportJson = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["report", "--json"], reportJson.deps), 0);
  assert.match(reportJson.cap.out(), /cleanslop\.report\.v1/);
  assert.doesNotMatch(reportJson.cap.err(), /fix_findings/);
  // The CLI cannot page, so every report request asks for the whole list.
  assert.ok(fake.state.reportQueries.length >= 3);
  for (const query of fake.state.reportQueries) {
    assert.equal(new URLSearchParams(query).get("limit"), "250");
  }
});

test("status --wait times out at 75 when the scan stays running", async () => {
  const fake = await startFakeServer((state) => {
    state.scan.status = "running";
    state.scan.final = false;
    state.scan.pollAfterSec = 3;
    state.scan.elapsedSec = 540;
    state.scan.eta = { minSec: 360, maxSec: 720 };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const login = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], login.deps), 0);
  await storeToken(login.deps, fake.origin, {
    token: TEST_TOKEN,
    githubLogin: "octocat",
    grantId: "grant_1",
  });
  const file = JSON.parse(login.deps.fs.read(
    (await import("../src/credentials.js")).credentialsPath(login.deps)
  )) as { origins: Record<string, { lastScanId?: string }> };
  file.origins[fake.origin]!.lastScanId = "scan_1";
  login.deps.fs.write(
    (await import("../src/credentials.js")).credentialsPath(login.deps),
    `${JSON.stringify(file, null, 2)}\n`,
    0o600
  );
  const status = makeDeps({
    origin: fake.origin,
    home,
    defaultWaitMs: 40,
    minPollMs: 10,
  });
  assert.equal(await runCli(["status", "scan_1", "--wait"], status.deps), 75);
  assert.match(status.cap.err(), /ETA 6–12 min/);
  assert.match(status.cap.err(), /cleanslop status scan_1 --wait/);
});

test("scan start and status omit scan_wait next.message", async () => {
  const waitMessage =
    "Scan scan_1 is in first pass (about 10–15 min left, 9 min elapsed). Call scan_wait again.";
  const fake = await startFakeServer((state) => {
    state.scan.status = "running";
    state.scan.final = false;
    state.scan.elapsedSec = 540;
    state.scan.eta = { minSec: 600, maxSec: 900 };
    state.scan.next = {
      action: "scan_wait",
      afterSec: 10,
      message: waitMessage,
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const login = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], login.deps), 0);
  const scan = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan"], scan.deps), 75);
  assert.equal(scan.cap.err().includes("Call scan_wait again"), false);
  assert.match(scan.cap.err(), /cleanslop status scan_1 --wait/);
  assert.equal(scan.cap.err().includes("CLEANSLOP_ACTION_REQUIRED: ask_email"), false);

  const status = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["status", "scan_1"], status.deps), 0);
  assert.equal(status.cap.err().includes("Call scan_wait again"), false);
});

test("status --wait prints ask_email CLI copy once and no per-poll scan_wait line", async () => {
  const ask =
    "This may take a while. Ask the human the exact masked-recipient question from email_opt_in, then keep calling scan_wait.";
  const waitMessage = "Scan scan_1 is in first pass. Call scan_wait again.";
  let gets = 0;
  const fake = await startFakeServer((state) => {
    state.scan.status = "running";
    state.scan.final = false;
    state.scan.pollAfterSec = 0;
    state.scan.elapsedSec = 540;
    state.scan.eta = { minSec: 600, maxSec: 900 };
    state.scan.next = {
      action: "ask_email",
      afterSec: 10,
      message: ask,
    };
    state.beforeScanGet = (s) => {
      gets += 1;
      if (gets > 1) {
        s.scan.next = {
          action: "scan_wait",
          afterSec: 3,
          message: waitMessage,
        };
      }
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const login = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], login.deps), 0);
  await storeToken(login.deps, fake.origin, {
    token: TEST_TOKEN,
    githubLogin: "octocat",
    grantId: "grant_1",
  });
  const file = JSON.parse(login.deps.fs.read(
    (await import("../src/credentials.js")).credentialsPath(login.deps)
  )) as { origins: Record<string, { lastScanId?: string }> };
  file.origins[fake.origin]!.lastScanId = "scan_1";
  login.deps.fs.write(
    (await import("../src/credentials.js")).credentialsPath(login.deps),
    `${JSON.stringify(file, null, 2)}\n`,
    0o600
  );
  const status = makeDeps({
    origin: fake.origin,
    home,
    defaultWaitMs: 40,
    minPollMs: 10,
  });
  assert.equal(await runCli(["status", "scan_1", "--wait"], status.deps), 75);
  const err = status.cap.err();
  assert.match(err, /CLEANSLOP_ACTION_REQUIRED: ask_email/);
  assert.match(err, /cleanslop email scan_1/);
  assert.match(err, /--consent "<that exact question>"/);
  assert.equal(err.includes("email_opt_in"), false);
  assert.equal(err.includes("Call scan_wait again"), false);
  assert.match(err, /cleanslop status scan_1 --wait/);
  assert.equal(err.split("CLEANSLOP_ACTION_REQUIRED: ask_email").length - 1, 1);
  assert.ok(gets > 1);
});

test("scan start with ask_email prints the header exactly once", async () => {
  const fake = await startFakeServer((state) => {
    state.scan.status = "running";
    state.scan.final = false;
    state.scan.elapsedSec = 540;
    state.scan.eta = { minSec: 600, maxSec: 900 };
    state.scan.next = {
      action: "ask_email",
      afterSec: 10,
      message:
        "This may take a while. Ask the human the exact masked-recipient question from email_opt_in, then keep calling scan_wait.",
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const login = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], login.deps), 0);
  const scan = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan"], scan.deps), 75);
  const err = scan.cap.err();
  assert.equal(err.split("CLEANSLOP_ACTION_REQUIRED: ask_email").length - 1, 1);
  assert.match(err, /cleanslop email scan_1/);
  assert.match(err, /cleanslop status scan_1 --wait/);
  assert.equal(err.includes("email_opt_in"), false);
  assert.equal(err.includes("Call scan_wait again"), false);
});

test("status --wait prints ask_email once when it arrives on the last poll", async () => {
  const ask =
    "This may take a while. Ask the human the exact masked-recipient question from email_opt_in, then keep calling scan_wait.";
  const waitMessage = "Scan scan_1 is in first pass. Call scan_wait again.";
  let gets = 0;
  const fake = await startFakeServer((state) => {
    state.scan.status = "running";
    state.scan.final = false;
    state.scan.pollAfterSec = 0;
    state.scan.elapsedSec = 540;
    state.scan.eta = { minSec: 600, maxSec: 900 };
    state.scan.next = {
      action: "scan_wait",
      afterSec: 0,
      message: waitMessage,
    };
    state.beforeScanGet = (s) => {
      gets += 1;
      if (gets === 1) {
        s.scan.next = {
          action: "scan_wait",
          afterSec: 0,
          message: waitMessage,
        };
        s.scan.pollAfterSec = 0;
        return;
      }
      s.scan.next = {
        action: "ask_email",
        afterSec: 10,
        message: ask,
      };
      s.scan.pollAfterSec = 30;
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const login = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], login.deps), 0);
  await storeToken(login.deps, fake.origin, {
    token: TEST_TOKEN,
    githubLogin: "octocat",
    grantId: "grant_1",
  });
  const file = JSON.parse(login.deps.fs.read(
    (await import("../src/credentials.js")).credentialsPath(login.deps)
  )) as { origins: Record<string, { lastScanId?: string }> };
  file.origins[fake.origin]!.lastScanId = "scan_1";
  login.deps.fs.write(
    (await import("../src/credentials.js")).credentialsPath(login.deps),
    `${JSON.stringify(file, null, 2)}\n`,
    0o600
  );
  const status = makeDeps({
    origin: fake.origin,
    home,
    defaultWaitMs: 40,
    minPollMs: 10,
  });
  assert.equal(await runCli(["status", "scan_1", "--wait"], status.deps), 75);
  const err = status.cap.err();
  assert.equal(err.split("CLEANSLOP_ACTION_REQUIRED: ask_email").length - 1, 1);
  assert.match(err, /cleanslop email scan_1/);
  assert.match(err, /cleanslop status scan_1 --wait/);
  assert.equal(err.includes("email_opt_in"), false);
  assert.equal(err.includes("Call scan_wait again"), false);
  assert.equal(gets, 2);
});

test("failed scan exits 20", async () => {
  const fake = await startFakeServer((state) => {
    state.scan.status = "failed";
    state.scan.final = true;
    state.scan.error = { code: "scan_failed", message: "clone failed" };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const login = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], login.deps), 0);
  const scan = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan"], scan.deps), 20);
  assert.match(scan.cap.err(), /clone failed/);
});

test("parseGithubRemote accepts https, git@, and ssh; rejects others", () => {
  assert.deepEqual(parseGithubRemote("https://github.com/acme/app.git"), {
    owner: "acme",
    repo: "app",
    fullName: "acme/app",
  });
  assert.deepEqual(parseGithubRemote("git@github.com:acme/app.git"), {
    owner: "acme",
    repo: "app",
    fullName: "acme/app",
  });
  assert.deepEqual(parseGithubRemote("ssh://git@github.com/acme/app"), {
    owner: "acme",
    repo: "app",
    fullName: "acme/app",
  });
  assert.equal(parseGithubRemote("https://gitlab.com/acme/app"), null);
  assert.equal(parseGithubRemote("not a url"), null);
  assert.equal(parseGithubRemote(""), null);
});

test("origin, windows config dir, agent hint, redact, poll clamp", () => {
  assert.equal(parseOrigin("https://app.cleanslop.com/"), "https://app.cleanslop.com");
  assert.equal(parseOrigin("not-a-url"), null);
  assert.equal(parseOrigin("https://user:pass@x.com"), null);
  const win = makeDeps({
    origin: "https://app.cleanslop.com",
    home: tempHome(),
    platform: "win32",
    envExtra: { APPDATA: "/win/appdata", XDG_CONFIG_HOME: undefined },
  });
  assert.equal(configDir(win.deps), "/win/appdata/cleanslop");
  assert.equal(
    detectAgentHint({
      get: (n) => (n === "CLAUDECODE" ? "1" : undefined),
      cwd: () => "/",
      homeDir: () => "/",
      hostname: () => "h",
      platform: "linux",
    }),
    "claude-code"
  );
  assert.equal(
    detectAgentHint({
      get: (n) => (n === "CURSOR_TRACE_ID" ? "x" : undefined),
      cwd: () => "/",
      homeDir: () => "/",
      hostname: () => "h",
      platform: "linux",
    }),
    "cursor"
  );
  assert.equal(
    detectAgentHint({
      get: (n) => (n === "CODEX_HOME" ? "x" : undefined),
      cwd: () => "/",
      homeDir: () => "/",
      hostname: () => "h",
      platform: "linux",
    }),
    "codex"
  );
  assert.equal(
    detectAgentHint({
      get: (n) => (n === "REPL_ID" ? "x" : undefined),
      cwd: () => "/",
      homeDir: () => "/",
      hostname: () => "h",
      platform: "linux",
    }),
    "replit"
  );
  assert.equal(
    detectAgentHint({
      get: () => undefined,
      cwd: () => "/",
      homeDir: () => "/",
      hostname: () => "h",
      platform: "linux",
    }),
    "other"
  );
  assert.equal(redactSecrets(`token ${TEST_TOKEN} x`), "token cslop_*** x");
  assert.equal(redactSecrets("pay spt_test_secret_token"), "pay spt_***");
  assert.equal(redactSecrets("pay spt_abc"), "pay spt_***");
  assert.equal(clampPollMs(1, 3000), 3000);
  assert.equal(clampPollMs(10, 3000), 10_000);
});

test("throwHttpError maps reserved and policy codes", () => {
  const headers = new Headers();
  const cases: Array<[number, string, number]> = [
    [403, "beta_required", 12],
    [403, "waitlisted", 12],
    [429, "agent_daily_cap", 12],
    [409, "commit_not_on_github", 13],
    [409, "scan_failed", 20],
    [400, "unsupported_remote", 13],
    [503, "github_unavailable", 1],
    [429, "rate_limited", 75],
    [409, "training_decision_required", 10],
    [401, "identity_presentation_required", 10],
    [409, "account_exists", 10],
    [403, "link_pilot_required", 12],
    [400, "invalid_request", 2],
    [422, "prompt_must_quote_recipient", 2],
    [409, "no_verified_email", 12],
    [409, "done_alerts_disabled", 12],
    [409, "already_sent", 12],
    [409, "too_late", 12],
    [503, "capacity", 75],
  ];
  for (const [status, error, exit] of cases) {
    try {
      throwHttpError({
        status,
        headers,
        text: "",
        json: { error, message: error },
      });
      assert.fail(`expected throw for ${error}`);
    } catch (err) {
      assert.equal((err as { exitCode: number }).exitCode, exit, error);
      if (error === "commit_not_on_github") {
        const action = (err as { action?: { question?: { id: string } } }).action;
        assert.equal(action?.question?.id, "push_first");
      }
    }
  }
  for (const [error, id] of [
    ["github_reauth_required", "github_reconnect"],
    ["training_decision_required", "training_default"],
  ]) {
    const json = { error, message: error, action: { kind: "ask_human", url: "https://app.example/x" } };
    try {
      throwHttpError({ status: 409, headers, text: "", json });
      assert.fail(`expected throw for ${error}`);
    } catch (err) {
      const question = (err as { action?: { question?: { id: string; question: string } } }).action
        ?.question;
      assert.equal(question?.id, id);
      assert.match(question?.question ?? "", /https:\/\/app\.example\/x/);
    }
  }
  try {
    throwHttpError({
      status: 429,
      headers,
      text: "",
      json: {
        error: "rate_limited",
        message: "slow down",
        action: { kind: "wait", humanPrompt: "Wait a bit.", retryAfterSec: 9 },
      },
    });
    assert.fail("expected throw for rate_limited action");
  } catch (err) {
    assert.ok(err instanceof CliError);
    assert.equal(err.exitCode, 75);
    assert.equal(err.action?.kind, "wait");
    assert.equal(err.action?.humanPrompt, "Wait a bit.");
  }
});

test("invalid CLEANSLOP_ORIGIN is a usage error", async () => {
  const { deps } = makeDeps({
    origin: "https://app.cleanslop.com",
    home: tempHome(),
    envExtra: { CLEANSLOP_ORIGIN: "ftp://nope" },
  });
  assert.equal(await runCli(["whoami"], deps), EXIT_USAGE);
});

test("not a git work tree exits 13", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const login = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], login.deps), 0);
  const scan = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub({ worktree: false }),
  });
  assert.equal(await runCli(["scan"], scan.deps), 13);
});

test("default deps can invoke git", async () => {
  const deps = createDefaultDeps();
  const inside = await deps.git(
    ["rev-parse", "--is-inside-work-tree"],
    process.cwd()
  );
  assert.equal(inside.ok, true);
  const missing = await deps.git(["status"], "/this/path/does/not/exist-cs");
  assert.equal(missing.ok, false);
});

test("scan --preview fetches a first-pass report while running", async () => {
  const fake = await startFakeServer((state) => {
    state.scan.status = "running";
    state.scan.final = false;
    state.reportError = null;
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const login = makeDeps({ origin: fake.origin, home });
  assert.equal(await runCli(["login"], login.deps), 0);
  const scan = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan", "--preview"], scan.deps), 0);
  assert.match(scan.cap.out(), /cleanslop:v1/);
});
