export type PromptSlug =
	| "scaffold"
	| "add-a-tool"
	| "write-a-route"
	| "write-a-test"
	| "deploy";

export interface PromptEntry {
	readonly slug: PromptSlug;
	readonly title: string;
	readonly description: string;
	readonly body: string;
}

const SCAFFOLD = `Help me scaffold a new Dawn app from the default research starter. Dawn is a TypeScript-first meta-framework for building graph-based AI agents with file-system routing, shared and route-local tools, and inferred types.

1. Run the scaffold:
   \`\`\`
   npm create dawn-ai-app@latest my-agent
   cd my-agent
   npm install
   \`\`\`

2. Walk me through the generated project structure. Explain:
   - How routes are directories containing an \`index.ts\` that exports exactly one of: default \`agent(...)\`, named \`workflow\` (async function), named \`graph\` (LangGraph graph), or named \`chain\` (LangChain LCEL Runnable).
   - \`state.ts\` — the optional Zod route state schema.
   - \`src/tools/*.ts\` — shared tools available across routes. The default research scaffold puts \`searchCorpus\` and \`readDoc\` here.
   - \`src/app/<route>/tools/*.ts\` — optional route-local tools. They are visible only to that route and shadow same-named shared tools.
   - \`plan.md\` — route-local planning seed that adds todo state and \`writeTodos\`.
   - \`subagents/<name>/index.ts\` — immediate child agent routes exposed through \`task({ subagent, input })\`; children receive shared tools and their own local tools, not the parent's local tools.
   - \`skills/<name>/SKILL.md\` — route-local instructions loaded on demand through \`readSkill\`.
   - \`memory.md\` — stable prompt memory for one route, and \`memory.ts\` — a typed long-term collection that contributes \`recall\` and \`remember\`.
   - \`workspace/\` — corpus, reports, and scripts; \`workspace/AGENTS.md\` is app-level prompt guidance shared by consuming agent routes and subagents.
   - Optional \`sandbox\` config — routes workspace filesystem and shell calls through a provider such as the Docker reference implementation.
   - Route groups like \`(public)\` — excluded from pathname when a template uses them.
   - Dynamic segments like \`[tenant]\` — preserved in the route id; provide values in JSON input when invoking the route. The optional \`--template basic\` scaffold uses \`/hello/[tenant]\`.
   - \`.dawn/dawn.generated.d.ts\` — auto-generated ambient types from the TypeScript compiler API.

3. Start with type generation, validation, typechecking, the offline deterministic agent harness tests, and the replay-backed eval. These need no model-provider key:
   \`\`\`
   npm run typegen
   npm run check
   npm run typecheck
   npm test
   npm run eval
   \`\`\`

4. Only then opt into a live model run. Copy the environment template, require the user to add a real \`OPENAI_API_KEY\`, run the preflight, and start the tested dev script. Never invent or commit a key:
   \`\`\`
   cp .env.example .env
   # Add a real OPENAI_API_KEY to .env
   npm run verify
   npm run dev
   \`\`\`
   The generated dev script serves \`http://127.0.0.1:3000\`.

5. In another terminal, show the Agent Protocol shape for the same route:
   \`\`\`
   THREAD_ID=$(curl -s -X POST http://127.0.0.1:3000/threads -H 'content-type: application/json' -d '{}' | jq -r .thread_id)
   curl -s -X POST http://127.0.0.1:3000/threads/$THREAD_ID/runs/wait \\
     -H 'content-type: application/json' \\
     -d '{"route":"/research#agent","input":{"messages":[{"role":"user","content":"What are common agent architectures?"}]}}'
   \`\`\`
   For streaming, use the same body with \`POST /threads/$THREAD_ID/runs/stream\` and consume the SSE events.

6. Summarize what I can build next: add a tool, add a new route, write an agent harness test, add a replay/live eval, or opt into sandboxed execution.

Key packages: \`@dawn-ai/sdk\` (authoring contract), \`@dawn-ai/langgraph\` (graphs/workflows), \`@dawn-ai/langchain\` (LCEL and provider-aware agent materialization), \`@dawn-ai/cli\` (CLI).

Reference: https://dawnai.org/llms.txt
`;

