import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { createDefaultDeps } from "../src/deps.js";
import { credentialsPath, pendingSpendPath, writePendingSpend } from "../src/credentials.js";
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

const FAKE_LINK_CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "fake-link-cli.mjs"
);
chmodSync(FAKE_LINK_CLI, 0o755);

const linkEnvKeys = [
  "FAKE_LINK_MODE",
  "FAKE_LINK_STATE",
  "FAKE_SPEND_REQUEST_ID",
  "FAKE_SPEND_STATUS",
  "FAKE_SPEND_RESOLUTION",
  "FAKE_SPT",
] as const;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
  for (const key of linkEnvKeys) delete process.env[key];
});

function sptOutOfScansBody(
  origin: string,
  packs: Array<{ pack: "p5" | "p15" | "p40"; amount: number; best?: true }> = [
    { pack: "p5", amount: 1000 },
  ],
  promo = false,
  webBilling = false
) {
  return {
    error: "out_of_scans",
    message: "This account is out of scans.",
    action: {
      kind: "ask_human",
      humanPrompt:
        "Ask the human which CleanSlop credit pack to buy with Link: p5 (5 scans, 10.00 USD, 2.00 USD per scan). If they pick one, run `cleanslop credits buy --link --pack <pack> --no-wait`, relay its approval prompt (Link notifies their Link app; there is usually no link), and after they approve run `cleanslop credits buy --link --resume`. Then rerun the scan.",
    },
    payment: {
      methods: packs.map((pack) => ({
        kind: "stripe_spt",
        pack: pack.pack,
        amount: pack.amount,
        currency: "usd",
        networkId: "profile_from_402",
        purchaseUrl: `${origin}/api/agent/v1/credits/purchases`,
        ...(pack.best ? { best: true } : {}),
      })),
      ...(promo
        ? { promo: { command: "cleanslop redeem <code>", mcpTool: "promo_redeem" } }
        : {}),
      ...(webBilling ? { webBilling: WEB_BILLING(origin) } : {}),
    },
  };
}

const WEB_BILLING = (origin: string) => ({
  url: `${origin}/signin/email`,
  emailMasked: "s***@p***.io",
});
const MONTHLY_PLAN = {
  value: "web_billing",
  label: "Monthly plan",
  description: "Subscribe on the CleanSlop website",
  run: "cleanslop billing",
};

function readLinkState(path: string): {
  creates: number;
  lastAmount?: string | null;
  lastNetworkId?: string | null;
  lastTest?: boolean;
  lastCreateStatus?: string | null;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    creates: number;
    lastAmount?: string | null;
    lastNetworkId?: string | null;
    lastTest?: boolean;
    lastCreateStatus?: string | null;
  };
}

async function connected(origin: string, home: string) {
  const setup = makeDeps({ origin, home });
  assert.equal(await runCli(["login"], setup.deps), 0);
  return setup;
}

test("scan happy path prints markdown and --json prints one document", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);

  const md = makeDeps({ origin: fake.origin, home, git: gitStub() });
  const mdCode = await runCli(["scan"], md.deps);
  assert.equal(mdCode, 0);
  assert.match(md.cap.out(), /<!-- cleanslop:v1 scan=scan_1/);
  assert.match(md.cap.out(), /A finding/);
  assert.equal(fake.state.created.length, 1);
  const body = fake.state.created[0] as {
    remote: string;
    commitSha: string;
    branch: string;
  };
  assert.equal(body.remote, "https://github.com/acme/app.git");
  assert.equal(body.commitSha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(body.branch, "main");
  assertNoToken(md.cap.out() + md.cap.err());

  const js = makeDeps({ origin: fake.origin, home, git: gitStub() });
  const jsCode = await runCli(["scan", "--json", "--force"], js.deps);
  assert.equal(jsCode, 0);
  const parsed = JSON.parse(js.cap.out()) as {
    scan: { id: string };
    report: { schema: string };
  };
  assert.equal(parsed.scan.id, "scan_1");
  assert.equal(parsed.report.schema, "cleanslop.report.v1");
  assertNoToken(js.cap.out() + js.cap.err());
});

