import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDefaultDeps } from "../src/deps.js";
import { inspectGit } from "../src/git.js";
import { makeDeps, tempHome } from "./helpers.js";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("inspectGit treats tracked and untracked files as dirty and ignores ignored files", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cleanslop-git-"));
  try {
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "dev@example.com"]);
    git(repo, ["config", "user.name", "Dev"]);
    writeFileSync(join(repo, "tracked.txt"), "ok\n");
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
    git(repo, ["add", "tracked.txt", ".gitignore"]);
    git(repo, ["commit", "-m", "init"]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/app.git"]);

    const { deps } = makeDeps({
      origin: "https://app.example",
      home: tempHome(),
      cwd: repo,
      git: createDefaultDeps().git,
    });

    assert.equal((await inspectGit(deps)).dirty, false);

    writeFileSync(join(repo, "tracked.txt"), "changed\n");
    assert.equal((await inspectGit(deps)).dirty, true);
    git(repo, ["checkout", "--", "tracked.txt"]);
    assert.equal((await inspectGit(deps)).dirty, false);

    writeFileSync(join(repo, "untracked.txt"), "new\n");
    assert.equal((await inspectGit(deps)).dirty, true);
    unlinkSync(join(repo, "untracked.txt"));
    assert.equal((await inspectGit(deps)).dirty, false);

    writeFileSync(join(repo, "ignored.txt"), "secret\n");
    assert.equal((await inspectGit(deps)).dirty, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
