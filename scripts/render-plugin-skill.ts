// Writes plugin/skills/cleanslop/SKILL.md from assets/skill-core.md, the same
// file `cleanslop setup` installs for Claude Code (not shipped in the package).
//
//   npm run plugin:skill
//
// test/plugin-skill.test.ts fails while the committed copy is stale.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillCore, renderSkillMd } from "../src/skill.js";

export const PLUGIN_SKILL_PATH = fileURLToPath(
  new URL("../plugin/skills/cleanslop/SKILL.md", import.meta.url)
);

export function renderPluginSkill(): string {
  return renderSkillMd(loadSkillCore());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(PLUGIN_SKILL_PATH, renderPluginSkill());
}