test("dirty or unpushed HEAD exits 13 with ACTION_REQUIRED", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);

  const dirty = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub({ dirty: true }),
  });
  assert.equal(await runCli(["scan"], dirty.deps), 13);
  assert.match(dirty.cap.err(), /CLEANSLOP_ACTION_REQUIRED: ask_human/);
  assert.match(dirty.cap.err(), /commit and push/);
  assert.equal(questionFrom(dirty.cap.err())?.id, "push_first");

  const unpushed = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub({ unpushed: true }),
  });
  assert.equal(await runCli(["scan"], unpushed.deps), 13);
  assert.match(unpushed.cap.err(), /CLEANSLOP_ACTION_REQUIRED/);

  const base = gitStub();
  const untracked = makeDeps({
    origin: fake.origin,
    home,
    git: async (args) => {
      const key = args.join(" ");
      if (key === "status --porcelain") {
        return {
          ok: true,
          stdout: "?? untracked.txt\n",
          stderr: "",
          code: 0,
        };
      }
      return base(args);
    },
  });
  assert.equal(await runCli(["scan"], untracked.deps), 13);
});

test("origin not on github.com exits 13", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub({ remote: "https://gitlab.com/acme/app.git" }),
  });
  assert.equal(await runCli(["scan"], deps), 13);
  assert.match(cap.err(), /github.com/);
});

