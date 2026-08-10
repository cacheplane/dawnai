<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/cli

The `dawn` CLI for Dawn, the TypeScript meta-framework for LangGraph that lets you build LangGraph agents like Next.js apps — a local HMR development runtime with durable threads, route execution, validation and typegen, and a build step that produces the configured deployment artifacts. It is the primary tool for working on a Dawn agent app from first scaffold through deploy.

## Install

Project-local (recommended):

```sh
npm install -D @dawn-ai/cli
# or
pnpm add -D @dawn-ai/cli
```

Global:

```sh
npm install -g @dawn-ai/cli
# or
pnpm add -g @dawn-ai/cli
```

Installs a `dawn` binary on your `PATH`. Requires Node.js 24 or later.

## Commands

| Command        | Description                                                  |
|----------------|--------------------------------------------------------------|
| `dawn dev`     | Start the Dawn local development runtime                     |
| `dawn check`   | Validate a Dawn app without writing files                     |
| `dawn verify`  | Verify dependencies and generated types are in sync          |
| `dawn build`   | Generate the configured deployment artifacts                  |
| `dawn run`     | Execute one Dawn route invocation                            |
| `dawn test`    | Run route test scenarios                                     |
| `dawn routes`  | List discovered Dawn routes (use `--json` for machine output)|
| `dawn typegen` | Generate Dawn route and tool types into `.dawn/`             |

## Usage

```sh
# Start the local dev runtime
pnpm dawn dev

# Validate the app without writing generated files
pnpm dawn check

# Write route and tool types into .dawn/
pnpm dawn typegen

# Produce the configured deployment artifacts
pnpm dawn build
```

Run `dawn <command> --help` for command-specific options.

## Documentation

Full reference and guides:

- [CLI](https://dawnai.org/docs/cli)
- [Dev server](https://dawnai.org/docs/dev-server)
- [Deployment](https://dawnai.org/docs/deployment)
- [Getting started](https://dawnai.org/docs/getting-started)

---

⭐ [Star Dawn on GitHub](https://github.com/cacheplane/dawnai) · 📚 [Read the docs](https://dawnai.org/docs/getting-started) · 💬 [Ask in GitHub Discussions](https://github.com/cacheplane/dawnai/discussions)

## License

MIT
