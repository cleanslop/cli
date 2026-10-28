import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- plain .mjs CI helper without type declarations
import { findLeaks } from "../scripts/check-public.mjs";

const dirs: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cleanslop-public-"));
  dirs.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the CLI tree itself is clean", () => {
  assert.deepEqual(findLeaks(fileURLToPath(new URL("..", import.meta.url))), []);
});

test("flags upstream names, tickets and app paths with their line", () => {
  // Built from pieces so this file stays clean too.
  const ticket = ["CLE", "123"].join("-");
  const docs = ["docs", "ops", ""].join("/");
  const app = ["src", "lib", ""].join("/");
  const host = ["prototype", "cleanslop"].join(".");
  const root = tree({
    "src/a.ts": `// ok\n// fixes ${ticket}\n`,
    "README.md": `see ${docs}x.md and ${app}y.ts\n`,
    "test/b.ts": `origin: "https://${host}.example"\n`,
  });
  const leaks = findLeaks(root).map(
    (l: { file: string; line: number; match: string }) => `${l.file}:${l.line}:${l.match}`
  );
  assert.deepEqual(leaks.sort(), [
    `README.md:1:${docs}`,
    `README.md:1:${app}`,
    `src/a.ts:2:${ticket}`,
    `test/b.ts:1:${host}`,
  ]);
});

test("checks file paths and skips build output and dependencies", () => {
  const root = tree({
    [`notes/${["h", "cto"].join("")}.md`]: "fine\n",
    [`node_modules/x/${["CLE", "1"].join("-")}.js`]: "",
    [`dist/${["CLE", "2"].join("-")}.js`]: "",
    "assets/logo.bin": `\0${["CLE", "3"].join("-")}`,
    "test/c.ts": 'origin: "https://staging.example"\n',
  });
  assert.deepEqual(
    findLeaks(root).map((l: { file: string; line: number }) => [l.file, l.line]),
    [[join("notes", `${["h", "cto"].join("")}.md`), 0]]
  );
});