const ADD_A_TOOL = `Help me add a new tool to an existing Dawn app. Dawn discovers shared tools in \`src/tools/*.ts\` and route-local tools in \`src/app/<route>/tools/*.ts\`; their types are generated from TypeScript — no Zod schemas or manual type wiring.

1. Choose the tool's scope before creating it:
   - Put tools reused by multiple routes in \`src/tools/\`. This is where the default research scaffold keeps \`searchCorpus\` and \`readDoc\`.
   - Put a route-specific tool in \`src/app/<route>/tools/\`. A route-local tool is available only to that route and shadows a shared tool with the same name.

2. Add a TypeScript file with a default export that is an async function. This shared example is the default for the research scaffold:

   \`\`\`ts
   // src/tools/<tool-name>.ts
   export default async (input: { readonly /* fields */ }) => {
     // do work
     return { /* output */ }
   }
   \`\`\`

3. The input parameter type and the return type are both inferred. Dawn extracts them at build time and writes them into \`.dawn/dawn.generated.d.ts\`. The tool becomes available on typed \`ctx.tools\` for eligible workflows and callable graph functions, and \`dawn build\` wires it into generated agent entries.

4. Run \`dawn typegen\` to regenerate types after adding the tool (or leave \`dawn dev\` running — it does this on every file save).

5. For a \`workflow\`, or a callable \`graph\` function that explicitly receives Dawn \`RuntimeContext\`, update \`index.ts\` to call the tool via \`ctx.tools.<tool-name>({ ... })\`. A precompiled raw LangGraph object's \`.invoke()\` treats its second argument as LangGraph \`RunnableConfig\`, not Dawn's typed \`RuntimeContext\`; it keeps the tools its implementation already owns or imports rather than expecting workflow-style \`ctx.tools\`. For an \`agent\` route, leave \`index.ts\` as the default \`agent(...)\` descriptor; Dawn materializes the agent with its eligible tools.

6. Re-run the route with \`dawn run\` and confirm the new tool is invoked end-to-end.

Constraints:
- The default export must be a function (arrow or async function declaration).
- Input and output types must be serializable as JSON.
- \`readonly\` is recommended on input fields; Dawn preserves it through type generation.

Reference: https://dawnai.org/llms.txt
`;

const WRITE_A_ROUTE = `Help me add a new route to an existing Dawn app. Routes are directories under \`src/app/\` where each directory maps to a URL-style pathname (minus route groups).

1. Create the route directory. For a route under a dynamic \`[topic]\` segment:
   \`\`\`
   src/app/<new-route>/[topic]/
   \`\`\`

2. Optionally create \`state.ts\` — the route's Zod state schema:
   \`\`\`ts
   import { z } from "zod"

   export default z.object({
     topic: z.string().default(""),
     question: z.string().default(""),
   })
   \`\`\`

3. Create \`index.ts\` — the route entry. Export exactly ONE of:

   **Workflow** (async function, most common):
   \`\`\`ts
   import state from "./state.js"

   export async function workflow(input: unknown) {
     const parsed = state.parse(input)
     return { ...parsed, result: parsed.topic }
   }
   \`\`\`

   **Graph** (LangGraph graph/workflow):
   \`\`\`ts
   export const graph = /* langgraph graph instance */
   \`\`\`

   **Chain** (LangChain LCEL Runnable):
   \`\`\`ts
   export const chain = /* LCEL runnable */
   \`\`\`

   **Agent** (default descriptor):
   \`\`\`ts
   import { agent } from "@dawn-ai/sdk"

   export default agent({
     model: "gpt-5-mini",
     systemPrompt: "You are a helpful assistant.",
   })
   \`\`\`

4. If the route needs tools, add them at the appropriate scope: use \`src/tools/*.ts\` for tools shared across routes, or \`src/app/<new-route>/[topic]/tools/*.ts\` for route-local tools. A route-local tool shadows a same-named shared tool for that route. Then add a typed \`RuntimeContext\` parameter and call the tool through \`ctx.tools\`; otherwise keep the workflow tool-free.

5. Run \`dawn routes\` to confirm Dawn discovered the new route and what pathname it computed. Then \`dawn run '<pathname>'\` with the required state via stdin.

Constraints:
- Exactly one of default \`agent(...)\`, named \`workflow\`, named \`graph\`, or named \`chain\` may be exported from \`index.ts\`.
- Route groups in parentheses \`(public)\` are NOT part of the pathname.
- Dynamic segment values, such as \`topic\`, come from the JSON input when invoking the parameterized route id.
- The \`RouteTools<"/path">\` type is generated from the shared and route-local tools available to that route.

Reference: https://dawnai.org/llms.txt
`;

