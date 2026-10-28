import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import {
  deleteAllLocalState,
  deletePendingFor,
  pendingSpendPath,
  readPendingSpend,
  writePendingSpend,
  type PendingSpendRequest,
} from "../src/credentials.js";
import { currentPlanFromBody, parsePlanId, planOffersFromBody } from "../src/commands/plan.js";
import { runCli } from "../src/main.js";
import { startFakeServer, type FakeState } from "./fake-server.js";
import { TEST_TOKEN, assertNoToken, makeDeps, questionFrom, tempHome } from "./helpers.js";

const FAKE_LINK_CLI = join(dirname(fileURLToPath(import.meta.url)), "fake-link-cli.mjs");
chmodSync(FAKE_LINK_CLI, 0o755);

const cleanups: Array<() => Promise<void> | void> = [];
const envKeys = ["FAKE_LINK_MODE", "FAKE_LINK_STATE", "FAKE_SPEND_STATUS", "FAKE_SPT"] as const;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  for (const key of envKeys) delete process.env[key];
});

const PLAN_URL = (origin: string) => `${origin}/api/agent/v1/plans/purchases`;

function planOffers(origin: string) {
  return [
    { plan: "starter", name: "Starter", amount: 1900, currency: "usd", interval: "month", networkId: "profile_offer", purchaseUrl: PLAN_URL(origin) },
    { plan: "pro", name: "Pro", amount: 4900, currency: "usd", interval: "month", networkId: "profile_offer", purchaseUrl: PLAN_URL(origin) },
    { plan: "max", name: "Max", amount: 9900, currency: "usd", interval: "month", networkId: "profile_offer", purchaseUrl: PLAN_URL(origin) },
  ];
}

async function planServer(patch?: (state: FakeState) => void) {
  const fake = await startFakeServer((state) => {
    state.offers = { payment: { methods: [], plans: planOffers(state.origin) } };
    patch?.(state);
  });
  cleanups.push(fake.close);
  return fake;
}

