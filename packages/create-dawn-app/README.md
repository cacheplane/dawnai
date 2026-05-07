<p>
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# create-dawn-ai-app

Scaffold a new Dawn application from the supported starter templates. Generates a working app with Dawn's canonical `src/app` route layout, an `agent()` route, and the Dawn packages wired up for local development.

## Usage

```sh
pnpm create dawn-ai-app my-app
# or
npm create dawn-ai-app@latest my-app
# or
yarn create dawn-ai-app my-app
```

Then:

```sh
cd my-app
pnpm install
pnpm dawn dev
```

Requires Node.js 22.12+.

### Options

- `--template <name>` — choose a starter template (default: `basic`)

## What you get

The `basic` template scaffolds a Dawn app with one example route:

```
my-app/
  dawn.config.ts
  package.json
  tsconfig.json
  src/
    app/
      (public)/
        hello/
          [tenant]/
            index.ts        # exports agent({...})
            state.ts
            tools/
              greet.ts
```

The generated `package.json` wires `@dawn-ai/sdk`, `@dawn-ai/cli`, `@dawn-ai/core`, and `@dawn-ai/langchain`, with scripts for `dawn check`, `dawn build`, and `tsc` typecheck. Run any other `dawn` command via `pnpm dawn <command>`.

## Next steps

- Getting started — https://dawn-ai.org/docs/getting-started
- Routes — https://dawn-ai.org/docs/routes
- CLI — https://dawn-ai.org/docs/cli

## License

MIT