const WRITE_A_TEST = `Help me write tests for a Dawn route. Pick the right style for the route kind:

1. For an agent route like the default \`/research#agent\`, write a Vitest test with \`createAgentHarness\`, \`script()\` fixtures, and agent matchers:

   \`\`\`ts
   import { fileURLToPath } from "node:url"
   import { afterAll, it } from "vitest"
   import { createAgentHarness, expectFinalMessage, expectToolCalled, script } from "@dawn-ai/testing"

   const appRoot = fileURLToPath(new URL("..", import.meta.url))
   const h = await createAgentHarness({ appRoot, route: "/research#agent" })
   afterAll(async () => {
     await h.close()
   })

   it("searches the corpus and writes a cited answer", async () => {
     h.reset()
     const run = await h.run({
       input: "What are common agent architectures?",
       fixtures: script()
         .user("What are common agent architectures?")
         .callsTool("searchCorpus", { query: "agent architectures" })
         .callsTool("readDoc", { path: "corpus/agent-architectures.md" })
         .replies("ReAct and plan-and-execute are common. [corpus/agent-architectures.md]"),
     })

     expectToolCalled(run, "searchCorpus")
     expectToolCalled(run, "readDoc")
     expectFinalMessage(run).toContain("[corpus/")
   }, 60_000)
   \`\`\`

2. For deterministic \`workflow\`, \`graph\`, or \`chain\` routes, use a colocated \`run.test.ts\` scenario file:

   \`\`\`ts
   import { scenarios } from "@dawn-ai/sdk/testing"

   export default scenarios("/hello/[tenant]")
     .scenario("returns a greeting", (s) =>
       s
         .input({ tenant: "acme" })
         .expectPassed()
         .expectOutput({ tenant: "acme", greeting: "Hello, acme!" }),
     )
   \`\`\`

3. In the route-scoped builder, \`.input()\` sets the route state and \`.expectOutput()\` matches the returned state. Set \`.expectPassed()\` or \`.expectFailed()\` explicitly. Keep output expectations for deterministic route results, not LLM text exact matches.

4. For an in-process scenario, replace only the external or nondeterministic application tool and assert its calls. Tool names, inputs, and awaited outputs come from the generated route types:
   \`\`\`ts
   import { scenarios } from "@dawn-ai/sdk/testing"

   export default scenarios("/research").scenario("uses a controlled corpus result", (s) =>
     s
       .input({ messages: [{ role: "user", content: "Research Dawn" }] })
       .mockTool("searchCorpus", async ({ query }) => [
         { path: "corpus/dawn.md", score: 1, snippet: query },
       ])
       .expectPassed()
       .expectTool("searchCorpus", (call) =>
         call.calledOnce().withArgs({ query: "Dawn" }),
       ),
   )
   \`\`\`

5. To exercise the live Dawn HTTP boundary instead, use a separate server-backed scenario. Server-backed scenarios cannot use tool mocks:
   \`\`\`ts
   import { scenarios } from "@dawn-ai/sdk/testing"

   export default scenarios("/hello/[tenant]").scenario(
     "returns a greeting via the dev server",
     (s) =>
       s
         .input({ tenant: "acme" })
         .server("http://127.0.0.1:3001")
         .expectPassed()
         .expectOutput({ tenant: "acme", greeting: "Hello, acme!" }),
   )
   \`\`\`
   There is no command-level \`--url\` flag on \`dawn test\`.

6. Run agent Vitest files with the package's test runner (for the scaffold, \`npm test\`). Run route scenario suites with:
   \`\`\`
   dawn test
   \`\`\`

Constraints:
- Agent tests should use fixtures or live mode; do not exact-match raw assistant message arrays with \`.expectOutput()\`.
- \`run.test.ts\` must live in the deterministic route's directory, default-export \`scenarios("/route").scenario(...)\`, and avoid \`describe()\` / \`test()\` wrappers.
- In-process scenarios can replace selected application tools with \`.mockTool()\` and assert calls with \`.expectTool()\`; server-backed scenarios cannot use tool mocks.

Reference: https://dawnai.org/llms.txt
`;

