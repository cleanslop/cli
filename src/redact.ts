import { TOKEN_RE } from "./config.js";

const PRIVATE_TOKEN_RE = /PrivateToken\s+token\s*=\s*"[^"]*"/gi;
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const SPT_RE = /spt_[A-Za-z0-9_]+/g;

export function redactSecrets(text: string): string {
  return text
    .replace(TOKEN_RE, "cslop_***")
    .replace(PRIVATE_TOKEN_RE, 'PrivateToken token="***"')
    .replace(JWT_RE, "[redacted-jwt]")
    .replace(SPT_RE, "spt_***");
}

export function tokenLast4(token: string): string {
  if (token.length < 4) return token;
  return token.slice(-4);
}
