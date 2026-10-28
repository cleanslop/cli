import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialsPath, storeToken } from "../src/credentials.js";
import { storeLoginToken } from "../src/token-rotation.js";
import { makeDeps, tempHome } from "./helpers.js";

const ORIGIN = "https://app.example";
const OLD = "cslop_agt_OLDROTATE0000000000000000000000000zzzz";
const NEW = "cslop_agt_NEWROTATE0000000000000000000000000zzzz";

function setup(envExtra: Record<string, string> = {}) {
  const { deps, cap } = makeDeps({ origin: ORIGIN, home: tempHome(), envExtra });
  const revokes: string[] = [];
  let revokeStatus = 200;
  deps.request = async (url, init) => {
    assert.match(String(url), /\/oauth\/revoke$/);
    revokes.push(String(new Headers(init.headers).get("authorization")));
    return new Response(null, { status: revokeStatus });
  };
  return {
    deps,
    cap,
    revokes,
    setRevokeStatus: (status: number) => {
      revokeStatus = status;
    },
  };
}

const stored = (deps: ReturnType<typeof setup>["deps"]) =>
  (JSON.parse(deps.fs.read(credentialsPath(deps))) as { origins: Record<string, { token: string }> })
    .origins[ORIGIN]?.token;

test("storeLoginToken revokes the replaced token and warns when the server refuses", async () => {
  const { deps, cap, revokes, setRevokeStatus } = setup();
  // First login on this machine: nothing to revoke.
  await storeLoginToken(deps, ORIGIN, { token: OLD, githubLogin: null, grantId: null });
  assert.equal(revokes.length, 0);

  setRevokeStatus(500);
  await storeLoginToken(deps, ORIGIN, { token: NEW, githubLogin: null, grantId: "g2" });
  assert.equal(stored(deps), NEW);
  assert.deepEqual(revokes, [`Bearer ${OLD}`]);
  assert.match(cap.err(), /Could not revoke the previous CleanSlop token; it still works/);

  // The same token again (never expected from the server): no revoke of the live token.
  setRevokeStatus(200);
  await storeLoginToken(deps, ORIGIN, { token: NEW, githubLogin: null, grantId: "g2" });
  assert.equal(revokes.length, 1);
  assert.doesNotMatch(cap.err(), /CLEANSLOP_TOKEN/);
});

test("storeLoginToken says when CLEANSLOP_TOKEN holds the token it just revoked", async () => {
  const { deps, cap, revokes } = setup({ CLEANSLOP_TOKEN: OLD });
  await storeToken(deps, ORIGIN, { token: OLD });
  await storeLoginToken(deps, ORIGIN, { token: NEW, githubLogin: null, grantId: null });
  assert.equal(revokes.length, 1);
  assert.doesNotMatch(cap.err(), /Could not revoke/);
  assert.match(cap.err(), /CLEANSLOP_TOKEN holds the token this login just revoked/);
});

test("storeLoginToken says when a different CLEANSLOP_TOKEN still overrides the new login", async () => {
  const { deps, cap, setRevokeStatus } = setup({ CLEANSLOP_TOKEN: "cslop_agt_ENVONLY" });
  await storeToken(deps, ORIGIN, { token: OLD });
  await storeLoginToken(deps, ORIGIN, { token: NEW, githubLogin: null, grantId: null });
  assert.match(cap.err(), /CLEANSLOP_TOKEN is set, so commands keep using that token/);
  // The same env token as the file one, but the revoke failed: it still works, so no "revoked" claim.
  const failed = setup({ CLEANSLOP_TOKEN: OLD });
  failed.setRevokeStatus(500);
  await storeToken(failed.deps, ORIGIN, { token: OLD });
  await storeLoginToken(failed.deps, ORIGIN, { token: NEW, githubLogin: null, grantId: null });
  assert.match(failed.cap.err(), /CLEANSLOP_TOKEN is set, so commands keep using that token/);
  setRevokeStatus(200);
});