test("402 out_of_scans exits 11 with ACTION_REQUIRED top-up", async () => {
  const fake = await startFakeServer((state) => {
    state.scanError = {
      status: 402,
      body: {
        error: "out_of_scans",
        message: "No scans remaining.",
        action: {
          kind: "open_url",
          url: "https://app.cleanslop.com/credits?from=agent",
          humanPrompt: "Ask the human to buy more scans.",
        },
      },
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const { deps, cap } = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan"], deps), 11);
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: top-up/);
  assert.match(cap.err(), /credits\?from=agent/);
  const question = questionFrom(cap.err());
  assert.equal(question?.id, "web_checkout");
  assert.match(question?.question ?? "", /credits\?from=agent/);
  assert.deepEqual(
    question?.options.map((o) => [o.label, o.next ?? null]),
    [
      ["Done", "rerun the scan"],
      ["Not now", null],
    ]
  );
  assertNoToken(cap.out() + cap.err());
});

test("402 out_of_scans with a promo still possible asks checkout, promo, or not now", async () => {
  const promo = { command: "cleanslop redeem <code>", mcpTool: "promo_redeem" };
  const fake = await startFakeServer((state) => {
    state.scanError = {
      status: 402,
      body: {
        error: "out_of_scans",
        message: "No scans remaining.",
        action: {
          kind: "open_url",
          url: "https://app.cleanslop.com/credits?from=agent",
          humanPrompt: "Ask the human to buy more scans.",
        },
        payment: { methods: [], promo },
      },
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const web = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan"], web.deps), 11);
  const question = questionFrom(web.cap.err());
  assert.equal(question?.id, "top_up_method");
  assert.equal(question?.header, "Add scans");
  assert.deepEqual(
    question?.options.map((o) => o.value),
    ["checkout", "promo", "none"]
  );
  assert.match(question?.options[1]?.next ?? "", /`cleanslop redeem <code>` with exactly what they type/);

  // Link grant with payments off: no checkout URL, so promo or stop.
  fake.state.scanError = {
    status: 402,
    body: {
      error: "out_of_scans",
      message: "No scans remaining.",
      action: { kind: "ask_human", humanPrompt: "Contact CleanSlop for credits." },
      payment: { methods: [], promo },
    },
  };
  const contact = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan"], contact.deps), 11);
  assert.deepEqual(
    questionFrom(contact.cap.err())?.options.map((o) => o.value),
    ["promo", "none"]
  );
});

test("401 revoked exits 10", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  fake.state.scanError = {
    status: 401,
    body: { error: "token_revoked", message: "This token was revoked." },
  };
  const { deps, cap } = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan"], deps), 10);
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: reauth/);
});

test("repo_not_connected exits 10 with install link", async () => {
  const fake = await startFakeServer((state) => {
    state.scanError = {
      status: 404,
      body: {
        error: "repo_not_connected",
        message: "Install the GitHub App.",
        action: {
          kind: "open_url",
          url: "https://app.cleanslop.com/agent/install?repo=acme%2Fapp",
          humanPrompt: "Ask the human to install the CleanSlop GitHub App.",
        },
      },
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const { deps, cap } = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan"], deps), 10);
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: install/);
  assert.match(cap.err(), /agent\/install/);
  const question = questionFrom(cap.err());
  assert.equal(question?.id, "github_install");
  assert.match(question?.question ?? "", /agent\/install\?repo=acme%2Fapp/);
});

test("report_not_ready with --wait exits 75 and prints resume", async () => {
  const fake = await startFakeServer((state) => {
    state.scan.status = "running";
    state.scan.final = false;
    state.scan.pollAfterSec = 10;
    state.scan.progress = { phase: "harness", label: "Analyzing" };
    state.reportError = {
      status: 409,
      body: {
        error: "report_not_ready",
        message: "This scan is not finished yet.",
        action: { kind: "wait", retryAfterSec: 10 },
      },
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub(),
    defaultWaitMs: 50,
    minPollMs: 10,
  });
  const code = await runCli(["scan", "--wait", "50"], deps);
  assert.equal(code, 75);
  assert.match(cap.err(), /cleanslop status scan_1 --wait/);
});

test("CLEANSLOP_TOKEN override never writes that token in stdout", async () => {
  const fake = await startFakeServer();
  cleanups.push(fake.close);
  const home = tempHome();
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub(),
    envExtra: { CLEANSLOP_TOKEN: TEST_TOKEN },
  });
  assert.equal(await runCli(["whoami"], deps), 0);
  assert.match(cap.out(), /…abcd|token …abcd/);
  assert.doesNotMatch(cap.out(), new RegExp(TEST_TOKEN));
  assert.equal(deps.fs.exists(credentialsPath(deps)), false);
});

function seedPackTree(home: string) {
  mkdirSync(join(home, "src"), { recursive: true });
  writeFileSync(join(home, "src", "app.ts"), "export const n = 1;\n");
}

test("scan --dry-run with uploads lists the pack and does not upload", async () => {
  const fake = await startFakeServer((state) => {
    state.uploads = true;
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const repo = join(home, "repo");
  seedPackTree(repo);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    cwd: repo,
    git: gitStub({ toplevel: repo }),
    execFile: createDefaultDeps().execFile,
  });
  const code = await runCli(["scan", "--dry-run"], deps);
  assert.equal(code, 0, cap.err());
  assert.match(cap.err(), /Would upload:/);
  assert.match(cap.err(), /src\/app.ts|1 files/);
  assert.equal(fake.state.uploaded.length, 0);
  assert.equal(fake.state.created.length, 0);
  assertNoToken(cap.out() + cap.err());
});

test("scan uploads when /me.uploads is true and skips dirty push checks", async () => {
  const fake = await startFakeServer((state) => {
    state.uploads = true;
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const repo = join(home, "repo");
  seedPackTree(repo);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    cwd: repo,
    git: gitStub({ toplevel: repo, dirty: true }),
    execFile: createDefaultDeps().execFile,
  });
  const code = await runCli(["scan"], deps);
  assert.equal(code, 0, cap.err());
  assert.match(cap.err(), /Uploading:/);
  assert.equal(fake.state.uploaded.length, 1);
  assert.equal(fake.state.created.length, 1);
  const body = fake.state.created[0] as { uploadId?: string };
  assert.equal(body.uploadId, "upl_1");
  assert.match(cap.out(), /<!-- cleanslop:v1 scan=scan_1/);
  assertNoToken(cap.out() + cap.err());
});

async function fallbackScan(
  argv: string[],
  git: Parameters<typeof gitStub>[0],
  setup?: Parameters<typeof startFakeServer>[0]
) {
  const fake = await startFakeServer((state) => {
    state.uploadFallback = true;
    setup?.(state);
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const repo = join(home, "repo");
  seedPackTree(repo);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    cwd: repo,
    git: gitStub({ toplevel: repo, ...git }),
    execFile: createDefaultDeps().execFile,
  });
  const code = await runCli(argv, deps);
  return { code, cap, fake };
}

test("GitHub grant with uploadFallback asks before uploading a folder that isn't on GitHub", async () => {
  for (const git of [
    { remote: "https://gitlab.com/acme/app.git" },
    { worktree: false },
    { noCommits: true },
  ]) {
    const asked = await fallbackScan(["scan"], git);
    assert.equal(asked.code, 13, asked.cap.err());
    const question = questionFrom(asked.cap.err());
    assert.equal(question?.id, "upload_local");
    assert.deepEqual(
      question?.options.map((o) => o.value),
      ["upload", "stop"]
    );
    assert.match(question?.options[0]?.next ?? "", /--upload, and keep --upload on later scans/);
    assert.equal(asked.fake.state.uploaded.length, 0);

    const { code, cap, fake } = await fallbackScan(["scan", "--upload"], git);
    assert.equal(code, 0, cap.err());
    assert.equal(fake.state.uploaded.length, 1);
    assert.equal((fake.state.created[0] as { uploadId?: string }).uploadId, "upl_1");
  }
});

test("GitHub grant with uploadFallback asks push or upload for a dirty tree, and --upload uploads", async () => {
  const asked = await fallbackScan(["scan"], { dirty: true });
  assert.equal(asked.code, 13);
  const question = questionFrom(asked.cap.err());
  assert.equal(question?.id, "push_or_upload");
  assert.deepEqual(
    question?.options.map((o) => o.value),
    ["upload", "pushed", "stop"]
  );
  assert.match(question?.options[0]?.next ?? "", /--upload/);
  assert.equal(asked.fake.state.uploaded.length, 0);

  const uploaded = await fallbackScan(["scan", "--upload"], { dirty: true });
  assert.equal(uploaded.code, 0, uploaded.cap.err());
  assert.equal(uploaded.fake.state.uploaded.length, 1);
});

test("GitHub grant with uploadFallback scans a clean pushed commit from GitHub", async () => {
  const { code, cap, fake } = await fallbackScan(["scan"], {});
  assert.equal(code, 0, cap.err());
  assert.equal(fake.state.uploaded.length, 0);
  assert.equal((fake.state.created[0] as { remote?: string }).remote, "https://github.com/acme/app.git");
});

test("GitHub grant with uploadFallback also offers an upload when the App is not installed", async () => {
  const { code, cap } = await fallbackScan(["scan"], {}, (state) => {
    state.scanError = {
      status: 404,
      body: {
        error: "repo_not_connected",
        message: "Install the GitHub App.",
        action: { kind: "open_url", url: "https://app.example/agent/install?repo=acme%2Fapp" },
      },
    };
  });
  assert.equal(code, 10);
  const question = questionFrom(cap.err());
  assert.equal(question?.id, "github_install");
  assert.deepEqual(
    question?.options.map((o) => o.value),
    ["done", "upload", "stop"]
  );
});

test("scan --upload without upload access exits 12 and uploads nothing", async () => {
  const { code, cap, fake } = await fallbackScan(["scan", "--upload"], {}, (state) => {
    state.uploadFallback = false;
  });
  assert.equal(code, 12);
  assert.match(cap.err(), /can't upload files/);
  assert.equal(fake.state.uploaded.length, 0);
});

test("scan upload sends the tar hash and skipped files, then uploads when nothing matches", async () => {
  const fake = await startFakeServer((state) => {
    state.uploads = true;
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const repo = join(home, "repo");
  seedPackTree(repo);
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    cwd: repo,
    git: gitStub({ worktree: false }),
    execFile: createDefaultDeps().execFile,
  });
  assert.equal(await runCli(["scan"], deps), 0, cap.err());
  assert.equal(fake.state.reuses.length, 1);
  const asked = fake.state.reuses[0] as {
    surface: string;
    manifest: { treeSha256: string; contentSha256: string; excluded: unknown };
  };
  assert.equal(asked.surface, "cli");
  assert.match(asked.manifest.treeSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(asked.manifest.treeSha256, asked.manifest.contentSha256);
  assert.deepEqual(asked.manifest.excluded, {
    total: 1,
    byReason: { "secret env file": 1 },
    files: [{ path: ".env", reason: "secret env file" }],
  });
  assert.equal(fake.state.uploaded.length, 1);
  const sent = JSON.parse(
    String((fake.state.uploaded[0] as { manifest: string }).manifest)
  ) as Record<string, unknown>;
  assert.deepEqual(sent, asked.manifest);
  assert.equal(fake.state.created.length, 1);
});

test("scan upload reuses a scan of the same files without uploading", async () => {
  const fake = await startFakeServer((state) => {
    state.uploads = true;
    state.reuseReply = {
      status: 200,
      body: {
        scan: {
          ...state.scan,
          id: "scan_same",
          source: "upload",
          commitSha: null,
          upload: { gitCommit: "abcdef1234567", localChanges: true, notScanned: null },
        },
        created: false,
        deduped: true,
        charged: null,
      },
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const repo = join(home, "repo");
  seedPackTree(repo);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    cwd: repo,
    git: gitStub({ toplevel: repo, dirty: true }),
    execFile: createDefaultDeps().execFile,
  });
  assert.equal(await runCli(["scan"], deps), 0, cap.err());
  assert.match(cap.err(), /Same files as scan scan_same; reusing it without uploading/);
  assert.match(cap.err(), /id=scan_same .*commit=abcdef1\+changes/);
  assert.equal(fake.state.uploaded.length, 0);
  assert.equal(fake.state.created.length, 0);
  assertNoToken(cap.out() + cap.err());
});

test("scan upload uploads when the server has no reuse pre-check, and --force skips it", async () => {
  const fake = await startFakeServer((state) => {
    state.uploads = true;
    state.reuseReply = { status: 404, body: "Not Found" };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const repo = join(home, "repo");
  seedPackTree(repo);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    cwd: repo,
    git: gitStub({ toplevel: repo }),
    execFile: createDefaultDeps().execFile,
  });
  assert.equal(await runCli(["scan"], deps), 0, cap.err());
  assert.equal(fake.state.reuses.length, 1);
  assert.equal(fake.state.uploaded.length, 1);

  assert.equal(await runCli(["scan", "--force"], deps), 0, cap.err());
  assert.equal(fake.state.reuses.length, 1);
  assert.equal(fake.state.uploaded.length, 2);
});

test("scan auto-buys from a stripe_spt 402 without --amount", async () => {
  const fake = await startFakeServer((state) => {
    state.scanError = {
      status: 402,
      body: sptOutOfScansBody(state.origin, [
        { pack: "p5", amount: 1000 },
        { pack: "p15", amount: 2500 },
      ]),
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_scan_autobuy_token";
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub(),
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI },
  });
  const code = await runCli(["scan"], deps);
  assert.equal(code, 0, cap.err());
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: approve/);
  assert.match(cap.err(), /https:\/\/app\.link\.com\/spend\/approve\?code=test/);
  assert.match(cap.err(), /Approve this CleanSlop credit pack|approve this CleanSlop credit pack/);
  assert.match(cap.out(), /Added p5 scan credits/);
  assert.match(cap.out(), /<!-- cleanslop:v1 scan=scan_1/);
  assert.equal(fake.state.purchases.length, 1);
  assert.equal(fake.state.created.length, 2);
  const posted = fake.state.purchases[0] as {
    body?: { pack?: string; sharedPaymentToken?: string };
  };
  assert.equal(posted.body?.pack, "p5");
  assert.equal(posted.body?.sharedPaymentToken, "spt_scan_autobuy_token");
  const state = readLinkState(statePath);
  assert.equal(state.creates, 1);
  assert.equal(state.lastAmount, "1000");
  assert.equal(state.lastNetworkId, "profile_from_402");
  assert.equal(state.lastCreateStatus, "pending_approval");
  assert.equal(state.lastTest, false);
  assert.doesNotMatch(cap.out() + cap.err(), /spt_[A-Za-z0-9]{6,}/);
  assertNoToken(cap.out() + cap.err());
});

test("an agent's scan (no TTY) hands a stripe_spt 402 to credits buy --no-wait", async () => {
  const fake = await startFakeServer((state) => {
    state.scanError = {
      status: 402,
      body: sptOutOfScansBody(state.origin, [
        { pack: "p5", amount: 1000 },
        { pack: "p15", amount: 2500, best: true },
        { pack: "p40", amount: 6000 },
      ]),
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub(),
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI },
    stdinIsTTY: false,
  });
  const code = await runCli(["scan"], deps);
  assert.equal(code, 11, cap.err());
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: top-up/);
  assert.match(
    cap.err(),
    /which CleanSlop credit pack to buy with Link: p5 \(5 scans, 10\.00 USD, 2\.00 USD per scan\), p15 \(15 scans, 25\.00 USD, 1\.67 USD per scan, best value\), or p40 \(40 scans, 60\.00 USD, 1\.50 USD per scan\)\./
  );
  assert.match(cap.err(), /run `cleanslop credits buy --link --pack <pack> --no-wait`/);
  const question = questionFrom(cap.err());
  assert.equal(question?.id, "link_credit_pack");
  assert.match(question?.question ?? "", /^This account is out of scans\. Which CleanSlop credit pack/);
  assert.deepEqual(
    question?.options.map((o) => [o.value, o.description ?? null]),
    [
      ["p5", "2.00 USD per scan"],
      ["p15", "1.67 USD per scan, best value"],
      ["p40", "1.50 USD per scan"],
      ["none", "Buy nothing"],
    ]
  );
  assert.match(cap.err(), /`cleanslop credits buy --link --resume`/);
  assert.equal(readLinkState(statePath).creates, 0);
  assert.equal(fake.state.purchases.length, 0);
  assert.equal(fake.state.created.length, 1);
  assertNoToken(cap.out() + cap.err());
});

test("an agent's scan --pack p15 (no TTY) names only that pack", async () => {
  const fake = await startFakeServer((state) => {
    state.scanError = {
      status: 402,
      body: sptOutOfScansBody(state.origin, [
        { pack: "p5", amount: 1000 },
        { pack: "p15", amount: 2500, best: true },
      ]),
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub(),
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI },
    stdinIsTTY: false,
  });
  assert.equal(await runCli(["scan", "--pack", "p15"], deps), 11, cap.err());
  assert.match(
    cap.err(),
    /whether to buy CleanSlop credit pack p15 \(15 scans, 25\.00 USD, 1\.67 USD per scan, best value\) with Link/
  );
  assert.match(cap.err(), /run `cleanslop credits buy --link --pack p15 --no-wait`/);
  assert.doesNotMatch(cap.err(), /p5 \(/);
  const question = questionFrom(cap.err());
  assert.deepEqual(question?.options, [
    { value: "p15", label: "Buy p15", run: "cleanslop credits buy --link --pack p15 --no-wait" },
    { value: "none", label: "Not now", description: "Buy nothing" },
  ]);
});

test("an agent's out-of-scans asks buy, promo, or not now while a promo is possible", async () => {
  const fake = await startFakeServer((state) => {
    state.scanError = {
      status: 402,
      body: sptOutOfScansBody(
        state.origin,
        [
          { pack: "p5", amount: 1000 },
          { pack: "p15", amount: 2500, best: true },
          { pack: "p40", amount: 6000 },
        ],
        true
      ),
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const any = makeDeps({ origin: fake.origin, home, git: gitStub(), stdinIsTTY: false });
  assert.equal(await runCli(["scan"], any.deps), 11, any.cap.err());
  assert.match(any.cap.err(), /which CleanSlop credit pack to buy with Link/);
  assert.match(
    any.cap.err(),
    /If they have a CleanSlop promo code instead, run `cleanslop redeem <code>` with exactly the code they type, then rerun the scan\./
  );
  const question = questionFrom(any.cap.err());
  assert.equal(question?.id, "top_up_method");
  assert.deepEqual(question?.options[0], {
    value: "buy",
    label: "Buy with Link",
    description:
      "p5 (5 scans, 10.00 USD, 2.00 USD per scan); p15 (15 scans, 25.00 USD, 1.67 USD per scan, best value); p40 (40 scans, 60.00 USD, 1.50 USD per scan)",
    run: "cleanslop credits buy --link --no-promo --no-wait",
  });
  assert.deepEqual(
    question?.options.slice(1).map((o) => o.value),
    ["promo", "none"]
  );

  const named = makeDeps({ origin: fake.origin, home, git: gitStub(), stdinIsTTY: false });
  assert.equal(await runCli(["scan", "--pack", "p15"], named.deps), 11, named.cap.err());
  assert.deepEqual(questionFrom(named.cap.err())?.options[0], {
    value: "p15",
    label: "Buy p15",
    description: "p15 (15 scans, 25.00 USD, 1.67 USD per scan, best value)",
    run: "cleanslop credits buy --link --pack p15 --no-wait",
  });
  assert.equal(fake.state.purchases.length, 0);
});

test("scan --pack p15 picks that stripe_spt offer; --amount stays a hidden override", async () => {
  const fake = await startFakeServer((state) => {
    state.scanError = {
      status: 402,
      body: sptOutOfScansBody(state.origin, [
        { pack: "p5", amount: 1000 },
        { pack: "p15", amount: 2500 },
      ]),
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_pack_hint_token";
  const hinted = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub(),
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI },
  });
  assert.equal(await runCli(["scan", "--pack", "p15"], hinted.deps), 0, hinted.cap.err());
  assert.equal(readLinkState(statePath).lastAmount, "2500");
  assert.equal(
    (fake.state.purchases[0] as { body?: { pack?: string } }).body?.pack,
    "p15"
  );

  fake.state.purchases = [];
  fake.state.created = [];
  const overrideHome = tempHome();
  await connected(fake.origin, overrideHome);
  const overrideState = join(overrideHome, "fake-link-state.json");
  writeFileSync(overrideState, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_STATE = overrideState;
  process.env.FAKE_SPT = "spt_amount_override_token";
  const override = makeDeps({
    origin: fake.origin,
    home: overrideHome,
    git: gitStub(),
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI },
  });
  assert.equal(
    await runCli(["scan", "--amount", "999"], override.deps),
    0,
    override.cap.err()
  );
  assert.equal(readLinkState(overrideState).lastAmount, "999");
});

test("scan upload auto-buys from a stripe_spt 402", async () => {
  const fake = await startFakeServer((state) => {
    state.uploads = true;
    state.scanError = {
      status: 402,
      body: sptOutOfScansBody(state.origin),
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const repo = join(home, "repo");
  seedPackTree(repo);
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_upload_autobuy_token";
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    cwd: repo,
    git: gitStub({ toplevel: repo, dirty: true }),
    execFile: createDefaultDeps().execFile,
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI },
  });
  const code = await runCli(["scan"], deps);
  assert.equal(code, 0, cap.err());
  assert.equal(fake.state.uploaded.length, 1);
  assert.equal(fake.state.purchases.length, 1);
  assert.equal(fake.state.created.length, 2);
  assert.match(cap.out(), /<!-- cleanslop:v1 scan=scan_1/);
  assert.doesNotMatch(cap.out() + cap.err(), /spt_[A-Za-z0-9]{6,}/);
  assertNoToken(cap.out() + cap.err());
});

test("requires_action that cannot auto-resume clears pending so the next scan creates a new spend request", async () => {
  const fake = await startFakeServer((state) => {
    state.scanError = {
      status: 402,
      body: sptOutOfScansBody(state.origin),
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPEND_STATUS = "requires_action";
  process.env.FAKE_SPEND_RESOLUTION = "challenge";
  process.env.FAKE_SPT = "spt_retry_after_action";
  const first = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub(),
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI },
  });
  assert.equal(await runCli(["scan"], first.deps), 10, first.cap.err());
  assert.match(first.cap.err(), /Start a new spend request|extra approval|Complete/);
  assert.equal(first.deps.fs.exists(pendingSpendPath(first.deps)), false);
  assert.equal(readLinkState(statePath).creates, 1);
  assert.equal(fake.state.purchases.length, 0);

  delete process.env.FAKE_SPEND_STATUS;
  delete process.env.FAKE_SPEND_RESOLUTION;
  const second = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub(),
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI },
  });
  assert.equal(await runCli(["scan"], second.deps), 0, second.cap.err());
  assert.equal(readLinkState(statePath).creates, 2);
  assert.equal(fake.state.purchases.length, 1);
  assert.match(second.cap.out(), /<!-- cleanslop:v1 scan=scan_1/);
  assert.doesNotMatch(second.cap.out() + second.cap.err(), /spt_[A-Za-z0-9]{6,}/);
  assertNoToken(second.cap.out() + second.cap.err());
});

test("scan auto-buy ignores a pending spend from another origin", async () => {
  const fake = await startFakeServer((state) => {
    state.scanError = {
      status: 402,
      body: sptOutOfScansBody(state.origin),
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_scan_origin_guard";
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub(),
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI },
  });
  await writePendingSpend(deps, {
    version: 1,
    origin: "https://staging.example",
    spendRequestId: "sr_stale_other",
    pack: "p5",
    amount: 1000,
    currency: "usd",
    networkId: "profile_from_402",
    purchaseUrl: "https://staging.example/api/agent/v1/credits/purchases",
    createdAt: 1,
  });
  assert.equal(await runCli(["scan"], deps), 0, cap.err());
  assert.equal(readLinkState(statePath).creates, 1);
  assert.equal(
    (fake.state.purchases[0] as { body?: { spendRequestId?: string } }).body
      ?.spendRequestId,
    "sr_test_1"
  );
  assertNoToken(cap.out() + cap.err());
});

test("declined stripe_spt charge does not retry the scan", async () => {
  const fake = await startFakeServer((state) => {
    state.scanError = {
      status: 402,
      body: sptOutOfScansBody(state.origin),
    };
    state.purchaseError = {
      status: 402,
      body: { error: "payment_failed", message: "declined", reason: "card_declined" },
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const statePath = join(home, "fake-link-state.json");
  writeFileSync(statePath, JSON.stringify({ creates: 0, includeRetrieves: 0 }));
  process.env.FAKE_LINK_MODE = "ok";
  process.env.FAKE_LINK_STATE = statePath;
  process.env.FAKE_SPT = "spt_declined_token";
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home,
    git: gitStub(),
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI },
  });
  const code = await runCli(["scan"], deps);
  assert.equal(code, 11, cap.err());
  assert.match(cap.err(), /declined|CLEANSLOP_ACTION_REQUIRED: top-up/);
  assert.equal(fake.state.purchases.length, 1);
  assert.equal(fake.state.created.length, 1);
  assert.equal(deps.fs.exists(pendingSpendPath(deps)), false);
  assert.doesNotMatch(cap.out(), /cleanslop:v1/);
  assert.doesNotMatch(cap.out() + cap.err(), /spt_[A-Za-z0-9]{6,}/);
  assertNoToken(cap.out() + cap.err());
});


test("a Link-only agent's out-of-scans also offers a monthly plan on the web", async () => {
  const three: Array<{ pack: "p5" | "p15" | "p40"; amount: number; best?: true }> = [
    { pack: "p5", amount: 1000 },
    { pack: "p15", amount: 2500, best: true },
    { pack: "p40", amount: 6000 },
  ];
  const fake = await startFakeServer((state) => {
    state.scanError = { status: 402, body: sptOutOfScansBody(state.origin, three, false, true) };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const run = async (argv: string[]) => {
    const { deps, cap } = makeDeps({
      origin: fake.origin,
      home,
      git: gitStub(),
      envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI },
      stdinIsTTY: false,
    });
    assert.equal(await runCli(argv, deps), 11, cap.err());
    return cap.err();
  };
  const hint = /For a monthly plan instead, run `cleanslop billing` and relay what it prints\./;

  // Link already lets CleanSlop request payments: keep the pack question
  // (three packs plus "Not now" leave no room); the prompt still names the plan.
  const packs = await run(["scan"]);
  assert.match(packs, hint);
  const packQ = questionFrom(packs);
  assert.equal(packQ?.id, "link_credit_pack");
  assert.deepEqual(packQ?.options.map((o) => o.value), ["p5", "p15", "p40", "none"]);

  // No Link payment permission yet: ask buy, monthly plan, or not now first.
  process.env.FAKE_LINK_MODE = "unauth";
  const method = await run(["scan"]);
  assert.match(method, hint);
  const methodQ = questionFrom(method);
  assert.equal(methodQ?.id, "top_up_method");
  assert.deepEqual(methodQ?.options.map((o) => o.value), ["buy", "web_billing", "none"]);
  assert.equal(methodQ?.options[0]?.run, "cleanslop credits buy --link --no-promo --no-wait");
  assert.deepEqual(methodQ?.options[1], MONTHLY_PLAN);
  delete process.env.FAKE_LINK_MODE;

  const named = await run(["scan", "--pack", "p15"]);
  assert.match(named, hint);
  assert.deepEqual(questionFrom(named)?.options.map((o) => o.value), ["p15", "web_billing", "none"]);
  assert.deepEqual(questionFrom(named)?.options[1], MONTHLY_PLAN);

  fake.state.scanError = { status: 402, body: sptOutOfScansBody(fake.origin, three, true, true) };
  const promo = await run(["scan"]);
  assert.match(promo, hint);
  assert.deepEqual(
    questionFrom(promo)?.options.map((o) => o.value),
    ["buy", "promo", "web_billing", "none"]
  );
});

test("out-of-scans without Link packs asks monthly plan or not now for a Link-only account", async () => {
  const humanPrompt = "This account is out of scans. To buy credits or a monthly plan, run `cleanslop billing`.";
  const fake = await startFakeServer((state) => {
    state.scanError = {
      status: 402,
      body: {
        error: "out_of_scans",
        message: "No scans remaining.",
        action: { kind: "ask_human", humanPrompt },
        payment: { methods: [], webBilling: WEB_BILLING(state.origin) },
      },
    };
  });
  cleanups.push(fake.close);
  const home = tempHome();
  await connected(fake.origin, home);
  const plain = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan"], plain.deps), 11);
  assert.match(plain.cap.err(), /run `cleanslop billing`/);
  const question = questionFrom(plain.cap.err());
  assert.equal(question?.id, "top_up_method");
  assert.deepEqual(question?.options, [
    MONTHLY_PLAN,
    { value: "none", label: "Not now", description: "Buy nothing" },
  ]);

  fake.state.scanError = {
    status: 402,
    body: {
      error: "out_of_scans",
      message: "No scans remaining.",
      action: { kind: "ask_human", humanPrompt },
      payment: {
        methods: [],
        promo: { command: "cleanslop redeem <code>", mcpTool: "promo_redeem" },
        webBilling: WEB_BILLING(fake.origin),
      },
    },
  };
  const promo = makeDeps({ origin: fake.origin, home, git: gitStub() });
  assert.equal(await runCli(["scan"], promo.deps), 11);
  assert.deepEqual(
    questionFrom(promo.cap.err())?.options.map((o) => o.value),
    ["promo", "web_billing", "none"]
  );
});
