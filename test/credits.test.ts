import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import {
  pendingSpendPath,
  storeToken,
  writePendingSpend,
} from "../src/credentials.js";
import {
  formatPackPrice,
  LINK_APPROVAL_WAIT_MS,
  LINK_RESUME_WAIT_MS,
  linkApprovalWaitMs,
  stripeSptOfferFromErrorBody,
} from "../src/commands/credits.js";
import { parseArgs } from "../src/args.js";
import { runCli } from "../src/main.js";
import { LINK_CLI_TIMEOUT_MS } from "../src/config.js";
import { EXIT_USAGE } from "../src/exit.js";
import {
  createLinkSpendRequest,
  parseSpendRequestJson,
  SPT_RETRIEVAL_DELAYS_MS,
} from "../src/link.js";
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
const envKeys = [
  "FAKE_LINK_MODE",
  "FAKE_LINK_STATE",
  "FAKE_SPEND_REQUEST_ID",
  "FAKE_SPEND_STATUS",
  "FAKE_SPEND_RESOLUTION",
  "FAKE_SPT",
  "FAKE_LIST_NO_SPT",
] as const;

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
  for (const key of envKeys) delete process.env[key];
});

function noSecrets(text: string) {
  assertNoToken(text);
  assert.doesNotMatch(text, /spt_[A-Za-z0-9]{6,}/);
}

function readState(path: string): {
  creates: number;
  includeRetrieves: number;
  lastAmount?: string | null;
  lastNetworkId?: string | null;
  lastTest?: boolean;
  lastCreateStatus?: string | null;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    creates: number;
    includeRetrieves: number;
    lastAmount?: string | null;
    lastNetworkId?: string | null;
    lastTest?: boolean;
    lastCreateStatus?: string | null;
  };
}

test("linkApprovalWaitMs checks once for --no-wait and polls briefly for --resume", () => {
  assert.equal(linkApprovalWaitMs(parseArgs(["credits", "buy", "--link", "--no-wait"])), 0);
  assert.equal(
    linkApprovalWaitMs(parseArgs(["credits", "buy", "--link", "--resume"])),
    LINK_RESUME_WAIT_MS
  );
  assert.equal(formatPackPrice(500, "usd"), "5.00 USD");
});

test("linkApprovalWaitMs keeps a 10-minute budget for auto-buy", () => {
  const longWait = parseArgs(["scan", "--wait", "75m"]);
  assert.equal(linkApprovalWaitMs(longWait, { autoBuy: true }), LINK_APPROVAL_WAIT_MS);
  assert.equal(linkApprovalWaitMs(longWait), 75 * 60 * 1000);
  assert.equal(linkApprovalWaitMs(parseArgs(["credits", "buy", "--link"])), LINK_APPROVAL_WAIT_MS);
  assert.equal(linkApprovalWaitMs(parseArgs(["credits", "buy", "--link", "--wait", "1"])), 1000);
});

test("stripeSptOfferFromErrorBody reads the matching pack from a 402", () => {
  const methods = [
    {
      kind: "stripe_spt",
      pack: "p5",
      amount: 1000,
      currency: "usd",
      networkId: "profile_test",
      purchaseUrl: "https://app.example/api/agent/v1/credits/purchases",
    },
    {
      kind: "stripe_spt",
      pack: "p15",
      amount: "2500",
      networkId: "profile_test",
      purchaseUrl: "https://app.example/api/agent/v1/credits/purchases",
    },
  ];
  const body = { payment: { methods } };
  const p15 = stripeSptOfferFromErrorBody(body, "p15");
  assert.equal(p15?.pack, "p15");
  assert.equal(p15?.amount, 2500);
  assert.equal(p15?.currency, "usd");
  const fallback = stripeSptOfferFromErrorBody(body, "p40");
  assert.equal(fallback?.pack, "p5");
  assert.equal(stripeSptOfferFromErrorBody(body, null)?.pack, "p5");
  assert.equal(stripeSptOfferFromErrorBody({ payment: { methods: [] } }, "p5"), null);
  assert.equal(stripeSptOfferFromErrorBody({ error: "out_of_scans" }, "p5"), null);
  assert.equal(
    stripeSptOfferFromErrorBody(
      {
        payment: {
          methods: [
            { kind: "checkout", url: "https://app.example/credits?from=agent" },
            { kind: "stripe_spt", pack: "p5", amount: 0, networkId: "x", purchaseUrl: "/p" },
            { kind: "stripe_spt", pack: "nope", amount: 1000, networkId: "x", purchaseUrl: "/p" },
            { kind: "stripe_spt", pack: "p5", amount: 1000, networkId: "", purchaseUrl: "/p" },
          ],
        },
      },
      "p5"
    ),
    null
  );
});

test("parseSpendRequestJson reads object tokens and next_action shapes", () => {
  assert.equal(parseSpendRequestJson("nope"), null);
  assert.equal(parseSpendRequestJson("{}"), null);
  const objectToken = parseSpendRequestJson(
    JSON.stringify({
      id: "sr_1",
      status: "weird",
      shared_payment_token: { id: "spt_obj" },
      display_message: "top",
    })
  );
  assert.equal(objectToken?.sharedPaymentToken, "spt_obj");
  assert.equal(objectToken?.status, "unknown");
  assert.equal(objectToken?.displayMessage, "top");
  assert.equal(objectToken?.approvalUrl, null);
  assert.equal(
    parseSpendRequestJson(
      JSON.stringify({
        id: "sr_link",
        status: "pending_approval",
        approval_link: "https://app.link.com/spend/approve?code=x",
      })
    )?.approvalUrl,
    "https://app.link.com/spend/approve?code=x"
  );
  const nested = parseSpendRequestJson(
    JSON.stringify({
      id: "sr_2",
      status: "requires_action",
      next_action: { resolution: { type: "auto_resume" }, display_message: "wait" },
    })
  );
  assert.equal(nested?.resolution, "auto_resume");
  assert.equal(nested?.displayMessage, "wait");
  const fromArray = parseSpendRequestJson(
    JSON.stringify([
      { id: "sr_old", status: "created" },
      {
        id: "sr_new",
        status: "pending_approval",
        instruction: "Present the approval_url to the user.",
        _next: {
          command: "spend-request retrieve sr_new --interval 2 --max-attempts 300",
          until: "status changes from pending_approval",
        },
      },
    ])
  );
  assert.equal(fromArray?.id, "sr_new");
  assert.equal(fromArray?.status, "pending");
});

