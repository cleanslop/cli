# Changelog

<!-- One `## x.y.z` section per npm release, written in the same change. The
release workflow drafts the GitHub release from the section for the version it
stages; a version with no section gets a draft with only the npm link. -->

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
