export const PACKAGE_NAME = "@cleanslop/cli";
export const PACKAGE_VERSION = "0.1.0";
export const CLIENT_ID = "cleanslop-cli";
export const DEFAULT_ORIGIN = "https://cleanslop.com";
export const DEFAULT_WAIT_MS = 8 * 60 * 1000;
export const MIN_POLL_MS = 3000;
export const LONGPOLL_MAX_SEC = 45;
export const DEVICE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";
export const USER_AGENT = `${CLIENT_ID}/${PACKAGE_VERSION}`;
export const CREDENTIALS_FILE = "credentials.json";
export const PENDING_LOGIN_FILE = "pending-login.json";
export const PENDING_SPEND_FILE = "pending-spend-request.json";
export const PENDING_PLAN_FILE = "pending-plan-request.json";
export const SKILL_MARKER_BEGIN = "<!-- cleanslop:begin v1 -->";
export const SKILL_MARKER_END = "<!-- cleanslop:end -->";
export const TOKEN_RE = /cslop_(?:agt|mat|mrt)_[A-Za-z0-9]+/g;
/** Must match `EN_TERMS.updatedOn` on the server. */
export const TERMS_UPDATED_ON = "2026-10-09";
export const LINK_CLI_TIMEOUT_MS = 15_000;
/** Used when `link-cli` is not on PATH. Pinned: the CLI parses its JSON. */
export const LINK_CLI_PACKAGE = "@stripe/link-cli@0.29.0";
export const LINK_CLI_NPX_TIMEOUT_MS = 180_000;
export const PACK_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Same default as `AGENT_UPLOAD_MAX_COMPRESSED_BYTES` on the server. */
export const PACK_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
/** Same default as `AGENT_UPLOAD_MAX_EXTRACT_BYTES` on the server. */
export const PACK_MAX_TREE_BYTES = 1024 * 1024 * 1024;

export function defaultOrigin(): string {
  return DEFAULT_ORIGIN;
}

export function parseOrigin(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname && url.pathname !== "/") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}
