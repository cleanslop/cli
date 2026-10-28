import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error -- plain .mjs CI helper without type declarations
import { betaVersion, nextStableVersion } from "../scripts/release-version.mjs";

test("first release uses package.json's version", () => {
  assert.equal(nextStableVersion([], "0.1.0"), "0.1.0");
  assert.equal(
    nextStableVersion(["0.0.0-stage", "0.1.0-beta.0", "0.1.0-beta.2"], "0.1.0"),
    "0.1.0"
  );
});

test("later releases bump the patch after the highest stable on npm", () => {
  assert.equal(nextStableVersion(["0.1.0"], "0.1.0"), "0.1.1");
  assert.equal(
    nextStableVersion(["0.1.0", "0.1.10", "0.1.9", "0.1.11-beta.4"], "0.1.0"),
    "0.1.11"
  );
});

test("a higher package.json version wins for a minor or major bump", () => {
  assert.equal(nextStableVersion(["0.1.4"], "0.2.0"), "0.2.0");
  assert.equal(nextStableVersion(["0.1.4", "0.2.0"], "0.2.0"), "0.2.1");
});

test("package.json must hold a plain version", () => {
  assert.throws(() => nextStableVersion([], "0.1.0-beta.1"), /plain x\.y\.z/);
});

test("betas sort above the release they lead to", () => {
  assert.equal(betaVersion(["0.1.0-beta.2"], "0.1.0", "7", "1"), "0.1.0-beta.7");
  assert.equal(betaVersion(["0.1.0"], "0.1.0", "8", "1"), "0.1.1-beta.8");
  assert.equal(betaVersion(["0.1.0"], "0.1.0", "8", "2"), "0.1.1-beta.8.2");
  assert.equal(betaVersion([], "0.1.0", "9", undefined), "0.1.0-beta.9");
  assert.throws(() => betaVersion([], "0.1.0", "x", "1"), /digits/);
});
