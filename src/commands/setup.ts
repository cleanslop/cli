import { dirname, join } from "node:path";
import { SKILL_MARKER_BEGIN, SKILL_MARKER_END } from "../config.js";
import { resolveOrigin } from "../credentials.js";
import type { CliDeps } from "../deps.js";
import { EXIT_OK } from "../exit.js";
import {
  claudeMcpAddCommand,
  codexMcpAddCommand,
  codexMcpLoginCommand,
  mcpEndpoint,
  mergeMcpServers,
  removeMcpServer,
  writeMcpJson,
} from "../mcp-config.js";
import {
  loadSkillCore,
  removeMarkerBlock,
  renderAgentsSnippet,
  renderCursorMdc,
  renderSkillMd,
  upsertMarkerBlock,
} from "../skill.js";

export type SetupTarget = {
  id: "claude" | "cursor" | "codex" | "agents";
  label: string;
  path: string;
  kind: "owned" | "marker";
  render: (core: string) => string;
};

export function setupTargets(deps: CliDeps, project: boolean): SetupTarget[] {
  const home = deps.env.homeDir();
  const cwd = deps.env.cwd();
  const coreRender = {
    skill: renderSkillMd,
    mdc: renderCursorMdc,
    agents: renderAgentsSnippet,
  };
  if (project) {
    return [
      {
        id: "cursor",
        label: "Cursor project rule",
        path: join(cwd, ".cursor", "rules", "cleanslop.mdc"),
        kind: "owned",
        render: coreRender.mdc,
      },
      {
        id: "agents",
        label: "AGENTS.md (project)",
        path: join(cwd, "AGENTS.md"),
        kind: "marker",
        render: coreRender.agents,
      },
    ];
  }
  return [
    {
      id: "claude",
      label: "Claude Code skill",
      path: join(home, ".claude", "skills", "cleanslop", "SKILL.md"),
      kind: "owned",
      render: coreRender.skill,
    },
    {
      id: "cursor",
      label: "Cursor user rule",
      path: join(home, ".cursor", "rules", "cleanslop.mdc"),
      kind: "owned",
      render: coreRender.mdc,
    },
    {
      id: "codex",
      label: "Codex AGENTS.md",
      path: join(home, ".codex", "AGENTS.md"),
      kind: "marker",
      render: coreRender.agents,
    },
  ];
}

function mcpConfigPaths(deps: CliDeps, project: boolean): {
  cursor: string;
} {
  const home = deps.env.homeDir();
  const cwd = deps.env.cwd();
  return {
    cursor: project
      ? join(cwd, ".cursor", "mcp.json")
      : join(home, ".cursor", "mcp.json"),
  };
}

function planLine(target: SetupTarget, uninstall: boolean): string {
  const verb = uninstall ? "remove" : "write";
  return `  ${verb} ${target.label}: ${target.path}`;
}

function writeOwned(deps: CliDeps, path: string, body: string): void {
  deps.fs.mkdir(dirname(path), 0o755);
  const text = body.endsWith("\n") ? body : `${body}\n`;
  deps.fs.write(path, text, 0o644);
}

function writeMarker(deps: CliDeps, path: string, block: string): void {
  const existing = deps.fs.exists(path) ? deps.fs.read(path) : "";
  const next = upsertMarkerBlock(existing, block);
  deps.fs.mkdir(dirname(path), 0o755);
  deps.fs.write(path, next.endsWith("\n") ? next : `${next}\n`, 0o644);
}

function uninstallTarget(deps: CliDeps, target: SetupTarget): void {
  if (!deps.fs.exists(target.path)) return;
  if (target.kind === "owned") {
    deps.fs.rm(target.path);
    return;
  }
  const next = removeMarkerBlock(deps.fs.read(target.path));
  if (next.trim().length === 0) {
    deps.fs.rm(target.path);
    return;
  }
  deps.fs.write(target.path, next.endsWith("\n") ? next : `${next}\n`, 0o644);
}

export async function runSetup(
  deps: CliDeps,
  args: { dryRun: boolean; uninstall: boolean; project: boolean; yes: boolean }
): Promise<number> {
  const targets = setupTargets(deps, args.project);
  const writeAllowed = args.yes || deps.io.stdinIsTTY;
  const dry = args.dryRun || !writeAllowed;

  deps.io.stdout(
    args.uninstall
      ? "CleanSlop setup uninstall plan\n"
      : "CleanSlop setup plan\n"
  );
  const origin = resolveOrigin(deps);
  const mcpPaths = mcpConfigPaths(deps, args.project);
  for (const target of targets) {
    deps.io.stdout(`${planLine(target, args.uninstall)}\n`);
  }
  deps.io.stdout(
    args.uninstall
      ? `  remove MCP: ${mcpPaths.cursor}\n`
      : `  register MCP: ${mcpPaths.cursor} -> ${mcpEndpoint(origin)}\n`
  );
  if (!args.project && !args.uninstall) {
    deps.io.stdout(`  ${claudeMcpAddCommand(origin)}\n`);
    deps.io.stdout(`  ${codexMcpAddCommand(origin)}\n`);
    deps.io.stdout(`  ${codexMcpLoginCommand()}\n`);
  }
  deps.io.stdout(
    "  This command never logs in and never writes a token.\n"
  );

  if (dry) {
    if (!args.dryRun && !writeAllowed) {
      deps.io.stderr(
        "Non-TTY setup prints the plan only. Re-run with --yes to write.\n"
      );
    }
    return EXIT_OK;
  }

  if (args.uninstall) {
    for (const target of targets) {
      uninstallTarget(deps, target);
    }
    if (deps.fs.exists(mcpPaths.cursor)) {
      writeMcpJson(deps, mcpPaths.cursor, (current) =>
        removeMcpServer(current, "cleanslop")
      );
    }
    deps.io.stdout("Removed CleanSlop skill/rules markers.\n");
    return EXIT_OK;
  }

  const core = loadSkillCore((path) => {
    if (deps.fs.exists(path)) return deps.fs.read(path);
    throw new Error(`Missing skill source: ${path}`);
  });
  for (const target of targets) {
    const rendered = target.render(core);
    if (target.kind === "owned") {
      writeOwned(deps, target.path, rendered);
    } else {
      writeMarker(deps, target.path, rendered);
    }
  }
  writeMcpJson(deps, mcpPaths.cursor, (current) =>
    mergeMcpServers(current, "cleanslop", { url: mcpEndpoint(origin) })
  );
  deps.io.stdout("Installed CleanSlop skill/rules and registered MCP.\n");
  return EXIT_OK;
}

export const SETUP_MARKERS = {
  begin: SKILL_MARKER_BEGIN,
  end: SKILL_MARKER_END,
};
