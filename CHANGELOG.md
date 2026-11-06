# Changelog

<!-- One `## x.y.z` section per npm release, written in the same change. The
release workflow drafts the GitHub release from the section for the version it
stages; a version with no section gets a draft with only the npm link. -->

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