const DEPLOY = `Help me choose and deploy the right Dawn build target. Dawn can emit a self-hosted Node server, an opt-in edge app, generated LangGraph entries, or any combination named in \`build.targets\`.

1. Verify the app before deployment:
   \`\`\`
   dawn verify
   dawn test
   \`\`\`
   \`dawn verify\` covers the app contract, route discovery, typegen, dependency/environment advisories, and runtime readiness. \`dawn test\` runs scenario tests. A configured \`hono\` target is capability-validated by both \`dawn check\` and \`dawn build\`.

2. Optionally catch Dawn HTTP protocol-shape issues before a Node or Hono deploy. Add \`.server("http://127.0.0.1:3001")\` to selected \`scenarios(...)\` builder chains, then run:
   \`\`\`
   dawn dev --port 3001 &
   dawn test
   \`\`\`
   This exercises the Agent Protocol thread lifecycle locally. LangSmith uses a distinct \`assistant_id\` request envelope, so test that platform boundary separately.

3. Make the target decision explicit in \`dawn.config.ts\`. Naming targets replaces the defaults, so include every artifact this app needs:

   **Dawn Node runtime — full self-hosted surface**
   \`\`\`ts
   import { config } from "@dawn-ai/cli"

   export default config({ build: { targets: ["node"] } })
   \`\`\`
   This emits \`.dawn/build/server.mjs\`, a static module manifest, and a hardened Node 24 Dockerfile. Serve the Dawn runtime directly with \`dawn start\` or build the emitted Dockerfile. Ensure \`@dawn-ai/cli\` is in \`dependencies\`, not \`devDependencies\`. Supply runtime secrets in the process/container environment: \`dawn start\` does not load the file named by \`config.env\`. The Node runtime serves Agent Protocol, AG-UI, middleware, and the configured sandbox. Its default local stores and in-process run/cancel registry require one replica unless thread-keyed stickiness or distributed coordination is guaranteed.

   **Hono edge app — compatible subset only**
   \`\`\`ts
   import { config } from "@dawn-ai/cli"

   export default config({ build: { targets: ["hono"] } })
   \`\`\`
   This emits \`app.mjs\`, \`modules.edge.mjs\`, a per-request Postgres store factory, and \`wrangler.toml\`. It serves Agent Protocol, AG-UI, and middleware, with Postgres-backed checkpoints, threads, and permissions. It cannot serve sandbox, filesystem/shell workspace capabilities, tool-output offloading, route skills, or typed long-term memory; custom store handles are rejected by the capability gate. \`memory.md\` and \`plan.md\` do not activate without a filesystem marker provider. Configure \`DATABASE_URL\` and the generated runtime dependencies, then deploy only after the capability validation passes. Run/cancel coordination remains isolate-local, so the same stickiness/distributed-coordination rule applies.

   **LangSmith entries — platform-owned transport**
   \`\`\`ts
   import { config } from "@dawn-ai/cli"

   export default config({ build: { targets: ["langsmith"] } })
   \`\`\`
   This emits \`.dawn/build/langgraph.json\` and per-route entries keyed by \`<routeId>#<kind>\`, such as \`/research#agent\`. These are generated graphs, not the Dawn HTTP server: Dawn middleware, AG-UI, and the sandbox manager are absent. The generated config currently sets \`node_version: "22"\`, while Dawn packages require Node >=24. Treat that as an unresolved compatibility mismatch and confirm the platform can run the required Node version before deployment.

4. Build the selected target only after verification and tests pass:
   \`\`\`
   dawn build --clean
   \`\`\`

5. Show me the exact files the build emitted, the command that starts or deploys them, the required runtime environment and storage, and one target-boundary smoke test. Refer to https://dawnai.org/docs/deployment for the full service and limitation matrix rather than reproducing it.

Reference: https://dawnai.org/llms.txt
`;

export const PROMPTS: readonly PromptEntry[] = [
	{
		slug: "scaffold",
		title: "Scaffold a new Dawn app",
		description: "Create a new Dawn project and walk through the structure.",
		body: SCAFFOLD,
	},
	{
		slug: "add-a-tool",
		title: "Add a tool",
		description: "Add a type-inferred tool to an existing route.",
		body: ADD_A_TOOL,
	},
	{
		slug: "write-a-route",
		title: "Write a route",
		description: "Create a new route with workflow/graph/chain.",
		body: WRITE_A_ROUTE,
	},
	{
		slug: "write-a-test",
		title: "Write a test",
		description: "Choose agent harness tests or deterministic route scenarios.",
		body: WRITE_A_TEST,
	},
	{
		slug: "deploy",
		title: "Choose a deployment target",
		description: "Build for the Dawn Node runtime, a compatible edge app, or LangSmith.",
		body: DEPLOY,
	},
];

export function getPrompt(slug: PromptSlug): PromptEntry {
	const entry = PROMPTS.find((p) => p.slug === slug);
	if (!entry) {
		throw new Error(`Unknown prompt slug: ${slug}`);
	}
	return entry;
}
