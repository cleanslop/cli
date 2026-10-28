#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = process.env.FAKE_LINK_MODE ?? "ok";
const joined = args.join(" ");

function writeOut(value) {
  process.stdout.write(JSON.stringify(value));
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const EMPTY_STATE = {
  creates: 0,
  includeRetrieves: 0,
  polls: 0,
  authPolls: 0,
  logins: 0,
  upgrades: 0,
  attestationRequests: 0,
  credentialRequests: 0,
};

const UNAUTH_MODES = [
  "unauth",
  "unauth-then-ok",
  "auth-login-fail",
  "auth-login-no-url",
];

function scopeFromArgs(argv) {
  const at = argv.indexOf("--scope");
  return at >= 0 ? String(argv[at + 1] ?? "") : "";
}

function loadState() {
  const path = process.env.FAKE_LINK_STATE;
  if (!path || !existsSync(path)) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      creates: Number(parsed.creates) || 0,
      includeRetrieves: Number(parsed.includeRetrieves) || 0,
      polls: Number(parsed.polls) || 0,
      lastAmount: typeof parsed.lastAmount === "string" ? parsed.lastAmount : null,
      lastNetworkId:
        typeof parsed.lastNetworkId === "string" ? parsed.lastNetworkId : null,
      lastTest: parsed.lastTest === true,
      lastRecurring:
        typeof parsed.lastRecurring === "string" ? parsed.lastRecurring : null,
      lastCreateStatus:
        typeof parsed.lastCreateStatus === "string" ? parsed.lastCreateStatus : null,
      authPolls: Number(parsed.authPolls) || 0,
      logins: Number(parsed.logins) || 0,
      upgrades: Number(parsed.upgrades) || 0,
      scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
      lastScope: typeof parsed.lastScope === "string" ? parsed.lastScope : null,
      attestationRequests: Number(parsed.attestationRequests) || 0,
      credentialRequests: Number(parsed.credentialRequests) || 0,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function saveState(state) {
  const path = process.env.FAKE_LINK_STATE;
  if (!path) return;
  writeFileSync(path, `${JSON.stringify(state)}\n`);
}

if (joined.includes("auth status")) {
  if (mode === "auth-status-fail") fail("Link auth status failed");
  const state = loadState();
  let authenticated = !UNAUTH_MODES.includes(mode);
  if (mode === "unauth-then-ok") {
    if (state.logins > 0) state.authPolls += 1;
    authenticated = state.authPolls >= 2;
    saveState(state);
  }
  const upgradeMode =
    mode === "upgrade-then-ok" || mode === "upgrade-then-ok-no-scope";
  if (upgradeMode) {
    if (state.upgrades > 0) state.authPolls += 1;
    saveState(state);
    // Like link-cli: a pending upgrade that replaces the session reports
    // authenticated:false until the human approves it.
    authenticated = state.upgrades === 0 || state.authPolls >= 2;
  }
  let scope = "";
  // scope-hidden: link-cli only reports scope when Link's token response has it.
  if (mode === "upgrade-then-ok-no-scope" || mode === "scope-hidden") {
    scope = "";
  } else if (mode === "upgrade-then-ok") {
    scope = state.upgrades > 0 && state.authPolls >= 2 ? "payment_methods.agentic" : "";
  } else if (typeof state.scope === "string") {
    scope = state.scope;
  } else if (
    authenticated &&
    mode !== "auth-upgrade-fail" &&
    mode !== "auth-upgrade-no-url"
  ) {
    scope = "userinfo:read payment_methods.agentic";
  }
  writeOut([
    authenticated
      ? {
          authenticated: true,
          access_token: "lsk_test_secret_prefix...",
          update: null,
          ...(scope ? { scope } : {}),
        }
      : { authenticated: false, update: null },
  ]);
  process.exit(0);
}

if (joined.includes("auth upgrade")) {
  if (mode === "auth-upgrade-fail") fail("Link upgrade failed");
  const state = loadState();
  state.upgrades += 1;
  state.lastScope = scopeFromArgs(args);
  if (state.lastScope) {
    const tokens = new Set(
      `${state.scope ?? ""} ${state.lastScope}`.trim().split(/\s+/).filter(Boolean)
    );
    state.scope = [...tokens].join(" ");
  }
  saveState(state);
  if (mode === "auth-upgrade-no-url") {
    writeOut([{ phrase: "apple-banana" }]);
    process.exit(0);
  }
  writeOut([
    {
      verification_url: "https://app.link.com/device/setup?code=upgrade",
      phrase: "pear-mango-melon",
      instruction: "Present the verification_url and phrase to the user.",
      _next: { command: "auth status --interval 5 --max-attempts 60" },
    },
  ]);
  process.exit(0);
}

if (joined.includes("auth login")) {
  if (mode === "auth-login-fail") fail("Link login failed");
  const state = loadState();
  state.logins += 1;
  state.lastScope = scopeFromArgs(args);
  if (state.lastScope) state.scope = state.lastScope;
  saveState(state);
  if (mode === "auth-login-no-url") {
    writeOut([{ phrase: "apple-banana" }]);
    process.exit(0);
  }
  writeOut([
    {
      verification_url: "https://app.link.com/device/setup?code=test",
      phrase: "apple-banana-cherry",
      instruction: "Present the verification_url and phrase to the user.",
      _next: { command: "auth status --interval 5 --max-attempts 60" },
    },
  ]);
  process.exit(0);
}

if (mode === "crash-json") {
  process.stdout.write("not-json");
  process.exit(0);
}

if (joined.includes("attestations pop")) {
  if (mode === "empty" || mode === "attest-request-fail") {
    fail(
      "The attestation pool is empty. Run identity attestations request --count 10 to refill it."
    );
  }
  if (
    (mode === "empty-once" || mode === "scope-hidden") &&
    loadState().attestationRequests === 0
  ) {
    fail(
      JSON.stringify({
        code: "ATTESTATION_POOL_EMPTY",
        message:
          "The attestation pool is empty. Run identity attestations request --count 10 to refill it.",
      })
    );
  }
  writeOut({
    authorization:
      process.env.FAKE_LINK_AUTH ?? 'PrivateToken token="aat-test-token"',
  });
  process.exit(0);
}

if (joined.includes("credentials present")) {
  if (mode === "no-cred" || mode === "cred-request-fail") fail("no credential available");
  if (mode === "no-saved-cred" && loadState().credentialRequests === 0) {
    fail("No saved identity credential. Run identity credentials request first.");
  }
  if (mode === "expired-cred" && loadState().credentialRequests === 0) {
    fail("Saved identity credential has expired. Run identity credentials request again.");
  }
  writeOut({
    presentation:
      process.env.FAKE_LINK_PRESENTATION ??
      "eyJhbGciOiJFUzI1NiJ9.e30.presentation-sig",
  });
  process.exit(0);
}

if (joined.includes("credentials request")) {
  if (mode === "cred-request-fail") fail("Link could not issue an identity credential");
  const state = loadState();
  state.credentialRequests += 1;
  saveState(state);
  process.exit(0);
}

if (joined.includes("attestations request")) {
  if (mode === "attest-request-fail") fail("Link refused the attestation request");
  const state = loadState();
  if (
    typeof state.scope === "string" &&
    !state.scope.split(/\s+/).includes("userinfo:read")
  ) {
    fail(
      JSON.stringify({
        code: "UNKNOWN",
        message:
          'Failed to issue attestation tokens (401): {"error":{"message":"Access token is missing required scopes: read_email, read_phone, read_name, read_avatar, userinfo.addresses:read"}}',
      })
    );
  }
  state.attestationRequests += 1;
  saveState(state);
  process.exit(0);
}

if (joined.includes("spend-request create")) {
  if (mode === "spend-create-fail") fail("could not create spend request");
  if (mode === "spend-create-bad-json") {
    process.stdout.write("not-json");
    process.exit(0);
  }
  const state = loadState();
  state.creates += 1;
  const amountIdx = args.indexOf("--amount");
  const networkIdx = args.indexOf("--network-id");
  state.lastAmount = amountIdx >= 0 ? args[amountIdx + 1] ?? null : null;
  state.lastNetworkId = networkIdx >= 0 ? args[networkIdx + 1] ?? null : null;
  state.lastTest = args.includes("--test");
  const recurringIdx = args.indexOf("--recurring-interval");
  state.lastRecurring = recurringIdx >= 0 ? args[recurringIdx + 1] ?? null : null;
  const id = process.env.FAKE_SPEND_REQUEST_ID ?? "sr_test_1";
  state.lastCreateStatus = "pending_approval";
  saveState(state);
  writeOut([
    {
      id,
      status: "pending_approval",
      approval_url: "https://app.link.com/spend/approve?code=test",
      instruction: `Present the approval_url to the user and ask them to approve in the Link app. Then call \`spend-request retrieve ${id} --interval 2 --max-attempts 300\` to wait for a status change and inspect the returned status. Do not wait for the user to reply — start polling immediately.`,
      _next: {
        command: `spend-request retrieve ${id} --interval 2 --max-attempts 300`,
        until: `status changes from pending_approval`,
      },
    },
  ]);
  process.exit(0);
}

if (joined.includes("spend-request list")) {
  const id = process.env.FAKE_SPEND_REQUEST_ID ?? "sr_test_1";
  const token = process.env.FAKE_SPT ?? "spt_test_1";
  writeOut([
    {
      id,
      status: process.env.FAKE_SPEND_STATUS ?? "approved",
      ...(process.env.FAKE_LIST_NO_SPT === "1" ? {} : { shared_payment_token: token }),
    },
  ]);
  process.exit(0);
}

if (joined.includes("spend-request retrieve")) {
  const scoped = loadState().scope;
  if (
    typeof scoped === "string" &&
    !scoped.split(/\s+/).includes("payment_methods.agentic")
  ) {
    fail(
      JSON.stringify({
        code: "UNKNOWN",
        message:
          'Failed to retrieve spend request (401): {"error":{"message":"Access token is missing required scopes: payment_methods.agentic"}}',
      })
    );
  }
  if (mode === "spend-retrieve-not-found") {
    fail(JSON.stringify({
      code: "NOT_FOUND",
      message: `Spend request ${process.env.FAKE_SPEND_REQUEST_ID ?? "sr_test_1"} not found`,
    }));
  }
  if (mode === "spend-retrieve-fail") fail("could not retrieve spend request");
  if (mode === "spend-retrieve-bad-json") {
    process.stdout.write("not-json");
    process.exit(0);
  }
  const includeSpt =
    args.includes("--include") && args.includes("shared_payment_token");
  const id = process.env.FAKE_SPEND_REQUEST_ID ?? "sr_test_1";
  const status = process.env.FAKE_SPEND_STATUS ?? "approved";
  const state = loadState();
  if (!includeSpt) {
    state.polls = (state.polls || 0) + 1;
    saveState(state);
    if (mode === "spend-auto-resume" && state.polls < 2) {
      writeOut({
        id,
        status: "requires_action",
        next_action: { resolution: { type: "auto_resume" } },
      });
      process.exit(0);
    }
    if (mode === "spend-pending" && state.polls < 2) {
      writeOut({ id, status: "pending_approval" });
      process.exit(0);
    }
    if (status === "requires_action") {
      writeOut({
        id,
        status,
        next_action: {
          resolution: process.env.FAKE_SPEND_RESOLUTION ?? "challenge",
          display_message: "Complete 3DS in Link.",
        },
      });
      process.exit(0);
    }
    writeOut({ id, status });
    process.exit(0);
  }
  state.includeRetrieves += 1;
  saveState(state);
  const token = process.env.FAKE_SPT ?? "spt_test_1";
  if (mode === "spt-missing") {
    writeOut({ id, status: "approved" });
    process.exit(0);
  }
  if (mode === "spt-lag" && state.includeRetrieves < 3) {
    writeOut({ id, status: "approved" });
    process.exit(0);
  }
  if (mode === "spt-object") {
    writeOut({ id, status: "approved", shared_payment_token: { id: token } });
    process.exit(0);
  }
  writeOut({ id, status: "approved", shared_payment_token: token });
  process.exit(0);
}

fail(`unexpected link-cli args: ${joined}`);
