<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# create-dawn-ai-app

Scaffold a new Dawn app — the fastest way to start building LangGraph agents like Next.js apps. Generates a working application from the supported starter templates with Dawn's canonical `src/app` route layout, an `agent()` route, durable threads, and the Dawn packages wired up for local development.

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
pnpm dawn check
```

Requires Node.js 22.12+.

### Options

- `--template <name>` — choose a starter template (default: `research`). Use `--template basic` for the smaller greeter app.
- `--mode external|internal` — choose dependency wiring. `external` (default) installs published Dawn packages; `internal` points package overrides at a local Dawn monorepo checkout.
- `--dist-tag <tag>` — package version or npm dist tag used in external mode (default: `latest`).

## What you get

The default `research` template scaffolds a complete deep-research assistant:

```
my-app/
  dawn.config.ts
  package.json
  tsconfig.json
  src/
    app/
      research/
        index.ts                      # research coordinator agent
        state.ts
        plan.md                       # seeds the thread's todos
        memory.ts
        memory.md
        tools/
          searchCorpus.ts
          readDoc.ts
        evals/
          research-quality.eval.ts
  test/
    research.test.ts
  workspace/
    AGENTS.md
    corpus/
      agent-architectures.md
      context-windows-and-offloading.md
      evaluating-llm-apps.md
      retrieval-augmented-generation.md
      tool-use-and-function-calling.md
    scripts/
      fetch-source.mjs
```

Run it offline with `pnpm dawn check`, `pnpm test`, and `pnpm dawn eval`. To invoke the route live, start `pnpm dawn dev` and run `/research#agent` through the Agent Protocol thread endpoints.

The generated `package.json` wires `@dawn-ai/sdk`, `@dawn-ai/cli`, `@dawn-ai/core`, and `@dawn-ai/langchain`, with scripts for `dawn check`, evals, tests, and TypeScript typecheck. Run any other `dawn` command via `pnpm dawn <command>`.

### Basic template

Pass `--template basic` to scaffold the compact greeter example instead. That optional template uses the route `src/app/(public)/hello/[tenant]/index.ts` with the parameterized route id `/hello/[tenant]`.

## Next steps

- [Getting started](https://dawnai.org/docs/getting-started)
- [Routes](https://dawnai.org/docs/routes)
- [CLI](https://dawnai.org/docs/cli)

---

⭐ [Star Dawn on GitHub](https://github.com/cacheplane/dawnai) · 📚 [Read the docs](https://dawnai.org/docs/getting-started) · 💬 [Ask in GitHub Discussions](https://github.com/cacheplane/dawnai/discussions)

## License

MIT
