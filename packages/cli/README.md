<p>
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/cli

The `dawn` command-line interface — local development runtime, route execution, validation and typegen, and the build step that produces LangGraph Platform deployment artifacts. It is the primary tool for working on a Dawn app from first scaffold through deploy.

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
| `dawn build`   | Generate deployment artifacts for LangGraph Platform         |
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

# Produce LangGraph Platform deployment artifacts
pnpm dawn build
```

Run `dawn <command> --help` for command-specific options.

## Documentation

Full reference and guides:

- CLI — https://dawn-ai.org/docs/cli
- Dev server — https://dawn-ai.org/docs/dev-server
- Deployment — https://dawn-ai.org/docs/deployment
- Getting started — https://dawn-ai.org/docs/getting-started

## License

MIT