test("fake link-cli create prints a pending_approval array with instruction/_next", () => {
  const result = spawnSync(
    process.execPath,
    [FAKE_LINK_CLI, "spend-request", "create", "--format", "json"],
    {
      encoding: "utf8",
      env: { ...process.env, FAKE_LINK_MODE: "ok", FAKE_SPEND_REQUEST_ID: "sr_shape" },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  const rec = parsed[0] as {
    id?: string;
    status?: string;
    instruction?: string;
    _next?: { command?: string; until?: string };
  };
  assert.equal(rec.id, "sr_shape");
  assert.equal(rec.status, "pending_approval");
  assert.match(String(rec.instruction), /approve in the Link app/i);
  assert.equal(
    rec._next?.command,
    "spend-request retrieve sr_shape --interval 2 --max-attempts 300"
  );
  assert.equal(rec._next?.until, "status changes from pending_approval");
  const snap = parseSpendRequestJson(result.stdout);
  assert.equal(snap?.id, "sr_shape");
  assert.equal(snap?.status, "pending");
  assert.equal(snap?.approvalUrl, "https://app.link.com/spend/approve?code=test");
});

test("fake link-cli retrieve pending poll uses pending_approval", () => {
  const result = spawnSync(
    process.execPath,
    [FAKE_LINK_CLI, "spend-request", "retrieve", "sr_shape", "--format", "json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_LINK_MODE: "spend-pending",
        FAKE_SPEND_REQUEST_ID: "sr_shape",
      },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  const rec = parsed as { id?: string; status?: string };
  assert.equal(rec.id, "sr_shape");
  assert.equal(rec.status, "pending_approval");
  const snap = parseSpendRequestJson(result.stdout);
  assert.equal(snap?.id, "sr_shape");
  assert.equal(snap?.status, "pending");
});

test("createLinkSpendRequest uses the default link-cli timeout", async () => {
  const timeouts: Array<number | undefined> = [];
  const { deps } = makeDeps({
    origin: "https://app.example",
    home: tempHome(),
    execFile: async (_file, args, opts) => {
      if (args.includes("spend-request") && args.includes("create")) {
        timeouts.push(opts?.timeout);
        return {
          ok: true,
          stdout: JSON.stringify([
            {
              id: "sr_timeout",
              status: "pending_approval",
              instruction: "Present the approval_url to the user.",
              _next: {
                command: "spend-request retrieve sr_timeout --interval 2 --max-attempts 300",
                until: "status changes from pending_approval",
              },
            },
          ]),
          stderr: "",
          code: 0,
        };
      }
      return { ok: false, stdout: "", stderr: "unexpected", code: 1 };
    },
  });
  const snap = await createLinkSpendRequest(deps, {
    networkId: "profile_test",
    amount: 1000,
    currency: "usd",
    context: "x".repeat(100),
    lineItem: "name:CleanSlop 5 scan credits,unit_amount:1000,quantity:1",
    total: "type:total,display_text:Total,amount:1000",
    idempotencyKey: "idem-test-1",
  });
  assert.equal(snap.id, "sr_timeout");
  assert.equal(snap.status, "pending");
  assert.deepEqual(timeouts, [LINK_CLI_TIMEOUT_MS]);
});

test("credits buy --link retrieves the token on the third include-retrieve", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "spt-lag";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_lagged_token_xyz";
  const { deps, cap, clock } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  const started = clock.now();
  const code = await runCli(
    ["credits", "buy", "--link", "--pack", "p5", "--amount", "1000"],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: approve/);
  assert.match(cap.err(), /https:\/\/app\.link\.com\/spend\/approve\?code=test/);
  assert.match(cap.out(), /Added p5 scan credits/);
  assert.match(cap.out(), /Balance: 5/);
  noSecrets(cap.out() + cap.err());
  const state = readState(statePath);
  assert.equal(state.creates, 1);
  assert.equal(state.lastCreateStatus, "pending_approval");
  assert.equal(state.lastTest, false);
  assert.equal(state.includeRetrieves, 3);
  assert.equal(clock.now() - started, 1000 + 1000);
  assert.equal(deps.fs.exists(pendingSpendPath(deps)), false);
  assert.equal(fake.state.purchases.length, 1);
  const posted = fake.state.purchases[0] as {
    body?: { sharedPaymentToken?: string; spendRequestId?: string };
  };
  assert.equal(posted.body?.sharedPaymentToken, "spt_lagged_token_xyz");
  assert.equal(posted.body?.spendRequestId, "sr_test_1");
  assert.equal(SPT_RETRIEVAL_DELAYS_MS.length, 9);
});

test("credits buy passes --test to link-cli for a test profile or CLEANSLOP_LINK_TEST=1", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_link_test_flag_token";
  const unset = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  assert.equal(
    await runCli(["credits", "buy", "--link", "--pack", "p5", "--amount", "1000"], unset.deps),
    0,
    unset.cap.err()
  );
  assert.equal(readState(statePath).lastTest, false);

  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  const on = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
      CLEANSLOP_LINK_TEST: "1",
    },
  });
  assert.equal(
    await runCli(["credits", "buy", "--link", "--pack", "p5", "--amount", "1000"], on.deps),
    0,
    on.cap.err()
  );
  assert.equal(readState(statePath).lastTest, true);

  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  const other = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
      CLEANSLOP_LINK_TEST: "true",
    },
  });
  assert.equal(
    await runCli(["credits", "buy", "--link", "--pack", "p5", "--amount", "1000"], other.deps),
    0,
    other.cap.err()
  );
  assert.equal(readState(statePath).lastTest, false);

  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_SPEND_STATUS = "pending_approval";
  const testProfile = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test_sandbox",
    },
  });
  assert.equal(
    await runCli(
      ["credits", "buy", "--link", "--pack", "p5", "--amount", "1000", "--no-wait"],
      testProfile.deps
    ),
    10,
    testProfile.cap.err()
  );
  assert.equal(readState(statePath).lastTest, true);
  const saved = JSON.parse(
    readFileSync(pendingSpendPath(testProfile.deps), "utf8")
  ) as { testMode?: boolean };
  assert.equal(saved.testMode, true);
});

