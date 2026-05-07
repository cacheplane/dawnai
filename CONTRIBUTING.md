# Contributing

Thanks for helping improve Dawn. This guide covers the public contribution path. For the detailed monorepo layout, package ownership, and verification lanes, see [CONTRIBUTORS.md](./CONTRIBUTORS.md).

## Development Setup

Use Node.js `>=22.12.0` and pnpm `10.33.0`.

```bash
pnpm install
```

Run commands from the repository root so Turbo, workspace packages, and verification scripts resolve consistently.

## Useful Commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
node scripts/check-docs.mjs
pnpm pack:check
```

Before opening a larger PR, run the full validation lane:

```bash
pnpm ci:validate
```

## Issues

Use GitHub Issues for reproducible bugs and concrete feature requests. Include the Dawn package or command involved, your Node.js and pnpm versions, and the smallest reproduction you can provide.

Do not file security vulnerabilities as public issues. See [SECURITY.md](./SECURITY.md).

## Pull Requests

Keep PRs focused and explain the user-visible behavior change. Include validation commands in the PR description.

For package changes, check whether a changeset is needed. A changeset is usually appropriate when a publishable package changes behavior, public types, CLI output, or documentation that should be reflected in a release note.

This repository does not currently require DCO sign-offs. A CLA process may be introduced later, but there is no CLA enforcement in this contribution flow today.

## License

By contributing, you agree that your contribution will be licensed under the MIT License used by this repository.
