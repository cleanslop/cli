import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createDefaultDeps } from "../src/deps.js";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  assertPackedArchiveFitsUpload,
  assertPackTreeFitsUpload,
  excludedSummary,
  isSecretDeniedPath,
  packManifest,
  planPack,
  writePackArchive,
} from "../src/pack.js";
import { makeDeps, tempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cleanslop-pack-"));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init"]);
  git(["config", "user.email", "dev@example.com"]);
  git(["config", "user.name", "Dev"]);
  writeFileSync(join(dir, "src.ts"), "export const n = 1;\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  writeFileSync(join(dir, ".env.example"), "SECRET=\n");
  writeFileSync(join(dir, "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  writeFileSync(join(dir, "keep.pem"), "nope\n");
  writeFileSync(join(dir, "photo.png"), "fake");
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "x", "index.js"), "module.exports=1\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(dir, "ignored.txt"), "skip\n");
  git(["add", "src.ts", ".env.example", ".gitignore"]);
  git(["commit", "-m", "init"]);
  return dir;
}

async function planFrom(repo: string) {
  const real = createDefaultDeps();
  const { deps } = makeDeps({
    origin: "https://app.example",
    home: tempHome(),
    cwd: repo,
    git: real.git,
    execFile: real.execFile,
  });
  return planPack(deps, repo);
}

test("secret deny-list matches the planned paths", () => {
  assert.equal(isSecretDeniedPath(".env"), "secret env file");
  assert.equal(isSecretDeniedPath(".env.local"), "secret env file");
  assert.equal(isSecretDeniedPath(".env.example"), null);
  assert.equal(isSecretDeniedPath("id_ed25519"), "secret key");
  assert.equal(isSecretDeniedPath("certs/app.pem"), "secret key");
  assert.equal(isSecretDeniedPath(".npmrc"), "secret config");
  assert.equal(isSecretDeniedPath(".aws/credentials"), "secret path");
  assert.equal(isSecretDeniedPath("credentials.json"), "secret credentials");
  assert.equal(isSecretDeniedPath(".git/config"), "git metadata");
  assert.equal(isSecretDeniedPath(".dev.vars"), "secret config");
  assert.equal(isSecretDeniedPath(".netrc"), "secret config");
  assert.equal(isSecretDeniedPath("terraform.tfstate"), "secret terraform");
  assert.equal(isSecretDeniedPath("prod.tfstate.backup"), "secret terraform");
  assert.equal(isSecretDeniedPath("gcp-service-account.json"), "secret credentials");
  assert.equal(isSecretDeniedPath("firebase-adminsdk-abc.json"), "secret credentials");
  assert.equal(isSecretDeniedPath("release.jks"), "secret key");
  assert.equal(isSecretDeniedPath("app.keystore"), "secret key");
  assert.equal(isSecretDeniedPath(".docker/config.json"), "secret config");
});

test("packer excludes secrets, ignored files, binaries, and symlinks", async () => {
  const repo = tempRepo();
  symlinkSync(join(repo, "src.ts"), join(repo, "alias.ts"));
  const plan = await planFrom(repo);
  const names = plan.files.map((file) => file.relativePath);
  assert.deepEqual(names, [".env.example", ".gitignore", "src.ts"]);
  assert.ok(plan.excluded.some((item) => item.path === ".env"));
  assert.ok(plan.excluded.some((item) => item.path === "id_ed25519"));
  assert.ok(plan.excluded.some((item) => item.path === "keep.pem"));
  assert.ok(plan.excluded.some((item) => item.path === "photo.png"));
  assert.ok(plan.excluded.some((item) => item.path === "alias.ts" && item.reason === "symlink"));
  assert.ok(!names.includes("ignored.txt"));
  assert.ok(!names.includes("node_modules/x/index.js"));
});

test("identical trees produce the same contentSha256 twice", async () => {
  const repo = tempRepo();
  const plan = await planFrom(repo);
  const first = await writePackArchive(plan);
  utimesSync(join(repo, "src.ts"), 1_700_000_000, 1_700_000_000);
  const second = await writePackArchive(plan);
  assert.equal(first.sha256, second.sha256);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  assert.equal(first.treeSha256, second.treeSha256);
  assert.equal(
    first.treeSha256,
    createHash("sha256").update(gunzipSync(first.bytes)).digest("hex")
  );
  const manifest = packManifest(plan, first);
  assert.equal(manifest.contentSha256, first.sha256);
  assert.equal(manifest.treeSha256, first.treeSha256);
  assert.equal(first.bytes[4], 0);
  assert.equal(first.bytes[5], 0);
  assert.equal(first.bytes[6], 0);
  assert.equal(first.bytes[7], 0);
  const listed = spawnSync("tar", ["-tzf", "-"], { input: first.bytes, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /src\.ts/);
});

test("long paths stay extractable and hash-stable", async () => {
  const repo = tempRepo();
  const deep = join(
    repo,
    "a".repeat(80),
    "b".repeat(80),
    "c".repeat(80)
  );
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "note.ts"), "export const deep = true;\n");
  const plan = await planFrom(repo);
  const first = await writePackArchive(plan);
  const second = await writePackArchive(plan);
  assert.equal(first.sha256, second.sha256);
  const listed = spawnSync("tar", ["-tzf", "-"], { input: first.bytes, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /note\.ts/);
});

test("packed archives over 100 MB are refused before upload", () => {
  assert.throws(
    () => assertPackedArchiveFitsUpload(100 * 1024 * 1024 + 1),
    /100 MB/
  );
  assertPackedArchiveFitsUpload(100 * 1024 * 1024);
});

test("file sets over 1 GB uncompressed are refused before packing", () => {
  assert.throws(() => assertPackTreeFitsUpload(1024 * 1024 * 1024 + 1), /1 GB/);
  assertPackTreeFitsUpload(1024 * 1024 * 1024);
});

test("excludedSummary lists secrets first, drops deleted files, and caps the list", () => {
  const long = `${"d/".repeat(100)}x.png`;
  const binaries = Array.from({ length: 25 }, (_, i) => ({
    path: `img/${String(i).padStart(2, "0")}.png`,
    reason: "binary",
  }));
  const summary = excludedSummary([
    { path: "dist/app.js", reason: "ignored directory" },
    ...binaries,
    { path: long, reason: "binary" },
    { path: "gone.ts", reason: "missing" },
    { path: "config/.env", reason: "secret env file" },
    { path: ".npmrc", reason: "secret config" },
  ]);
  assert.equal(summary.total, 29);
  assert.deepEqual(summary.byReason, {
    "ignored directory": 1,
    binary: 26,
    "secret env file": 1,
    "secret config": 1,
  });
  assert.equal(summary.files.length, 20);
  assert.deepEqual(summary.files.slice(0, 3), [
    { path: ".npmrc", reason: "secret config" },
    { path: "config/.env", reason: "secret env file" },
    { path: "img/00.png", reason: "binary" },
  ]);
  assert.ok(!summary.files.some((file) => file.path === long || file.path === "gone.ts"));
  assert.deepEqual(excludedSummary([]), { total: 0, byReason: {}, files: [] });
});