test("credits buy keeps the spend request when the token never appears, and a re-run resumes", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "spt-missing";
  process.env.FAKE_LINK_STATE = statePath;
  const first = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  const code = await runCli(
    ["credits", "buy", "--link", "--pack", "p5", "--amount", "1000"],
    first.deps
  );
  assert.equal(code, 10, first.cap.err());
  assert.match(first.cap.err(), /CLEANSLOP_ACTION_REQUIRED: wait/);
  assert.match(first.cap.err(), /--resume/);
  assert.match(first.cap.err(), /sr_test_1/);
  noSecrets(first.cap.out() + first.cap.err());
  assert.equal(first.deps.fs.exists(pendingSpendPath(first.deps)), true);
  assert.equal(readState(statePath).creates, 1);
  assert.doesNotMatch(first.deps.fs.read(pendingSpendPath(first.deps)), /spt_/);

  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_SPT = "spt_resumed_token_xyz";
  const second = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  const resumed = await runCli(["credits", "buy", "--link", "--resume"], second.deps);
  assert.equal(resumed, 0, second.cap.err());
  assert.equal(readState(statePath).creates, 1);
  assert.equal(fake.state.purchases.length, 1);
  noSecrets(second.cap.out() + second.cap.err());
  // Approved is reported once, on the first run that saw it.
  assert.deepEqual(fake.state.spendEvents.map((e) => e.event), ["created", "approved", "token_missing"]);
});

test("credits buy usage and payment-failed delete the pending file", async () => {
  const { deps, cap } = makeDeps({ origin: "https://app.example", home: tempHome() });
  assert.equal(await runCli(["credits"], deps), 2);
  assert.match(cap.err(), /credits buy --link/);
  assert.equal(await runCli(["credits", "list"], deps), 2);
  assert.equal(await runCli(["credits", "buy"], deps), 2);

  const home = tempHome();
  const noPacks = await startFakeServer((state) => {
    state.offers = { payment: { methods: [], message: "This account is out of scans. Contact us for credits." } };
  });
  cleanups.push(noPacks.close);
  const noAmount = makeDeps({
    origin: noPacks.origin,
    home,
    envExtra: { CLEANSLOP_TOKEN: TEST_TOKEN, CLEANSLOP_STRIPE_PROFILE_ID: "profile_test" },
  });
  assert.equal(await runCli(["credits", "buy", "--link"], noAmount.deps), 11);
  assert.match(noAmount.cap.err(), /CLEANSLOP_ACTION_REQUIRED: ask_human/);
  assert.match(noAmount.cap.err(), /Contact us for credits/);
  assert.equal(noAmount.deps.fs.exists(pendingSpendPath(noAmount.deps)), false);
  const bare = await startFakeServer((state) => {
    state.offers = { payment: { methods: [] } };
  });
  cleanups.push(bare.close);
  const bareDeps = makeDeps({
    origin: bare.origin,
    home,
    envExtra: { CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  assert.equal(await runCli(["credits", "buy", "--link"], bareDeps.deps), 11);
  assert.match(bareDeps.cap.err(), /Link credit packs are not available/);

  const fake = await startFakeServer((state) => {
    state.purchaseError = {
      status: 402,
      body: { error: "payment_failed", message: "declined", reason: "card_declined" },
    };
  });
  cleanups.push(fake.close);
  const statePath = join(home, "fake-link-state.json");
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  const pay = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  await storeToken(pay.deps, fake.origin, { token: TEST_TOKEN, grantId: "g1" });
  const failed = await runCli(
    ["credits", "buy", "--link", "--amount", "1000", "--network-id", "profile_test"],
    pay.deps
  );
  assert.equal(failed, 11);
  assert.equal(pay.deps.fs.exists(pendingSpendPath(pay.deps)), false);
});

test("credits buy --resume refuses a pending spend from another origin", async () => {
  const home = tempHome();
  const { deps, cap } = makeDeps({
    origin: "https://app.example",
    home,
    envExtra: { CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  await writePendingSpend(deps, {
    version: 1,
    origin: "https://staging.example",
    spendRequestId: "sr_other",
    pack: "p5",
    amount: 1000,
    currency: "usd",
    networkId: "profile_test",
    purchaseUrl: "https://staging.example/api/agent/v1/credits/purchases",
    createdAt: 1,
  });
  assert.equal(await runCli(["credits", "buy", "--link", "--resume"], deps), 10);
  assert.match(cap.err(), /another origin/);
  assert.match(cap.err(), /staging\.example/);
  assert.match(cap.err(), /app\.example/);
  assert.equal(deps.fs.exists(pendingSpendPath(deps)), true);
  assert.match(deps.fs.read(pendingSpendPath(deps)), /sr_other/);
});

test("credits buy ignores a foreign-origin pending file and posts to the current origin", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_current_origin_token";
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  await writePendingSpend(deps, {
    version: 1,
    origin: "https://staging.example",
    spendRequestId: "sr_stale_other",
    pack: "p5",
    amount: 1000,
    currency: "usd",
    networkId: "profile_test",
    purchaseUrl: "https://staging.example/api/agent/v1/credits/purchases",
    createdAt: 1,
  });
  const code = await runCli(
    ["credits", "buy", "--link", "--amount", "1000"],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.equal(readState(statePath).creates, 1);
  assert.equal(fake.state.purchases.length, 1);
  const posted = fake.state.purchases[0] as {
    body?: { spendRequestId?: string; sharedPaymentToken?: string };
  };
  assert.equal(posted.body?.spendRequestId, "sr_test_1");
  assert.equal(posted.body?.sharedPaymentToken, "spt_current_origin_token");
  assert.equal(deps.fs.exists(pendingSpendPath(deps)), false);
});

test("credits buy --pack for another pack replaces the saved request; --resume refuses", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_switched_pack_token";
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  const saved = {
    version: 1 as const,
    origin: fake.origin,
    spendRequestId: "sr_saved_p5",
    pack: "p5",
    amount: 1000,
    currency: "usd",
    networkId: "profile_test",
    purchaseUrl: `${fake.origin}/api/agent/v1/credits/purchases`,
    createdAt: 1,
  };
  await writePendingSpend(deps, saved);
  assert.equal(
    await runCli(["credits", "buy", "--link", "--pack", "p15", "--resume"], deps),
    EXIT_USAGE
  );
  assert.match(cap.err(), /pending Link payment is for p5/);
  assert.match(deps.fs.read(pendingSpendPath(deps)), /sr_saved_p5/);
  assert.equal(readState(statePath).creates, 0);

  const code = await runCli(
    ["credits", "buy", "--link", "--pack", "p15", "--amount", "2500"],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.equal(readState(statePath).creates, 1);
  const posted = fake.state.purchases[0] as {
    body?: { pack?: string; spendRequestId?: string };
  };
  assert.equal(posted.body?.pack, "p15");
  assert.equal(posted.body?.spendRequestId, "sr_test_1");
});

test("credits buy --resume without a pending file starts one and stops at approval", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  assert.equal(await runCli(["credits", "buy", "--link", "--resume"], deps), 10);
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: approve/);
  assert.match(cap.err(), /credits buy --link --resume/);
  assert.equal(readState(statePath).creates, 1);
  assert.equal(fake.state.purchases.length, 0);
});

test("the pack question says when Link asks for payment permission or sign-in first", async () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["ok", {}, /\? You approve the payment in your Link app\.$/],
    [
      "ok",
      { scope: "userinfo:read" },
      /Link first asks you to allow CleanSlop to request Link payments \(one time; nothing is charged\), then you approve the payment/,
    ],
    ["unauth", {}, /Link first asks you to sign in and allow CleanSlop to request Link payments/],
    ["auth-status-fail", {}, /\? You approve the payment in your Link app\.$/],
  ];
  for (const [mode, extra, expected] of cases) {
    const fake = await startFakeServer();
    cleanups.push(fake.close);
    const home = tempHome();
    const statePath = join(home, "fake-link-state.json");
    writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0, ...extra }));
    process.env.FAKE_LINK_MODE = mode;
    process.env.FAKE_LINK_STATE = statePath;
    const env = { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN };
    const { deps, cap } = makeDeps({ origin: fake.origin, home, envExtra: env, stdinIsTTY: false });
    assert.equal(await runCli(["credits", "buy", "--link", "--no-wait"], deps), 10, cap.err());
    const question = questionFrom(cap.err());
    assert.equal(question?.id, "link_credit_pack", mode);
    assert.match(question?.question ?? "", expected, `${mode} ${JSON.stringify(extra)}`);
    if (mode === "ok" && extra.scope) assert.match(cap.err(), /Tell the human: Link first asks you to allow/);
  }
});

