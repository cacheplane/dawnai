<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/cli

The `dawn` CLI for Dawn, the TypeScript meta-framework for LangGraph — a local development runtime, route execution, validation and typegen, and the build step that produces LangSmith deployment artifacts. It is the primary tool for working on a Dawn agent app from first scaffold through deploy.

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

Installs a `dawn` binary on your `PATH`. Requires Node.js 22.12+.

## Commands

| Command        | Description                                                  |
|----------------|--------------------------------------------------------------|
| `dawn dev`     | Start the Dawn local development runtime                     |
| `dawn check`   | Validate a Dawn app (route discovery, tool definitions)      |
| `dawn verify`  | Verify dependencies and generated types are in sync          |
| `dawn build`   | Generate deployment artifacts for LangSmith                  |
| `dawn run`     | Execute one Dawn route invocation                            |
| `dawn test`    | Run route test scenarios                                     |
| `dawn routes`  | List discovered Dawn routes (use `--json` for machine output)|
| `dawn typegen` | Generate Dawn route and tool types into `.dawn/`             |

## Usage

```sh
# Start the local dev runtime
pnpm dawn dev

# Validate the app and regenerate types
pnpm dawn check
pnpm dawn typegen

# Produce LangSmith deployment artifacts
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
