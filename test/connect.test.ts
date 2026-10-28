import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { offerGithubAfterLinkFailure } from "../src/connect.js";
import { CliError } from "../src/exit.js";
import { runCli } from "../src/main.js";
import { startFakeServer } from "./fake-server.js";
import { gitStub, makeDeps, questionFrom, tempHome } from "./helpers.js";

const FAKE_LINK_CLI = join(dirname(fileURLToPath(import.meta.url)), "fake-link-cli.mjs");
chmodSync(FAKE_LINK_CLI, 0o755);

const BOTH = [{ kind: "stripe_link", recommended: true }, { kind: "github" }];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  delete process.env.FAKE_LINK_MODE;
});

async function scanNotConnected(connectMethods: unknown[] | null, remote?: string) {
  const fake = await startFakeServer((state) => {
    state.connectMethods = connectMethods;
  });
  cleanups.push(fake.close);
  const { deps, cap } = makeDeps({
    origin: fake.origin,
    home: tempHome(),
    git: gitStub(remote === undefined ? {} : { remote }),
    stdinIsTTY: false,
  });
  const code = await runCli(["scan"], deps);
  return { code, err: cap.err(), fake };
}

const LINK_OPTION = {
  value: "stripe_link",
  label: "Stripe Link (Recommended)",
  description: "No GitHub needed; scans this folder's files. Needs a Link account; US and Canada only.",
  run: "cleanslop login --link --no-wait",
};

test("not connected in a GitHub repo recommends GitHub first", async () => {
  const { code, err } = await scanNotConnected(BOTH);
  assert.equal(code, 10);
  assert.match(err, /CLEANSLOP_ACTION_REQUIRED: ask_human/);
  assert.match(err, /Ask the human how to connect: GitHub \(recommended; /);
  assert.match(err, /If they already said which, use that without asking\./);
  const question = questionFrom(err);
  assert.equal(question?.id, "connect_method");
  assert.equal(question?.header, "Connect");
  assert.deepEqual(question?.options, [
    {
      value: "github",
      label: "GitHub (Recommended)",
      description: "Scans what you've pushed to GitHub.",
      run: "cleanslop login --no-wait",
    },
    { ...LINK_OPTION, label: "Stripe Link" },
  ]);
  assert.doesNotMatch(err, /--agree/);
});

test("not connected outside GitHub recommends Link first and says GitHub needs a push", async () => {
  for (const remote of ["https://gitlab.com/acme/app.git", ""]) {
    const { err } = await scanNotConnected(BOTH, remote);
    assert.match(err, /Ask the human how to connect: Stripe Link \(recommended; /);
    assert.deepEqual(questionFrom(err)?.options, [
      LINK_OPTION,
      {
        value: "github",
        label: "GitHub",
        description:
          "Scans what you've pushed to GitHub. This folder isn't on GitHub yet, so you'd push it first.",
        run: "cleanslop login --no-wait",
      },
    ]);
  }
});

test("the GitHub option says it can scan local files when the server lets GitHub sign-ins upload", async () => {
  const methods = [{ kind: "stripe_link", recommended: true }, { kind: "github", uploads: true }];
  const upload = "Scans what you've pushed to GitHub; can also scan this folder's files when you choose.";
  const gitlab = await scanNotConnected(methods, "https://gitlab.com/acme/app.git");
  assert.equal(questionFrom(gitlab.err)?.options[1]?.description, upload);
  assert.doesNotMatch(gitlab.err, /push it first/);
  const onGithub = await scanNotConnected(methods);
  assert.equal(questionFrom(onGithub.err)?.options[0]?.description, upload);
});

test("not connected keeps the plain login block when the server does not offer both", async () => {
  for (const methods of [null, [], [{ kind: "github" }], { kind: "github" }]) {
    const { code, err } = await scanNotConnected(methods as unknown[] | null);
    assert.equal(code, 10);
    assert.match(err, /CLEANSLOP_ACTION_REQUIRED: approve/);
    assert.match(err, /Not connected\. Run `cleanslop login`\./);
    assert.equal(questionFrom(err), null);
  }
  // Unreachable server: same plain block.
  const { deps, cap } = makeDeps({
    origin: "http://127.0.0.1:9",
    home: tempHome(),
    git: gitStub(),
    stdinIsTTY: false,
  });
  assert.equal(await runCli(["scan"], deps), 10);
  assert.match(cap.err(), /CLEANSLOP_ACTION_REQUIRED: approve/);
});

test("a link-cli failure during login --link offers GitHub", async () => {
  process.env.FAKE_LINK_MODE = "attest-request-fail";
  const { deps, cap } = makeDeps({
    origin: "https://app.example",
    home: tempHome(),
    stdinIsTTY: false,
    envExtra: { CLEANSLOP_LINK_CLI: FAKE_LINK_CLI },
  });
  assert.equal(await runCli(["login", "--link", "--agree"], deps), 10);
  assert.match(cap.err(), /Link sign-in failed \(the error is below\)/);
  assert.match(cap.err(), /Link sign-up is US and Canada only/);
  assert.match(cap.err(), /Link refused the attestation request/);
  const question = questionFrom(cap.err());
  assert.equal(question?.id, "link_failed");
  assert.deepEqual(
    question?.options.map((o) => [o.value, o.run]),
    [
      ["github", "cleanslop login --no-wait"],
      ["retry", "cleanslop login --link --no-wait"],
    ]
  );
});

test("offerGithubAfterLinkFailure rethrows errors that already say what to do", () => {
  const plain = new Error("boom");
  assert.throws(() => offerGithubAfterLinkFailure(plain), (err) => err === plain);
  const withAction = new CliError("pending", 10, { kind: "approve", humanPrompt: "Approve." });
  assert.throws(() => offerGithubAfterLinkFailure(withAction), (err) => err === withAction);
});