test("an agent's credits buy without --pack asks the human which pack", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  const env = { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN };
  const { deps, cap } = makeDeps({ origin: fake.origin, home, envExtra: env, stdinIsTTY: false });
  assert.equal(await runCli(["credits", "buy", "--link", "--no-wait"], deps), 10, cap.err());
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: ask_human/);
  assert.match(
    cap.err(),
    /which CleanSlop credit pack to buy with Link: p5 \(5 scans, 5\.00 USD, 1\.00 USD per scan\) or p15 \(15 scans, 12\.00 USD, 0\.80 USD per scan\)\./
  );
  assert.match(cap.err(), /run `cleanslop credits buy --link --pack <pack> --no-wait`/);
  assert.equal(readState(statePath).creates, 0);
  assert.equal(deps.fs.exists(pendingSpendPath(deps)), false);
  const question = questionFrom(cap.err());
  assert.equal(question?.id, "link_credit_pack");
  assert.equal(question?.header, "Credits");
  assert.deepEqual(question?.options, [
    {
      value: "p5",
      label: "5 scans · 5.00 USD",
      description: "1.00 USD per scan",
      run: "cleanslop credits buy --link --pack p5 --no-wait",
    },
    {
      value: "p15",
      label: "15 scans · 12.00 USD",
      description: "0.80 USD per scan",
      run: "cleanslop credits buy --link --pack p15 --no-wait",
    },
    { value: "none", label: "Not now", description: "Buy nothing" },
  ]);
  assert.match(cap.err(), /Options:\n  1\. 5 scans · 5\.00 USD \(1\.00 USD per scan\) → run: cleanslop credits buy --link --pack p5 --no-wait/);
  assert.match(cap.err(), /  3\. Not now \(Buy nothing\) → stop/);
  assert.match(cap.err(), /multiple-choice question tool/);
});

