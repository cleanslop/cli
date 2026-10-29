# CleanSlop for Claude Code

Readiness scans from your coding agent. Before Claude says a change is done or opens a pull request, it starts a [CleanSlop](https://cleanslop.com) scan of your repository, waits for the report, and fixes what it finds.

## Install

In Claude Code (2.1.275 or later):

```text
/plugin install cleanslop --marketplace cleanslop/cli
```

On older versions, add the marketplace first:

```text
/plugin marketplace add cleanslop/cli
/plugin install cleanslop@cleanslop
```

## What it adds

- **A skill, `cleanslop`.** It tells Claude when to scan (at milestones, before a PR, or when you ask), how to start a scan and wait for it, how to read the report, and when to stop and ask you instead of acting.
- **A remote MCP server, `cleanslop`,** at `https://cleanslop.com/mcp`. Its tools are `whoami`, `scan_start`, `scan_wait`, `scan_status`, `report_get`, `promo_redeem`, `send_feedback`, `feedback_replies` and `email_opt_in`. Nothing runs on your machine for it.

## Sign in

The first time Claude uses the server, Claude Code opens `cleanslop.com` in your browser. You sign in with GitHub and approve access once (scopes `scan`, `report` and `email`). You can also run `/mcp` and pick `cleanslop` to connect ahead of time.

## What it runs and sends

- **Scans of pushed code (GitHub sign-in).** For a clean commit that is pushed to github.com, the plugin sends the repository URL, commit and branch to CleanSlop, and CleanSlop reads the code from GitHub through its read-only GitHub App, as committed. Your local files are not sent.
- **The CleanSlop CLI, when MCP can't do the job:** when the server isn't connected, to sign in with Stripe Link, or to scan local files. The skill then runs `npx -y @cleanslop/cli@latest`, the open-source CLI published from [this repository](https://github.com/cleanslop/cli) to npm with provenance. It stores its token in `~/.config/cleanslop/credentials.json` (mode `0600`) and never prints it.
- **Local files with a GitHub sign-in, only if you choose to.** When there are uncommitted or unpushed changes, or the repository isn't on GitHub, the CLI asks you first. Only if you pick "Scan local files" does it pack the working tree and upload it to CleanSlop.
- **Local files with a Stripe Link sign-in, on every scan.** A Link sign-in scans by upload: every scan packs the working tree and uploads it to CleanSlop without asking first.
- **What an upload contains.** The files git tracks or would track, except `.env` files, keys and credential files, which never leave your machine. `cleanslop scan --dry-run` lists the files before anything goes up. Uploads are not used for training.
- **Payments, only with your approval.** Claude never approves or pays. With a GitHub sign-in, you buy scan credits or a plan on cleanslop.com, and Claude only passes on the checkout link. With a Stripe Link sign-in, you approve every payment in your Link app.

Reports are private to your CleanSlop account.

## Links

- Setup guide and FAQ: <https://cleanslop.com/agents>
- Privacy policy: <https://cleanslop.com/privacy>
- Terms: <https://cleanslop.com/terms>
- Issues: <https://github.com/cleanslop/cli/issues>

MIT licensed.
