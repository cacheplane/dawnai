# Contributing

Thanks for helping improve Dawn. This guide covers the public contribution path for issues, pull requests, and package changes. For detailed monorepo layout, package ownership, and verification lanes, see [CONTRIBUTORS.md](./CONTRIBUTORS.md).

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

Use GitHub Issues for reproducible bugs and concrete feature requests. Include:

- Dawn package, command, or route surface involved.
- Dawn version or commit.
- Node.js and pnpm versions.
- The smallest reproduction, failing test, or route fixture you can provide.
- Expected behavior and actual behavior.

Use GitHub Discussions for usage questions, design discussions, and exploratory ideas.

Do not file security vulnerabilities as public issues. See [SECURITY.md](./SECURITY.md).

## Pull Requests

Keep PRs focused and explain the user-visible behavior change. Include:

- What changed.
- Why it changed.
- How you validated it.
- Screenshots for UI changes.
- Generated artifact paths for harness, packaging, or deployment changes.

Before opening a PR, run the smallest validation lane that proves the change. For broad package changes, run:

```bash
pnpm ci:validate
```

For package changes, check whether a changeset is needed. A changeset is usually appropriate when a publishable package changes behavior, public types, CLI output, or documentation that should be reflected in a release note.

```bash
pnpm exec changeset
```

No changeset is usually needed for internal-only tests, CI-only changes, repository docs, or non-published apps.

## CLA And DCO

This repository does not currently require a Contributor License Agreement or Developer Certificate of Origin sign-off.

If the project later needs CLA or DCO enforcement, it should be added as an explicit repository policy and CI check before being required from contributors.

## Code Of Conduct

All participation is covered by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contribution will be licensed under the MIT License used by this repository.