test("an agent's credits buy asks buy, promo, or not now while a promo code is possible", async () => {
  const promo = { command: "cleanslop redeem <code>", mcpTool: "promo_redeem" };
  const offer = (pack: string, amount: number, origin: string) => ({
    kind: "stripe_spt",
    pack,
    amount,
    currency: "usd",
    networkId: "profile_offer",
    purchaseUrl: `${origin}/api/agent/v1/credits/purchases`,
  });
  const fake = await startFakeServer((state) => {
    state.offers = {
      payment: { methods: [offer("p5", 500, state.origin), offer("p15", 1200, state.origin)], promo },
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPEND_STATUS = "pending_approval";
  const env = { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN };
  const run = async (argv: string[]) => {
    const { deps, cap } = makeDeps({ origin: fake.origin, home, envExtra: env, stdinIsTTY: false });
    const code = await runCli(argv, deps);
    return { code, err: cap.err() };
  };

  const first = await run(["credits", "buy", "--link", "--no-wait"]);
  assert.equal(first.code, 10, first.err);
  assert.match(first.err, /If they have a CleanSlop promo code instead, run `cleanslop redeem <code>`/);
  const question = questionFrom(first.err);
  assert.equal(question?.id, "top_up_method");
  assert.equal(question?.header, "Add scans");
  assert.match(question?.question ?? "", /can still use a CleanSlop promo code/);
  assert.deepEqual(question?.options[0], {
    value: "buy",
    label: "Buy with Link",
    description:
      "p5 (5 scans, 5.00 USD, 1.00 USD per scan); p15 (15 scans, 12.00 USD, 0.80 USD per scan)",
    run: "cleanslop credits buy --link --no-promo --no-wait",
  });
  assert.deepEqual(
    question?.options.slice(1).map((o) => o.value),
    ["promo", "none"]
  );

  // "Buy with Link" reruns with --no-promo: only the pack question.
  const buy = await run(["credits", "buy", "--link", "--no-promo", "--no-wait"]);
  assert.equal(buy.code, 10, buy.err);
  assert.equal(questionFrom(buy.err)?.id, "link_credit_pack");
  assert.equal(readState(statePath).creates, 0);

  // One pack offered: the buy answer names it.
  fake.state.offers = { payment: { methods: [offer("p40", 3000, fake.origin)], promo } };
  const single = await run(["credits", "buy", "--link", "--no-wait"]);
  assert.deepEqual(questionFrom(single.err)?.options[0], {
    value: "p40",
    label: "Buy p40",
    description: "p40 (40 scans, 30.00 USD, 0.75 USD per scan)",
    run: "cleanslop credits buy --link --pack p40 --no-wait",
  });

  // A named pack is the human's choice: straight to Link approval.
  const named = await run(["credits", "buy", "--link", "--pack", "p40", "--no-wait"]);
  assert.equal(named.code, 10, named.err);
  assert.match(named.err, /CLEANSLOP_ACTION_REQUIRED: approve/);
  assert.equal(readState(statePath).creates, 1);
});

test("an agent's credits buy without --pack goes ahead when only one pack is offered", async () => {
  const fake = await startFakeServer((state) => {
    state.offers = {
      payment: {
        methods: [
          {
            kind: "stripe_spt",
            pack: "p40",
            amount: 3000,
            currency: "usd",
            networkId: "profile_offer",
            purchaseUrl: `${state.origin}/api/agent/v1/credits/purchases`,
          },
        ],
      },
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPEND_STATUS = "pending_approval";
  const env = { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN };
  const { deps, cap } = makeDeps({ origin: fake.origin, home, envExtra: env, stdinIsTTY: false });
  assert.equal(await runCli(["credits", "buy", "--link", "--no-wait"], deps), 10, cap.err());
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: approve/);
  assert.match(cap.err(), /p40: 40 scans for 30\.00 USD/);
  assert.equal(readState(statePath).creates, 1);
});

/** Starts a p15 spend request, then swaps the Link session for one with `scope`. */
async function pendingThenSessionChange(scope: string) {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPEND_STATUS = "pending_approval";
  const env = { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN };
  const run = async (args: string[]) => {
    const made = makeDeps({ origin: fake.origin, home, envExtra: env, stdinIsTTY: false });
    return { code: await runCli(["credits", "buy", "--link", ...args], made.deps), cap: made.cap };
  };
  assert.equal((await run(["--pack", "p15", "--no-wait"])).code, 10);
  // e.g. `link-cli auth logout` then `cleanslop login --link`.
  const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  writeFileSync(statePath, JSON.stringify({ ...state, scope }));
  process.env.FAKE_SPEND_STATUS = "approved";
  process.env.FAKE_SPT = "spt_regranted_token_xyz";
  return { fake, statePath, run };
}

test("credits buy re-grants payments before reusing a saved request on a session without them", async () => {
  const { fake, statePath, run } = await pendingThenSessionChange("userinfo:read");
  const reuse = await run(["--no-wait"]);
  assert.equal(reuse.code, 10, reuse.cap.err());
  assert.match(reuse.cap.err(), /allow CleanSlop to request Link payments/);
  const question = questionFrom(reuse.cap.err());
  assert.equal(question?.id, "link_approval");
  assert.match(question?.question ?? "", /allow CleanSlop to request Link payments/);
  // The permission is not the purchase; say so, so agents don't call it "approve the payment".
  assert.equal(question?.header, "Permission");
  assert.match(question?.question ?? "", /nothing is charged now, and Link asks for the purchase separately next/);
  assert.match(reuse.cap.err(), /Link payment permission pending\./);
  assert.doesNotMatch(reuse.cap.err(), /missing required scopes/);

  const resumed = await run(["--resume"]);
  assert.equal(resumed.code, 0, resumed.cap.err());
  assert.match(resumed.cap.out(), /Added p5 scan credits/); // the fake server always answers p5
  const state = readState(statePath) as { creates: number; upgrades?: number; lastScope?: string };
  assert.equal(state.creates, 1);
  assert.equal(state.upgrades, 1);
  assert.equal(state.lastScope, "userinfo:read payment_methods.agentic");
  assert.equal(fake.state.purchases.length, 1);
  noSecrets(reuse.cap.out() + reuse.cap.err() + resumed.cap.out() + resumed.cap.err());
});

test("credits buy --resume upgrades once when Link refuses retrieve for a scope it did not report", async () => {
  const { fake, statePath, run } = await pendingThenSessionChange("userinfo:read");
  process.env.FAKE_LINK_MODE = "scope-hidden";
  const refused = await run(["--resume"]);
  assert.equal(refused.code, 10, refused.cap.err());
  assert.equal(questionFrom(refused.cap.err())?.id, "link_approval");
  assert.equal((readState(statePath) as { upgrades?: number }).upgrades, 1);

  const resumed = await run(["--resume"]);
  assert.equal(resumed.code, 0, resumed.cap.err());
  assert.match(resumed.cap.out(), /Added p5 scan credits/); // the fake server always answers p5
  assert.equal((readState(statePath) as { upgrades?: number }).upgrades, 1);
  assert.equal(fake.state.purchases.length, 1);
  noSecrets(refused.cap.out() + refused.cap.err() + resumed.cap.out() + resumed.cap.err());
});

test("credits buy --no-wait fetches the pack price, stops at approval, and --resume finishes", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPEND_STATUS = "pending_approval";
  const env = { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN };
  const started = makeDeps({ origin: fake.origin, home, envExtra: env, stdinIsTTY: false });
  const code = await runCli(
    ["credits", "buy", "--link", "--pack", "p15", "--no-wait"],
    started.deps
  );
  assert.equal(code, 10, started.cap.err());
  assert.equal(fake.state.offerRequests, 1);
  assert.match(started.cap.err(), /CLEANSLOP_ACTION_REQUIRED: approve/);
  assert.match(started.cap.err(), /https:\/\/app\.link\.com\/spend\/approve\?code=test/);
  assert.match(started.cap.err(), /p15: 15 scans for 12\.00 USD/);
  assert.match(started.cap.err(), /run `cleanslop credits buy --link --resume`/);
  const approval = questionFrom(started.cap.err());
  assert.equal(approval?.id, "link_payment_approval");
  assert.match(approval?.question ?? "", /spend\/approve\?code=test.*p15: 15 scans for 12\.00 USD/);
  assert.deepEqual(
    approval?.options.map((o) => [o.label, o.run ?? null]),
    [
      ["Done", "cleanslop credits buy --link --resume"],
      ["Not now", null],
    ]
  );
  const state = readState(statePath);
  assert.equal(state.creates, 1);
  assert.equal(state.lastAmount, "1200");
  assert.equal(state.lastNetworkId, "profile_offer");
  const saved = JSON.parse(started.deps.fs.read(pendingSpendPath(started.deps))) as {
    approvalUrl?: string;
    pack: string;
  };
  assert.equal(saved.pack, "p15");
  assert.equal(saved.approvalUrl, "https://app.link.com/spend/approve?code=test");
  assert.deepEqual(fake.state.spendEvents.map((e) => e.event), ["created"]);
  const created = fake.state.spendEvents[0];
  assert.equal(created?.spendRequestId, "sr_test_1");
  assert.equal(created?.pack, "p15");
  assert.equal(created?.amount, 1200);
  assert.equal(created?.currency, "usd");
  assert.equal(created?.testMode, false);
  assert.equal(typeof created?.ageMs, "number");

  // Still unapproved: --no-wait again re-shows the same link, no second spend request.
  const again = makeDeps({ origin: fake.origin, home, envExtra: env, stdinIsTTY: false });
  assert.equal(await runCli(["credits", "buy", "--link", "--no-wait"], again.deps), 10);
  assert.match(again.cap.err(), /not approved yet/);
  assert.match(questionFrom(again.cap.err())?.question ?? "", /approve the CleanSlop credit pack \(p15\)/);
  assert.match(again.cap.err(), /https:\/\/app\.link\.com\/spend\/approve\?code=test/);
  assert.equal(readState(statePath).creates, 1);
  assert.equal(fake.state.purchases.length, 0);
  assert.deepEqual(fake.state.spendEvents.map((e) => e.event), ["created"]);

  process.env.FAKE_SPEND_STATUS = "approved";
  process.env.FAKE_SPT = "spt_resumed_offer_xyz";
  const resumed = makeDeps({ origin: fake.origin, home, envExtra: env, stdinIsTTY: false });
  assert.equal(await runCli(["credits", "buy", "--link", "--resume"], resumed.deps), 0, resumed.cap.err());
  assert.match(resumed.cap.out(), /Added p5 scan credits/);
  assert.equal(readState(statePath).creates, 1);
  assert.equal(fake.state.purchases.length, 1);
  const posted = fake.state.purchases[0] as { body?: { pack?: string } };
  assert.equal(posted.body?.pack, "p15");
  assert.equal(resumed.deps.fs.exists(pendingSpendPath(resumed.deps)), false);
  assert.deepEqual(fake.state.spendEvents.map((e) => e.event), ["created", "approved"]);
  assert.equal(JSON.stringify(fake.state.spendEvents).includes("spt_"), false);
  noSecrets(started.cap.err() + again.cap.err() + resumed.cap.out() + resumed.cap.err());
});

test("credits buy --resume polls briefly, then re-shows the approval link", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPEND_STATUS = "pending_approval";
  const { deps, cap, clock } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  await writePendingSpend(deps, {
    version: 1,
    origin: fake.origin,
    spendRequestId: "sr_test_1",
    pack: "p5",
    amount: 500,
    currency: "usd",
    networkId: "profile_offer",
    purchaseUrl: `${fake.origin}/api/agent/v1/credits/purchases`,
    createdAt: clock.now(),
    approvalUrl: "https://app.link.com/spend/approve?code=saved",
  });
  const before = clock.now();
  assert.equal(await runCli(["credits", "buy", "--link", "--resume"], deps), 10);
  assert.ok(clock.now() - before >= LINK_RESUME_WAIT_MS);
  assert.ok(clock.now() - before < LINK_RESUME_WAIT_MS + 5000);
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: approve/);
  assert.match(cap.err(), /code=saved/);
  assert.equal(readState(statePath).creates, 0);
  assert.equal(deps.fs.exists(pendingSpendPath(deps)), true);
});

test("credits buy --spend-request-id resumes without creating", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0, polls: 0 }));
  process.env.FAKE_LINK_MODE = "spt-object";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_object_token";
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
    },
  });
  const code = await runCli(
    [
      "credits",
      "buy",
      "--link",
      "--spend-request-id",
      "sr_existing",
      "--amount",
      "1000",
      "--network-id",
      "profile_test",
      "--pack",
      "p15",
    ],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.equal(readState(statePath).creates, 0);
  assert.equal(fake.state.purchases.length, 1);
});

