# Changelog

<!-- One `## x.y.z` section per npm release, written in the same change. The
release workflow drafts the GitHub release from the section for the version it
stages; a version with no section gets a draft with only the npm link. -->

## 0.2.0

- Scans now cost scan credits: 4 credits per scan, and every balance, plan allowance and pack is shown ×4 (a 5-scan pack is 20 credits). Nothing costs more than before.
- `cleanslop whoami` shows your plan's monthly credits and your remaining credits when the server sends them; older servers still show scans.
- `cleanslop redeem` and `cleanslop credits buy --link` report what was added and your balance in credits.
- `--json` output keeps the old scan fields and adds `creditBalance` (whoami) and `creditsGranted` / `purchasedCredits` (redeem).
- When a scan would cost more than 4 credits, `cleanslop scan` stops before charging and asks (exit 10, `CLEANSLOP_QUESTION` id `scan_credits`): scan for that price, or stop. After a yes, rerun with `--confirm-credits <credits>`. A started scan prints the credits it holds ("Reserved 8 credits for this scan"); if it reads less, the difference comes back.
- Rescans are incremental: `cleanslop scan` builds on the last scan of the branch, or of the uploaded folder, and costs only the files changed since. It prints `Incremental scan building on <scan id>`, or `Full scan: <why>` when there is nothing to build on. `--full` rescans everything. `--json` scans include `incremental` and `parentScanId`.
- When nothing changed since the last scan, `cleanslop scan` stops before charging and asks (exit 10, `CLEANSLOP_QUESTION` id `scan_unchanged`): scan everything again with `--full`, or stop.
- Credit packs are described in credits, not scans: `p15 (60 credits, 48.00 USD, 0.80 USD per credit)`. The Link line item says the pack's credits too (it said its scans).
- `cleanslop whoami` says `a scan uses 1 to 20 by size` when the server prices scans by size, and still `a scan uses 4` while every scan costs 4.
- Every request sends `X-CleanSlop-CLI-Features: confirm-credits`, so the server knows this CLI can confirm scan prices even when it is a source build.
- Claude Code plugin 0.2.0: the skill tells the agent to ask before a scan over 4 credits and never to pass a price the human did not approve, and to use `--full` only when the human asks to rescan everything.
- The Claude Code plugin moved to [cleanslop/skills](https://github.com/cleanslop/skills), alongside the MCP Registry entry. Install it with `/plugin marketplace add cleanslop/skills`. The `cleanslop` marketplace in this repository now points there, so existing installs keep updating.

## 0.1.7

- Stripe Link sign-in no longer asks for your balances and transactions. link-cli 1.1 and later request them by default; the CLI now opts out with `--no-financial-insights`. A session that already granted them keeps them until `link-cli auth logout`.
- Needs link-cli 1.2.0 or later. An older `link-cli` on PATH is skipped for the bundled `npx @stripe/link-cli@1.3.0` (was 0.29.0), which opens browser links on Windows without going through `cmd`; a `CLEANSLOP_LINK_CLI` older than 1.2.0 is an error.
- link-cli always runs from the CLI's config folder, with the project's `node_modules/.bin` taken off PATH, so the repo you scan can't choose which link-cli or npm settings are used. Your existing Link session is shared and left as it is.
- 3D Secure and other Link verification steps now finish on the same payment. Before, the CLI dropped the payment and asked for a new one. It shows Link's message and link, and waits.
- A Link payment that fails stops at once with Link's reason and an offer to try again, instead of waiting out the approval timer.
- A credit-pack payment (the Link spend request and its token) now expires about 3 hours after it is created instead of 7 days. How long you have to approve it does not change. Monthly plans are unchanged.
- A payment Link already shows as charged is never paid again: a rerun finishes the original purchase, or says it already went through (or is still processing).
- If Link asks you to do something first (for example add a payment method), the CLI says so with Link's link, and starts a new payment only after you say Done.
- A Link step with no details yet keeps the same payment and keeps checking, instead of dropping it.
- A relative `CLEANSLOP_LINK_CLI` path is read from your working folder; prerelease link-cli builds count as older than 1.2.0.
- Prices show each currency's decimal places.

## 0.1.6

- Claude Code plugin 0.1.3: adds a README describing what the plugin runs and sends, and a description that covers the skill, the MCP server and the CLI, ahead of listing it in Anthropic's plugin directory.
- Plugin README: Stripe Link sign-ins upload the working tree on every scan without asking (only GitHub sign-ins ask first), what an upload leaves out, and that GitHub accounts buy on cleanslop.com while Link accounts approve in Link.
- Marketplace description matches the plugin's.
- README: npm version, license and Node version badges.
- No changes to the CLI itself.

## 0.1.5

- Claude Code plugin 0.1.2: adds an icon, author details and a privacy policy link. Existing installs pick it up with `claude plugin update cleanslop@cleanslop`.
- npm keywords, so the package shows up in npm search.
- No changes to the CLI itself.

## 0.1.4 - 2026-10-28

- Open source under the MIT license. Releases are now built from this repository and published with npm provenance.
- **Requires Node 22 or later** (was 20; Node 20 is end-of-life).
- This repository is also a Claude Code plugin marketplace: `/plugin marketplace add cleanslop/cli`.
- No changes to CLI commands or behaviour.

## 0.1.3 and earlier

Released before the source was public.
