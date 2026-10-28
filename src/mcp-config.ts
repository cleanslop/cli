import { dirname } from "node:path";
import type { CliDeps } from "./deps.js";
import { CliError, EXIT_USAGE } from "./exit.js";

export type McpHttpServer = {
  type?: "http";
  url: string;
};

export function mcpEndpoint(origin: string): string {
  return `${origin.replace(/\/$/, "")}/mcp`;
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function mergeMcpServers(
  existing: Record<string, unknown>,
  name: string,
  server: McpHttpServer
): Record<string, unknown> {
  const current = existing.mcpServers;
  const map =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  map[name] = { type: "http", url: server.url };
  return { ...existing, mcpServers: map };
}

export function removeMcpServer(
  existing: Record<string, unknown>,
  name: string
): Record<string, unknown> {
  const current = existing.mcpServers;
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return existing;
  }
  const map = { ...(current as Record<string, unknown>) };
  delete map[name];
  const next = { ...existing };
  if (Object.keys(map).length === 0) {
    delete next.mcpServers;
  } else {
    next.mcpServers = map;
  }
  return next;
}

export function writeMcpJson(
  deps: CliDeps,
  path: string,
  mutate: (current: Record<string, unknown>) => Record<string, unknown>
): void {
  let current: Record<string, unknown> = {};
  if (deps.fs.exists(path)) {
    const parsed = parseJsonObject(deps.fs.read(path));
    if (!parsed) {
      throw new CliError(
        `Refusing to overwrite invalid JSON at ${path}. Fix or remove that file and re-run setup.`,
        EXIT_USAGE
      );
    }
    current = parsed;
  }
  const next = mutate(current);
  const mode = deps.fs.exists(path) ? deps.fs.statMode(path) : 0o644;
  deps.fs.mkdir(dirname(path), 0o755);
  deps.fs.write(path, `${JSON.stringify(next, null, 2)}\n`, mode);
}

export function claudeMcpAddCommand(origin: string): string {
  return `claude mcp add --transport http --scope user cleanslop ${mcpEndpoint(origin)}`;
}

export function codexMcpAddCommand(origin: string): string {
  return `codex mcp add cleanslop --url ${mcpEndpoint(origin)}`;
}

export function codexMcpLoginCommand(): string {
  return "codex mcp login cleanslop";
}
