<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# create-dawn-ai-app

Scaffold a new Dawn app — the fastest way to start building LangGraph agents like Next.js apps. Generates a working application from the supported starter templates with Dawn's canonical `src/app` route layout, an `agent()` route, durable threads, and the Dawn packages wired up for local development.

## Usage

```sh
npm create dawn-ai-app@latest my-app
cd my-app
npm install
cp .env.example .env
# Add a real OPENAI_API_KEY to .env
npm run verify
npm run dev
```

Requires Node.js 24 or later and npm 11. The generated research app's live path
uses a real model; its tests and evals use deterministic fixtures for offline
confidence.

You can also scaffold with `pnpm create dawn-ai-app my-app` or
`yarn create dawn-ai-app my-app`, but Node 24 with npm 11 is the supported
generated-app path.

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
        subagents/
          researcher/
            index.ts
        skills/
          cite-sources/
            SKILL.md
          synthesize-findings/
            SKILL.md
        evals/
          research-quality.eval.ts
    tools/
      searchCorpus.ts                 # shared corpus search
      readDoc.ts                      # shared full-document reader
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

### Live activation

Copy `.env.example` to `.env`, add a real `OPENAI_API_KEY`, run
`npm run verify`, then run `npm run dev`. The generated dev script serves Dawn
on `http://127.0.0.1:3000`; invoke `/research#agent` through its Agent Protocol
or AG-UI endpoints.

### Offline confidence

Run `npm run typegen` to write `.dawn/dawn.generated.d.ts`. Run
`npm run check` to validate routes, tools, and configuration without writing
generated files. `npm run typecheck`, `npm test`, and `npm run eval` complete
the offline authoring checks; tests and evals replay deterministic fixtures and
are not a keyless product demo.

### Build and start

Run `npm run build` followed by `npm start`. The first command writes the
configured artifacts under `.dawn/build`; the second loads `.env` when present
and serves `.dawn/build/server.mjs`. `npm start` requires a successful build
first.

The generated `package.json` wires `@dawn-ai/sdk`, `@dawn-ai/cli`,
`@dawn-ai/langchain`, `@dawn-ai/sandbox`, and `zod`. Its main scripts are
`dev`, `verify`, `typegen`, `check`, `typecheck`, `test`, `eval`, `build`, and
`start`. Run other CLI commands with `npx dawn <command>`.

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
