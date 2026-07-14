<p align="center">
  <img src="docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="360" />
</p>

# Dawn

[![CI](https://github.com/cacheplane/dawnai/actions/workflows/ci.yml/badge.svg)](https://github.com/cacheplane/dawnai/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://github.com/cacheplane/dawnai/actions/workflows/scorecard.yml/badge.svg)](https://github.com/cacheplane/dawnai/actions/workflows/scorecard.yml)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13317/badge)](https://www.bestpractices.dev/projects/13317)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](./LICENSE)

Build LangGraph agents like Next.js apps. Dawn is the TypeScript meta-framework for LangGraph — author AI agents and workflows as filesystem routes with route-local tools, generated types, durable threads, and an HMR dev server. Keep the runtime, drop the boilerplate.

<p align="center">
  <img src="docs/brand/quickstart.gif" alt="Dawn quickstart — scaffold a route and invoke it in under a minute" width="900" />
</p>

## Why Dawn?

- **Kill the LangGraph boilerplate.** Export one `agent({ model, systemPrompt })` descriptor. Dawn discovers it, wires route-local tools into the generated graph, and emits a `langgraph.json` package ready for LangSmith.
- **Filesystem-routed agents.** Filesystem routes under `src/app/` — colocate state schemas, tools, middleware, and tests next to the route they belong to. No more ad-hoc folders.
- **A real local dev loop.** `dawn dev` runs your routes locally with Agent Protocol thread endpoints: create a thread, then call `/threads/:thread_id/runs/wait` or `/threads/:thread_id/runs/stream`. Iterate in seconds, then verify the generated deployment artifact before shipping.
- **Typed end to end (TypeScript).** Route params, state, and tool I/O are generated as TypeScript types. `dawn verify` is your pre-deploy gate.
- **Durable by default.** Every Dawn app ships a working SQLite checkpointer and thread store — no setup. Threads survive a `dawn dev` restart, and an agent that pauses for human input resumes exactly where it left off. LangGraph defines the checkpoint interface; Dawn ships the default implementation.
- **Test and evaluate before shipping.** `@dawn-ai/testing` provides CI-safe agent harnesses and fixture replay. `dawn eval` runs co-located evals in replay mode by default, with `--live` and `--record` for local real-model checks.
- **Sandbox when execution needs isolation.** Add `sandbox` to `dawn.config.ts` to route workspace filesystem and shell calls through a provider; `@dawn-ai/sandbox` includes a Docker reference implementation.
- **Two ways to drive the model.** A route exports one of `agent` (LLM picks tools at runtime, can pause for a human), `workflow` (deterministic typed async function when you own the order), `graph`, or `chain`. Same routing, same types, same dev loop — you choose who's in charge.

## Without Dawn / With Dawn

Same LangGraph deployment shape, less code to author.

### Without Dawn

```ts
// graph.ts
import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { ChatOpenAI } from "@langchain/openai"
import { tool } from "@langchain/core/tools"
import { z } from "zod"

const greet = tool(async ({ name }) => `Hello, ${name}!`, {
  name: "greet",
  description: "Greet a user by name.",
  schema: z.object({ name: z.string() }),
})

const model = new ChatOpenAI({ model: "gpt-5-mini" }).bindTools([greet])
const tools = new ToolNode([greet])

async function callModel(state: typeof MessagesAnnotation.State) {
  return { messages: [await model.invoke(state.messages)] }
}

function shouldContinue(state: typeof MessagesAnnotation.State) {
  const last = state.messages.at(-1) as any
  return last?.tool_calls?.length ? "tools" : END
}

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", callModel)
  .addNode("tools", tools)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue, ["tools", END])
  .addEdge("tools", "agent")
  .compile()
```

```json
// langgraph.json
{
  "dependencies": ["."],
  "graphs": { "hello": "./graph.ts:graph" },
  "node_version": "22",
  "env": ".env"
}
```

### With Dawn

```ts
// src/app/research/index.ts
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  description:
    "A deep-research assistant: plans sub-questions, dispatches researchers, and writes a cited report.",
  systemPrompt:
    "You are a deep-research coordinator. Search the corpus, cite every claim, and write reports to the workspace.",
})
```

```ts
// src/app/research/tools/searchCorpus.ts
export default async ({ query }: { readonly query: string }) => {
  return [{ path: "corpus/agent-architectures.md", title: "Agent architectures" }]
}
```

`dawn build` emits the `langgraph.json` for you.

## Quickstart

1. Create a new app.

```bash
npm create dawn-ai-app@latest my-dawn-app
cd my-dawn-app
npm install
```

Requires Node.js 22.12 or later.

2. Validate the app and generate types.

```bash
npm run check
```

Offline path — no API key needed — via recorded fixtures:

```bash
npm test
```

3. Run it live. Set your API key and start the dev server:

```bash
export OPENAI_API_KEY=sk-...
npx dawn dev --port 2024
```

In another terminal, create a thread and run the research route through the Agent Protocol:

```bash
THREAD_ID=$(curl -s -X POST http://127.0.0.1:2024/threads -H 'content-type: application/json' -d '{}' | jq -r .thread_id)
curl -s -X POST http://127.0.0.1:2024/threads/$THREAD_ID/runs/wait \
  -H 'content-type: application/json' \
  -d '{"route":"/research#agent","input":{"messages":[{"role":"user","content":"What are common agent architectures?"}]}}' | jq .
```

Use `/threads/$THREAD_ID/runs/stream` with the same body when you want SSE events instead of a blocking JSON response.

4. Ship it. `dawn build` emits a runnable production server (`server.mjs` plus a hardened `Dockerfile`) alongside the LangSmith `langgraph.json` target; serve it locally with `dawn start`, or build and run the Docker image:

```bash
dawn build
npx dawn start
```

The default scaffold is the deep-research app at `/research`. For the smaller greeter scaffold, run `npm create dawn-ai-app@latest my-dawn-app -- --template basic`; that optional template uses `/hello/[tenant]`.

Prefer pnpm or yarn? Swap `npm create dawn-ai-app@latest` for `pnpm create dawn-ai-app` / `yarn create dawn-ai-app`, and `npm install`/`npm run`/`npx` for your package manager's equivalents.

## 30-Second Route

Dawn routes live under `src/app` and export one runtime entry. New agent routes should use the `agent()` descriptor from `@dawn-ai/sdk`; Dawn discovers the route, wires route-local tools into the generated graph, generates types, and produces a `langgraph.json` package for LangSmith.

```ts
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt:
    "You are a research coordinator. Search the local corpus, dispatch specialists when useful, and cite every claim.",
  retry: { maxAttempts: 3, baseDelay: 250 },
})
```

Add `state.ts` for a route state schema, `tools/*.ts` for route-local tools, `middleware.ts` for access control, and `run.test.ts` for colocated scenarios.

The built-in `agent()` route materializes to a LangChain chat model. Dawn infers providers for known model families; set `provider` explicitly to one of the supported built-in provider ids for aliases, ambiguous model names, local models, or provider-router model ids. Raw `graph` and `chain` routes can still instantiate any provider directly.

---

⭐ [Star Dawn on GitHub](https://github.com/cacheplane/dawnai) · 📚 [Read the docs](https://dawnai.org/docs/getting-started) · 💬 [Ask in GitHub Discussions](https://github.com/cacheplane/dawnai/discussions)

## Learn more

- [Getting started](https://dawnai.org/docs/getting-started)
- [Routes](https://dawnai.org/docs/routes)
- [Tools](https://dawnai.org/docs/tools)
- [State](https://dawnai.org/docs/state)
- [CLI](https://dawnai.org/docs/cli)
- [Dev server](https://dawnai.org/docs/dev-server)
- [Testing](https://dawnai.org/docs/testing)
- [Deployment](https://dawnai.org/docs/deployment)

---

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Repo layout and dev commands in [CONTRIBUTORS.md](./CONTRIBUTORS.md). Standards, workspace map, and Definition of Done in [AGENTS.md](./AGENTS.md). Security: [SECURITY.md](./SECURITY.md). Please follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

MIT. See [LICENSE](./LICENSE).