test("credits buy maps denied, extra-action, timeout, and create failures", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();

  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_SPEND_STATUS = "denied";
  process.env.FAKE_LINK_STATE = join(home, "state-denied.json");
  const denied = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  assert.equal(
    await runCli(["credits", "buy", "--link", "--amount", "1000"], denied.deps),
    10
  );
  assert.match(denied.cap.err(), /denied/);
  assert.equal(denied.deps.fs.exists(pendingSpendPath(denied.deps)), false);
  const retry = questionFrom(denied.cap.err());
  assert.equal(retry?.id, "link_payment_retry");
  assert.equal(retry?.options[0]?.label, "Try again");
  assert.equal(retry?.options[0]?.run, "cleanslop credits buy --link --pack p5 --no-wait");
  assert.equal(retry?.options[1]?.value, "none");

  process.env.FAKE_SPEND_STATUS = "requires_action";
  process.env.FAKE_SPEND_RESOLUTION = "challenge";
  const action = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  assert.equal(
    await runCli(["credits", "buy", "--link", "--amount", "1000"], action.deps),
    10
  );
  assert.match(action.cap.err(), /3DS|extra approval|Complete/);
  assert.equal(action.deps.fs.exists(pendingSpendPath(action.deps)), false);
  assert.deepEqual(fake.state.spendEvents.map((e) => e.event), ["created", "denied", "created", "requires_action"]);

  process.env.FAKE_SPEND_STATUS = "pending_approval";
  process.env.FAKE_LINK_MODE = "ok";
  const timed = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  assert.equal(
    await runCli(["credits", "buy", "--link", "--amount", "1000", "--wait", "1"], timed.deps),
    10
  );
  assert.match(timed.cap.err(), /not approved|Timed out|resume/);

  process.env.FAKE_LINK_MODE = "spend-create-fail";
  delete process.env.FAKE_SPEND_STATUS;
  const createFail = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  assert.equal(
    await runCli(["credits", "buy", "--link", "--amount", "1000"], createFail.deps),
    10
  );

  process.env.FAKE_LINK_MODE = "spend-create-bad-json";
  const badCreate = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  assert.equal(
    await runCli(["credits", "buy", "--link", "--amount", "1000"], badCreate.deps),
    1
  );

  const noNet = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    envExtra: { CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  assert.equal(await runCli(["credits", "buy", "--link", "--amount", "1000"], noNet.deps), 2);

  const resumeFlags = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    envExtra: { CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  assert.equal(
    await runCli(
      ["credits", "buy", "--link", "--spend-request-id", "sr_x"],
      resumeFlags.deps
    ),
    2
  );
});

test("credits buy auto-resumes Link 3DS and retrieve failures", async () => {
  const fake = await startFakeServer((state) => {
    state.purchaseResult = { ok: true };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0, polls: 0 }));
  process.env.FAKE_LINK_MODE = "spend-auto-resume";
  process.env.FAKE_LINK_STATE = statePath;
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  assert.equal(
    await runCli(["credits", "buy", "--link", "--amount", "1000"], deps),
    0,
    cap.err()
  );

  process.env.FAKE_LINK_MODE = "spend-retrieve-fail";
  const retrieveFail = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  assert.equal(
    await runCli(["credits", "buy", "--link", "--amount", "1000"], retrieveFail.deps),
    10
  );

  process.env.FAKE_LINK_MODE = "spend-retrieve-bad-json";
  const badRetrieve = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  assert.equal(
    await runCli(["credits", "buy", "--link", "--amount", "1000"], badRetrieve.deps),
    1
  );
});

