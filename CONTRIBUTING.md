# Contributing

Issues and pull requests are welcome.

## How changes land

This repository is a read-only mirror. The CLI is developed alongside the CleanSlop service, because most changes touch both the CLI and the API it calls. A sync commit copies the current tree here.

When we accept a pull request, a maintainer applies your commits upstream with your authorship kept. They come back in the next sync, which lists you as a co-author (`Co-authored-by`) and names your pull request (`Public-PR: #<n>`). We then close the pull request with a link to that sync. Don't push to `main`; only the mirror can.

## Before you open a pull request

```bash
npm ci
npm test
npm run build
```

- `npm test` runs `node:test` with c8 against a fake HTTP server. The coverage floor is 90% for lines, statements and functions, and 80% for branches.
- The CLI has **zero runtime dependencies**. Keep it that way.
- `assets/skill-core.md` is also the source of the Claude Code plugin's `SKILL.md`, which now lives in [cleanslop/skills](https://github.com/cleanslop/skills). The maintainers regenerate it and bump the plugin version upstream when the core changes.
- Keep it origin-neutral. Tests use `https://*.example` origins, and the default stays `https://cleanslop.com`.
- Changes to the HTTP contract (`/api/agent/v1/*`, exit codes, `CLEANSLOP_ACTION_REQUIRED` blocks) need a matching server change, so open an issue first.

## Security

Please don't open public issues for vulnerabilities. See [SECURITY.md](./SECURITY.md).