function linkState(home: string, mode = "ok") {
  const path = join(home, "fake-link-state.json");
  writeFileSync(path, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = mode;
  process.env.FAKE_LINK_STATE = path;
  return () =>
    JSON.parse(readFileSync(path, "utf8")) as {
      creates: number;
      lastAmount?: string | null;
      lastRecurring?: string | null;
    };
}

function runPlan(origin: string, home: string, argv: string[], stdinIsTTY = false) {
  const made = makeDeps({
    origin,
    home,
    stdinIsTTY,
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  return runCli(["plan", ...argv], made.deps).then((code) => ({ code, ...made }));
}

function noSecrets(text: string) {
  assertNoToken(text);
  assert.doesNotMatch(text, /spt_[A-Za-z0-9]{6,}/);
}

test("parsePlanId and planOffersFromBody read plans, with team as Max", () => {
  assert.equal(parsePlanId("Max"), "max");
  assert.equal(parsePlanId("team"), "max");
  assert.equal(parsePlanId(" pro "), "pro");
  assert.equal(parsePlanId("gold"), null);
  assert.equal(parsePlanId(null), null);
  const offers = planOffersFromBody({
    payment: {
      plans: [
        { plan: "team", amount: "9900", networkId: "p", purchaseUrl: "/u" },
        { plan: "starter", name: " ", amount: 1900, currency: "cad", networkId: "p", purchaseUrl: "/u" },
        { plan: "gold", amount: 100, networkId: "p", purchaseUrl: "/u" },
        { plan: "pro", amount: 0, networkId: "p", purchaseUrl: "/u" },
        { plan: "pro", amount: 4900, networkId: "", purchaseUrl: "/u" },
        { plan: "pro", amount: 4900, networkId: "p" },
        "nope",
      ],
    },
  });
  assert.deepEqual(offers, [
    { plan: "max", name: "Max", amount: 9900, currency: "usd", networkId: "p", purchaseUrl: "/u" },
    { plan: "starter", name: "Starter", amount: 1900, currency: "cad", networkId: "p", purchaseUrl: "/u" },
  ]);
  assert.deepEqual(planOffersFromBody({ payment: { plans: "x" } }), []);
  assert.deepEqual(planOffersFromBody(null), []);
});

test("an agent's plan without a name asks which plan and creates nothing", async () => {
  const fake = await planServer();
  const home = tempHome();
  const read = linkState(home);
  const { code, cap } = await runPlan(fake.origin, home, []);
  assert.equal(code, 10, cap.err());
  assert.match(cap.err(), /Starter \(19\.00 USD per month\), Pro \(49\.00 USD per month\), or Max \(99\.00 USD per month\)/);
  assert.match(cap.err(), /until you cancel the plan with `cleanslop billing`/);
  const question = questionFrom(cap.err());
  assert.equal(question?.id, "link_plan");
  assert.deepEqual(
    question?.options.map((o) => [o.value, o.label, o.run]),
    [
      ["starter", "Starter · 19.00 USD per month", "cleanslop plan starter --no-wait"],
      ["pro", "Pro · 49.00 USD per month", "cleanslop plan pro --no-wait"],
      ["max", "Max · 99.00 USD per month", "cleanslop plan max --no-wait"],
      ["none", "Not now", undefined],
    ]
  );
  assert.equal(read().creates, 0);

  const bad = await runPlan(fake.origin, home, ["gold"]);
  assert.equal(bad.code, 2);
  assert.match(bad.cap.err(), /Usage: cleanslop plan \[starter\|pro\|max\]/);
});

test("plan pro at a terminal creates a monthly spend request, waits, and starts the plan", async () => {
  const fake = await planServer();
  const home = tempHome();
  const read = linkState(home);
  process.env.FAKE_SPT = "spt_plan_token_xyz";
  const { code, cap, deps } = await runPlan(fake.origin, home, ["pro"], true);
  assert.equal(code, 0, cap.err());
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: approve/);
  assert.match(cap.err(), /Pro plan \(49\.00 USD per month, charged each month/);
  assert.match(cap.out(), /Started the CleanSlop Pro plan \(active\)\. Change or cancel it with `cleanslop billing`/);
  noSecrets(cap.out() + cap.err());
  const state = read();
  assert.equal(state.creates, 1);
  assert.equal(state.lastAmount, "4900");
  assert.equal(state.lastRecurring, "month");
  assert.deepEqual(fake.state.planPurchases, [
    { plan: "pro", sharedPaymentToken: "spt_plan_token_xyz", spendRequestId: "sr_test_1" },
  ]);
  assert.deepEqual(
    fake.state.spendEvents.map((e) => [e.event, e.pack, e.amount]),
    [["created", "pro", 4900], ["approved", "pro", 4900]]
  );
  assert.equal(deps.fs.exists(pendingSpendPath(deps, "plan")), false);
  assert.equal(deps.fs.exists(pendingSpendPath(deps)), false);
});

test("plan max --no-wait saves a plan request apart from packs, and --resume starts it", async () => {
  const fake = await planServer((state) => {
    state.planReply = { status: 200, body: { plan: "max", name: "Max", status: "active" } };
  });
  const home = tempHome();
  const read = linkState(home);
  process.env.FAKE_SPEND_STATUS = "pending_approval";
  const first = await runPlan(fake.origin, home, ["max", "--no-wait"]);
  assert.equal(first.code, 10, first.cap.err());
  assert.match(first.cap.err(), /approve the CleanSlop Max plan/);
  assert.match(first.cap.err(), /run `cleanslop plan --resume`/);
  assert.equal(questionFrom(first.cap.err())?.options[0]?.run, "cleanslop plan --resume");
  const saved = readPendingSpend(first.deps, "plan");
  assert.equal(saved?.pack, "max");
  assert.equal(saved?.purchaseUrl, PLAN_URL(fake.origin));
  assert.equal(first.deps.fs.exists(pendingSpendPath(first.deps)), false);

  // Still not approved: the not-approved block names the plan and its resume command.
  const waiting = await runPlan(fake.origin, home, ["--no-wait"]);
  assert.equal(waiting.code, 10);
  assert.match(waiting.cap.err(), /approve this CleanSlop Max plan/);
  assert.equal(read().creates, 1);

  delete process.env.FAKE_SPEND_STATUS;
  const resumed = await runPlan(fake.origin, home, ["--resume"]);
  assert.equal(resumed.code, 0, resumed.cap.err());
  assert.match(resumed.cap.out(), /Started the CleanSlop Max plan/);
  assert.equal(fake.state.planPurchases[0]?.plan, "max");
  assert.equal(read().creates, 1);
  assert.equal(resumed.deps.fs.exists(pendingSpendPath(resumed.deps, "plan")), false);
});

test("plan --resume needs a saved request; a different plan replaces it", async () => {
  const fake = await planServer();
  const home = tempHome();
  const read = linkState(home);
  const none = await runPlan(fake.origin, home, ["--resume"]);
  assert.equal(none.code, 2);
  assert.match(none.cap.err(), /No Link plan approval to resume/);

  const pending: PendingSpendRequest = {
    version: 1,
    origin: fake.origin,
    spendRequestId: "sr_old_starter",
    pack: "starter",
    amount: 1900,
    currency: "usd",
    networkId: "profile_offer",
    purchaseUrl: PLAN_URL(fake.origin),
    createdAt: 1,
    testMode: false,
  };
  await writePendingSpend(none.deps, pending, "plan");
  process.env.FAKE_SPEND_STATUS = "pending_approval";
  const switched = await runPlan(fake.origin, home, ["pro", "--no-wait"]);
  assert.equal(switched.code, 10, switched.cap.err());
  assert.equal(read().creates, 1);
  assert.equal(readPendingSpend(switched.deps, "plan")?.pack, "pro");
});

test("plan stops before any spend request when the account already has a plan", async () => {
  assert.deepEqual(currentPlanFromBody({ payment: { currentPlan: { name: " ", status: "weird" } } }), {
    name: "monthly",
    status: "active",
  });
  assert.equal(currentPlanFromBody({ payment: {} }), null);

  const home = tempHome();
  const read = linkState(home);
  const active = await startFakeServer((state) => {
    state.offers = { payment: { methods: [], currentPlan: { plan: "pro", name: "Pro", status: "active" } } };
  });
  cleanups.push(active.close);
  const has = await runPlan(active.origin, home, ["max"]);
  assert.equal(has.code, 10, has.cap.err());
  assert.match(has.cap.err(), /CLEANSLOP_ACTION_REQUIRED: ask_human/);
  assert.match(has.cap.err(), /already has the CleanSlop Pro plan, so no Link approval was requested/);
  assert.match(has.cap.err(), /run `cleanslop billing`/);

  const pending = await startFakeServer((state) => {
    state.offers = { payment: { methods: [], currentPlan: { plan: "max", name: "Max", status: "pending" } } };
  });
  cleanups.push(pending.close);
  const setting = await runPlan(pending.origin, home, []);
  assert.equal(setting.code, 10, setting.cap.err());
  assert.match(setting.cap.err(), /CLEANSLOP_ACTION_REQUIRED: wait/);
  assert.match(setting.cap.err(), /Max plan is already being set up/);
  assert.equal(read().creates, 0);
  assert.equal(active.state.planPurchases.length + pending.state.planPurchases.length, 0);
});

test("plan falls back to the website when no Link plans are offered", async () => {
  const fake = await startFakeServer((state) => {
    state.offers = { payment: { methods: [] } };
    state.webBilling = { url: `${state.origin}/signin/email`, emailMasked: "s***@p***.io" };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  linkState(home);
  const { code, cap } = await runPlan(fake.origin, home, ["pro"]);
  assert.equal(code, 10, cap.err());
  assert.equal(fake.state.billingLinkPosts, 1);
  assert.match(cap.err(), /We emailed a sign-in link to s\*\*\*@p\*\*\*\.io/);
});

test("plan maps the server's answers after approval", async () => {
  const home = tempHome();
  linkState(home);
  const run = async (reply: { status: number; body: Record<string, unknown> }, webBilling = false) => {
    const fake = await planServer((state) => {
      state.planReply = reply;
      if (webBilling) state.webBilling = { url: `${state.origin}/signin/email`, emailMasked: "s***@p***.io" };
    });
    const out = await runPlan(fake.origin, tempHome(), ["starter"], true);
    return { ...out, fake, pendingLeft: out.deps.fs.exists(pendingSpendPath(out.deps, "plan")) };
  };

  const declined = await run({
    status: 402,
    body: { error: "payment_failed", message: "The Link payment for this plan could not be completed.", reason: "card_declined" },
  });
  assert.equal(declined.code, 11);
  assert.match(declined.cap.err(), /Link could not pay for the Starter plan \(card_declined\)/);
  assert.match(declined.cap.err(), /`cleanslop plan starter --no-wait`/);
  assert.equal(declined.pendingLeft, false);

  const bare402 = await run({ status: 402, body: { error: "payment_failed" } });
  assert.match(bare402.cap.err(), /\(payment_failed\)/);

  const exists = await run({
    status: 409,
    body: { error: "invalid_request", message: "This account already has a monthly plan.", reason: "subscription_exists", plan: "max" },
  });
  assert.equal(exists.code, 10);
  assert.match(exists.cap.err(), /already has the CleanSlop Max plan, so the Link approval was not used and nothing was charged/);
  assert.match(exists.cap.err(), /To change or cancel it, run `cleanslop billing`/);
  assert.equal(exists.pendingLeft, false);

  const racing = await run({
    status: 409,
    body: { error: "invalid_request", message: "A monthly plan is already being set up.", reason: "plan_in_progress" },
  });
  assert.equal(racing.code, 10);
  assert.match(racing.cap.err(), /CLEANSLOP_ACTION_REQUIRED: wait/);
  assert.match(racing.cap.err(), /CleanSlop monthly plan is already being set up/);
  assert.equal(racing.pendingLeft, false);

  const processing = await run({
    status: 503,
    body: { error: "link_unavailable", message: "Still processing.", reason: "pending" },
  });
  assert.equal(processing.code, 10);
  assert.match(processing.cap.err(), /CLEANSLOP_ACTION_REQUIRED: wait/);
  assert.match(processing.cap.err(), /`cleanslop plan --resume` in a minute/);
  assert.equal(processing.pendingLeft, true);

  const review = await run({
    status: 503,
    body: { error: "link_unavailable", message: "This plan payment is under review.", reason: "needs_review" },
  });
  assert.equal(review.code, 1);
  assert.match(review.cap.err(), /under review/);
  assert.equal(review.pendingLeft, false);

  const off = await run({ status: 404, body: { error: "not_found", message: "Not found." } }, true);
  assert.equal(off.code, 10);
  assert.equal(off.fake.state.billingLinkPosts, 1);
  assert.equal(off.pendingLeft, false);

  const defaults = await run({ status: 200, body: {} });
  assert.equal(defaults.code, 0);
  assert.match(defaults.cap.out(), /Started the CleanSlop Starter plan \(active\)/);
});

test("plan restarts after a denial and resumes when the token is late", async () => {
  const fake = await planServer();
  const home = tempHome();
  linkState(home);
  process.env.FAKE_SPEND_STATUS = "denied";
  const denied = await runPlan(fake.origin, home, ["pro"], true);
  assert.equal(denied.code, 10);
  const retry = questionFrom(denied.cap.err());
  assert.equal(retry?.id, "link_plan_retry");
  assert.match(retry?.question ?? "", /Pro plan was denied/);
  assert.equal(retry?.options[0]?.run, "cleanslop plan pro --no-wait");
  assert.equal(denied.deps.fs.exists(pendingSpendPath(denied.deps, "plan")), false);

  delete process.env.FAKE_SPEND_STATUS;
  const lateHome = tempHome();
  linkState(lateHome, "spt-missing");
  const late = await runPlan(fake.origin, lateHome, ["pro"], true);
  assert.equal(late.code, 10);
  assert.match(late.cap.err(), /Run `cleanslop plan --resume` — do not create a new spend request/);
  assert.equal(late.deps.fs.exists(pendingSpendPath(late.deps, "plan")), true);
  assert.ok(fake.state.spendEvents.some((e) => e.event === "token_missing" && e.pack === "pro"));
});

test("logout drops a saved plan request with the pack one", async () => {
  const home = tempHome();
  const { deps } = makeDeps({ origin: "https://app.example", home });
  const base: PendingSpendRequest = {
    version: 1,
    origin: "https://app.example",
    spendRequestId: "sr_1",
    pack: "pro",
    amount: 4900,
    currency: "usd",
    networkId: "p",
    purchaseUrl: "/u",
    createdAt: 1,
  };
  await writePendingSpend(deps, base, "plan");
  await writePendingSpend(deps, { ...base, pack: "p5" });
  deletePendingFor(deps, "https://app.example");
  assert.equal(deps.fs.exists(pendingSpendPath(deps, "plan")), false);
  assert.equal(deps.fs.exists(pendingSpendPath(deps)), false);
  await writePendingSpend(deps, base, "plan");
  deleteAllLocalState(deps);
  assert.equal(deps.fs.exists(pendingSpendPath(deps, "plan")), false);
});

test("out of scans points at `cleanslop plan` when Link plans are on", async () => {
  const packs = (origin: string) =>
    ["p5", "p15"].map((pack, i) => ({
      kind: "stripe_spt",
      pack,
      amount: [500, 1200][i],
      currency: "usd",
      networkId: "profile_offer",
      purchaseUrl: `${origin}/api/agent/v1/credits/purchases`,
    }));
  const fake = await startFakeServer((state) => {
    state.scanError = {
      status: 402,
      body: {
        error: "out_of_scans",
        message: "This account is out of scans. To start a monthly plan, run `cleanslop plan`.",
        payment: { methods: [], plans: planOffers(state.origin) },
      },
    };
    state.offers = { payment: { methods: packs(state.origin), plans: planOffers(state.origin) } };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  linkState(home);
  const env = { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI, CLEANSLOP_TOKEN: TEST_TOKEN };

  const scan = makeDeps({ origin: fake.origin, home, envExtra: env, stdinIsTTY: false });
  assert.equal(await runCli(["scan"], scan.deps), 11, scan.cap.err());
  const question = questionFrom(scan.cap.err());
  assert.equal(question?.question, "This account is out of scans. Start a monthly CleanSlop plan paid with Link?");
  assert.deepEqual(question?.options, [
    { value: "link_plan", label: "Monthly plan", description: "Start a monthly plan paid with Link", run: "cleanslop plan" },
    { value: "none", label: "Not now", description: "Buy nothing" },
  ]);

  const buy = makeDeps({ origin: fake.origin, home, envExtra: env, stdinIsTTY: false });
  assert.equal(await runCli(["credits", "buy", "--link", "--no-promo", "--no-wait"], buy.deps), 10);
  assert.match(buy.cap.err(), /For a monthly plan instead, run `cleanslop plan` and relay what it prints/);
  assert.deepEqual(
    questionFrom(buy.cap.err())?.options.map((o) => o.value),
    ["p5", "p15", "link_plan", "none"]
  );
});
