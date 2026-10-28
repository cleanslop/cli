import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PLUGIN_SKILL_PATH, renderPluginSkill } from "../scripts/render-plugin-skill.js";

test("the plugin skill is skill-core rendered for Claude Code", () => {
  assert.equal(
    readFileSync(PLUGIN_SKILL_PATH, "utf8"),
    renderPluginSkill(),
    "plugin/skills/cleanslop/SKILL.md is stale: run `npm run plugin:skill`"
  );
});

test("the plugin skill runs the scoped package", () => {
  const skill = readFileSync(PLUGIN_SKILL_PATH, "utf8");
  // Unscoped `cleanslop` on npm is not ours; never send agents to it.
  assert.match(skill, /npx -y @cleanslop\/cli@latest <command>/);
  assert.doesNotMatch(skill, /npx (-y )?cleanslop\b/);
});
