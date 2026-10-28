# CleanSlop CLI

Readiness scans from your coding agent. The CLI starts a [CleanSlop](https://cleanslop.com) scan of your repo, waits for it, and hands the report back so the agent can fix what it finds. Published as `@cleanslop/cli` (bin `cleanslop`).

- Setup guide and FAQ: <https://cleanslop.com/agents>
- Agent guide (Markdown): <https://cleanslop.com/agents.md>
- Prefer MCP? Install the remote server: <https://cleanslop.com/mcp>

## Quick start

```bash
npx -y @cleanslop/cli scan
```

Run it from a git checkout whose `HEAD` is pushed to github.com. Then `npx -y @cleanslop/cli setup` installs the skill or rules for Claude Code, Cursor and Codex so your agent runs it for you.

Requires Node 22 or later (Node 20 is end-of-life; npm warns there). **Zero runtime dependencies.** Link commands shell out to `link-cli` (`CLEANSLOP_LINK_CLI`, else `PATH`, else a pinned `npx @stripe/link-cli`); uploads pack with a built-in tar writer.

## Commands

| Command | Purpose |
|---|---|
| `scan` (default) | Resolve the github.com origin + HEAD, start a scan, optionally `--wait` |
| `login [--no-wait \| --resume]` | RFC 8628 device flow. Prints `verification_uri_complete` and `user_code`. `--no-wait` stores the device code; `--resume` finishes it. Never prints the token. |
| `logout [--all]` | Revoke server-side, delete this origin's credentials, and drop its pending GitHub login and Link payment. `--all` revokes every saved origin's token and deletes all local CleanSlop data (Link's own session and `~/.link-cli` files stay; `link-cli auth logout` clears the session) |
| `whoami` | Connected `@login` and token last4 |
| `status [id] [--wait]` | Poll scan status |
| `report [id] [--format md\|json] [--preview]` | Fetch `cleanslop.report.v1` (the whole list: `limit=250`). A final Markdown report with confirmed or needs-input findings is followed on stderr by a `fix_findings` question (Fix them / Show me first / Not now); `scan` does the same. Exit stays 0. |
| `setup` | Idempotent skill/rules. Never logs in, never writes a token |
| `redeem <code>` | Redeem a promo (invite) code the human gave you for free scans (`POST /api/agent/v1/credits/redeem`). One code per account; `promo_invalid` / `promo_already_redeemed` exit 12 with an `ask_human` block. |
| `billing` | Link account: `POST /api/agent/v1/billing/sign-in-link` has the server email a sign-in link to the account's Link address, where the human subscribes, buys credits or cancels a plan. Prints the masked address it went to, plus `/signin/email?from=agent` and the masked email to type if it does not arrive. When the server cannot send (email login off, rate limited) or is older (404, read `webBilling` from `GET /me`), it prints only the typed-address page. The CLI never sees the link. Exits 10 with an `ask_human` block; `--json` prints `{sent, expiresAt \| reason, webBilling}`. Prints "Not available for this account" (exit 0) without `webBilling`. |
| `plan [starter\|pro\|max]` | Link account: starts a monthly plan paid each month from a recurring Link approval (`link-cli spend-request create --recurring-interval month`), then `POST /api/agent/v1/plans/purchases`. Without a plan name an agent gets a `link_plan` question (Starter, Pro, Max with monthly prices, Not now). Same `--no-wait` / `--resume` flow as `credits buy --link`, saved in its own `pending-plan-request.json`. When CleanSlop offers no Link plans it does what `billing` does. Prints "Started the CleanSlop … plan" (exit 0). Change or cancel the plan with `billing`. |

### Wait

- `--wait` defaults to **8 minutes** when no duration is given.
- `--wait 75m` is the Claude Code background budget.
- Durations: `30s`, `8m`, `1h`.
- Honour `pollAfterSec` (10 pending/first pass, 20 review, 30 past p90); never poll faster than 3 seconds. Print the ETA while waiting.
- At the deadline: exit **75** and print the ETA plus `cleanslop status <id> --wait`.

### Setup

Default is **user scope**:

| Agent | Path |
|---|---|
| Claude Code | `~/.claude/skills/cleanslop/SKILL.md` |
| Cursor | `~/.cursor/rules/cleanslop.mdc` |
| Codex | marker block in `~/.codex/AGENTS.md` |

`--project` writes `.cursor/rules/cleanslop.mdc` and an `AGENTS.md` marker in the current repo. `--dry-run` / non-TTY without `--yes` only print the plan. `--uninstall` removes the marker blocks / owned files.

Skill / Cursor rules / AGENTS snippet are generated from [`assets/skill-core.md`](./assets/skill-core.md), and so is the plugin's [`plugin/skills/cleanslop/SKILL.md`](./plugin/skills/cleanslop/SKILL.md) (`npm run plugin:skill`). Remote MCP is a separate install: see <https://cleanslop.com/mcp>.

## Credentials

- `$XDG_CONFIG_HOME/cleanslop/credentials.json` or `~/.config/cleanslop/` (Windows: `%APPDATA%\cleanslop\`)
- Directory `0700`, file `0600`
- Refuses to write inside the current git worktree
- `CLEANSLOP_TOKEN` and `CLEANSLOP_ORIGIN` override the file / default origin (`https://cleanslop.com`)
- The token is never printed; `whoami` shows last4

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done |
| 1 | Unexpected error |
| 2 | Usage or config |
| 10 | Human action (approve, install, reauth) |
| 11 | Payment (402) |
| 12 | Policy (waitlisted, beta, cap) |
| 13 | Source unavailable (dirty, unpushed, not github.com) |
| 20 | Scan failed server-side |
| 75 | Still running; resume command printed |

`CLEANSLOP_ACTION_REQUIRED` blocks go to stderr. Never open, approve, or pay. A block may end with a `CLEANSLOP_QUESTION:` JSON line (`id`, `header`, `question`, `options[]` with `value`, `label`, optional `description`, and `run` for the exact next command or `next` for a plain next step; neither means stop). Agents with a multiple-choice question tool (for example Claude Code's AskUserQuestion) should ask with it, using exactly those options, and never answer for the human. Consent questions never carry `--agree`.

## Claude Code plugin

This repository is also a Claude Code plugin marketplace. The plugin bundles the skill and the remote MCP server:

```text
/plugin marketplace add cleanslop/cli
/plugin install cleanslop@cleanslop
```

## Development

```bash
npm ci
npm test
npm run build
node dist/index.js scan
```

`test/` uses `node:test` and c8 against a fake HTTP server. The coverage floor is 90% for lines, statements and functions, and 80% for branches. `npm test` also checks that the tree names no upstream-only hosts or paths (`scripts/check-public.mjs`).

This repository is a read-only mirror of the CLI's upstream source; see [CONTRIBUTING.md](./CONTRIBUTING.md) for how pull requests land. Each sync to `main` stages the next patch release (`scripts/release-version.mjs`) with npm provenance, and a maintainer approves it under Staged Packages on npmjs.com, then publishes the GitHub release drafted from [CHANGELOG.md](./CHANGELOG.md). Do not `npm publish` by hand.

## License

[MIT](./LICENSE)
