import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runCli } from "../src/main.js";
import { startFakeServer } from "./fake-server.js";
import { TEST_TOKEN, assertNoToken, makeDeps, tempHome } from "./helpers.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function setup(reply?: { status: number; body: Record<string, unknown> }) {
  const fake = await startFakeServer((state) => {
    if (reply) state.redeemReply = reply;
  });
  cleanups.push(fake.close);
  const made = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    envExtra: { CLEANSLOP_TOKEN: TEST_TOKEN },
    stdinIsTTY: false,
  });
  return { fake, ...made };
}

test("redeem posts the code and prints the credits added", async () => {
  const { fake, deps, cap } = await setup();
  assert.equal(await runCli(["redeem", "launch2026"], deps), 0, cap.err());
  assert.deepEqual(fake.state.redeems, [{ code: "launch2026" }]);
  assert.equal(cap.out(), "Promo code applied: added 5 scan credits. Balance: 6.\n");
  assertNoToken(cap.out() + cap.err());
});

test("redeem mentions review credits and prints JSON with --json", async () => {
  const reply = {
    status: 200,
    body: { redeemed: true, scanCredits: 3, reviewCredits: 1, credits: 4 },
  };
  const text = await setup(reply);
  assert.equal(await runCli(["redeem", "PROMO1234"], text.deps), 0);
  assert.equal(text.cap.out(), "Promo code applied: added 3 scan credits and 1 review credits. Balance: 4.\n");
  const json = await setup(reply);
  assert.equal(await runCli(["redeem", "PROMO1234", "--json"], json.deps), 0);
  assert.deepEqual(JSON.parse(json.cap.out()), {
    redeemed: true,
    scanCredits: 3,
    reviewCredits: 1,
    credits: 4,
  });
});

test("redeem without a balance in the reply omits it", async () => {
  const { deps, cap } = await setup({ status: 200, body: { redeemed: true } });
  assert.equal(await runCli(["redeem", "PROMO1234"], deps), 0);
  assert.equal(cap.out(), "Promo code applied: added 0 scan credits.\n");
});

test("redeem needs a code", async () => {
  const { fake, deps, cap } = await setup();
  assert.equal(await runCli(["redeem"], deps), 2);
  assert.match(cap.err(), /cleanslop redeem <code>/);
  assert.equal(fake.state.redeems.length, 0);
});

test("redeem relays an invalid or already-used code to the human (exit 12)", async () => {
  const invalid = await setup({
    status: 422,
    body: { error: "promo_invalid", message: "That promo code has expired.", reason: "expired" },
  });
  assert.equal(await runCli(["redeem", "OLDPROMO1"], invalid.deps), 12);
  assert.match(invalid.cap.err(), /CLEANSLOP_ACTION_REQUIRED: ask_human/);
  assert.match(invalid.cap.err(), /That promo code has expired\./);

  const used = await setup({
    status: 409,
    body: {
      error: "promo_already_redeemed",
      message: "This account has already used a promo or invite code. Each account can use one.",
    },
  });
  assert.equal(await runCli(["redeem", "PROMO1234"], used.deps), 12);
  assert.match(used.cap.err(), /Each account can use one\./);
});