test("credits buy upgrades an existing session that lacks payment_methods.agentic", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "upgrade-then-ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_upgrade_token_xyz";
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  const upgradeArgs: string[][] = [];
  const loginArgs: string[][] = [];
  const inner = deps.execFile;
  deps.execFile = async (file, args, opts) => {
    if (args[0] === "auth" && args[1] === "upgrade") upgradeArgs.push([...args]);
    if (args[0] === "auth" && args[1] === "login") loginArgs.push([...args]);
    return inner(file, args, opts);
  };
  const code = await runCli(
    ["credits", "buy", "--link", "--pack", "p5", "--amount", "1000"],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.equal(loginArgs.length, 0);
  assert.equal(upgradeArgs.length, 1);
  const scopeAt = upgradeArgs[0]!.indexOf("--scope");
  // Asks for the sign-in scope too, so a failed session refresh keeps it.
  assert.equal(upgradeArgs[0]![scopeAt + 1], "userinfo:read payment_methods.agentic");
  assert.match(cap.err(), /https:\/\/app\.link\.com\/device\/setup\?code=upgrade/);
  assert.match(cap.out(), /Added p5 scan credits/);
  noSecrets(cap.out() + cap.err());
});

test("credits buy finishes an approved upgrade when Link reports no scope", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "upgrade-then-ok-no-scope";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_upgrade_no_scope";
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  const code = await runCli(
    ["credits", "buy", "--link", "--pack", "p5", "--amount", "1000"],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.doesNotMatch(cap.err(), /timed out/);
  assert.match(cap.out(), /Added p5 scan credits/);
  noSecrets(cap.out() + cap.err());
});

test("credits buy logs in with the payment scope when Link has no session", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "unauth-then-ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_login_pay_token_xyz";
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  const upgradeArgs: string[][] = [];
  const loginArgs: string[][] = [];
  const inner = deps.execFile;
  deps.execFile = async (file, args, opts) => {
    if (args[0] === "auth" && args[1] === "upgrade") upgradeArgs.push([...args]);
    if (args[0] === "auth" && args[1] === "login") loginArgs.push([...args]);
    return inner(file, args, opts);
  };
  const code = await runCli(
    ["credits", "buy", "--link", "--pack", "p5", "--amount", "1000"],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.equal(upgradeArgs.length, 0);
  assert.equal(loginArgs.length, 1);
  const scopeAt = loginArgs[0]!.indexOf("--scope");
  // Without the sign-in scope a later `login --link` could not get attestations.
  assert.equal(loginArgs[0]![scopeAt + 1], "userinfo:read payment_methods.agentic");
  assert.match(cap.err(), /sign in and allow CleanSlop to request Link payments\. This only grants permission/);
  assert.match(cap.out(), /Added p5 scan credits/);
  noSecrets(cap.out() + cap.err());
});

test("credits buy with an existing payment grant does not upgrade or re-login", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_existing_grant_token";
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
    },
  });
  const authArgs: string[][] = [];
  const inner = deps.execFile;
  deps.execFile = async (file, args, opts) => {
    if (args[0] === "auth" && (args[1] === "upgrade" || args[1] === "login")) {
      authArgs.push([...args]);
    }
    return inner(file, args, opts);
  };
  const code = await runCli(
    ["credits", "buy", "--link", "--pack", "p5", "--amount", "1000"],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.deepEqual(authArgs, []);
  noSecrets(cap.out() + cap.err());
});

test("credits buy test-mode retrieve 404 falls back to spend-request list", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "spend-retrieve-not-found";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_list_fallback_token";
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
      CLEANSLOP_LINK_TEST: "1",
    },
  });
  const listCalls: string[][] = [];
  const inner = deps.execFile;
  deps.execFile = async (file, args, opts) => {
    if (args[0] === "spend-request" && args[1] === "list") listCalls.push([...args]);
    return inner(file, args, opts);
  };
  const code = await runCli(
    ["credits", "buy", "--link", "--pack", "p5", "--amount", "1000"],
    deps
  );
  assert.equal(code, 0, cap.err());
  assert.ok(listCalls.length >= 1);
  assert.match(cap.out(), /Added p5 scan credits/);
  noSecrets(cap.out() + cap.err());
});

test("credits buy test-mode stops when list returns an approved request without a token", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "spend-retrieve-not-found";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_LIST_NO_SPT = "1";
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
      CLEANSLOP_LINK_TEST: "1",
    },
  });
  const code = await runCli(
    ["credits", "buy", "--link", "--pack", "p5", "--amount", "1000"],
    deps
  );
  assert.notEqual(code, 0);
  assert.match(cap.err(), /cannot return its payment token/);
  assert.doesNotMatch(cap.out(), /Added p5 scan credits/);
  noSecrets(cap.out() + cap.err());
});

test("credits buy surfaces a failed payment grant upgrade", async () => {
  const { deps, cap } = makeDeps({
    origin: "https://app.example",
    home: tempHome(),
    envExtra: {
      CLEANSLOP_LINK_CLI: FAKE_LINK_CLI,
      CLEANSLOP_TOKEN: TEST_TOKEN,
      CLEANSLOP_STRIPE_PROFILE_ID: "profile_test",
      FAKE_LINK_MODE: "auth-upgrade-fail",
    },
  });
  process.env.FAKE_LINK_MODE = "auth-upgrade-fail";
  const code = await runCli(
    ["credits", "buy", "--link", "--pack", "p5", "--amount", "1000"],
    deps
  );
  assert.equal(code, 10);
  assert.match(cap.err(), /Link upgrade failed/);
});

test("credits buy --resume drops a live request saved against a test profile", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_never_used";
  const { deps, cap, clock } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  await writePendingSpend(deps, {
    version: 1,
    origin: fake.origin,
    spendRequestId: "sr_live_1",
    pack: "p5",
    amount: 500,
    currency: "usd",
    networkId: "profile_test_sandbox",
    purchaseUrl: `${fake.origin}/api/agent/v1/credits/purchases`,
    createdAt: clock.now(),
  });
  assert.equal(await runCli(["credits", "buy", "--link", "--resume"], deps), 10);
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: ask_human/);
  assert.match(cap.err(), /created in live mode/);
  assert.match(cap.err(), /credits buy --link --pack p5 --no-wait/);
  const restart = questionFrom(cap.err());
  assert.equal(restart?.id, "link_payment_restart");
  assert.equal(restart?.options[0]?.run, "cleanslop credits buy --link --pack p5 --no-wait");
  assert.equal(deps.fs.exists(pendingSpendPath(deps)), false);
  assert.equal(readState(statePath).creates, 0);
  assert.equal(fake.state.purchases.length, 0);
});

test("credits buy --resume finishes a saved test-mode request", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_resumed_test_mode";
  const { deps, cap, clock } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  await writePendingSpend(deps, {
    version: 1,
    origin: fake.origin,
    spendRequestId: "sr_test_mode_1",
    pack: "p5",
    amount: 500,
    currency: "usd",
    networkId: "profile_test_sandbox",
    purchaseUrl: `${fake.origin}/api/agent/v1/credits/purchases`,
    createdAt: clock.now(),
    testMode: true,
  });
  assert.equal(await runCli(["credits", "buy", "--link", "--resume"], deps), 0, cap.err());
  assert.match(cap.out(), /Added p5 scan credits/);
  assert.equal(fake.state.purchases.length, 1);
  assert.equal(readState(statePath).creates, 0);
});

test("credits buy finishes when the server refuses or cannot take spend-request reports", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  fake.state.spendEventStatus = 404;
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_reports_refused";
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  assert.equal(await runCli(["credits", "buy", "--link", "--pack", "p5"], deps), 0, cap.err());
  assert.match(cap.out(), /Added p5 scan credits/);
  assert.deepEqual(
    fake.state.spendEvents.map((e) => e.event),
    ["created", "approved"]
  );

  // A network failure on the report is swallowed too, and not marked sent.
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_SPEND_STATUS = "pending_approval";
  const down = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  const realRequest = down.deps.request;
  down.deps.request = async (url, init) => {
    if (String(url).endsWith("/api/agent/v1/credits/spend-requests")) {
      throw new Error("offline");
    }
    return realRequest(url, init);
  };
  assert.equal(
    await runCli(["credits", "buy", "--link", "--pack", "p5", "--no-wait"], down.deps),
    10,
    down.cap.err()
  );
  assert.match(down.cap.err(), /CLEANSLOP_ACTION_REQUIRED: approve/);
  const saved = JSON.parse(down.deps.fs.read(pendingSpendPath(down.deps))) as {
    reported?: string[];
  };
  assert.equal(saved.reported, undefined);
});

test("an agent's credits buy names the monthly plan for a Link-only account", async () => {
  const promo = { command: "cleanslop redeem <code>", mcpTool: "promo_redeem" };
  const offer = (pack: string, amount: number, origin: string) => ({
    kind: "stripe_spt",
    pack,
    amount,
    currency: "usd",
    networkId: "profile_offer",
    purchaseUrl: `${origin}/api/agent/v1/credits/purchases`,
  });
  const webBilling = (origin: string) => ({ url: `${origin}/signin/email`, emailMasked: "s***@p***.io" });
  const fake = await startFakeServer((state) => {
    state.offers = {
      payment: {
        methods: [offer("p5", 500, state.origin), offer("p15", 1200, state.origin)],
        promo,
        webBilling: webBilling(state.origin),
      },
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  const env = { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN };
  const run = async (argv: string[]) => {
    const { deps, cap } = makeDeps({ origin: fake.origin, home, envExtra: env, stdinIsTTY: false });
    assert.equal(await runCli(argv, deps), 10, cap.err());
    return cap.err();
  };
  const hint = /For a monthly plan instead, run `cleanslop billing`/;

  const first = await run(["credits", "buy", "--link", "--no-wait"]);
  assert.match(first, hint);
  assert.deepEqual(
    questionFrom(first)?.options.map((o) => o.value),
    ["buy", "promo", "web_billing", "none"]
  );

  // Two packs plus "Not now" leave room for the monthly plan.
  const packs = await run(["credits", "buy", "--link", "--no-promo", "--no-wait"]);
  assert.match(packs, hint);
  assert.deepEqual(
    questionFrom(packs)?.options.map((o) => o.value),
    ["p5", "p15", "web_billing", "none"]
  );
  assert.equal(readState(statePath).creates, 0);
});
