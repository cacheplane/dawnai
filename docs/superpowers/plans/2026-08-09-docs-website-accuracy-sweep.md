# Dawn Website Accuracy Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the Dawn website's broken examples and false or unsafe claims without changing its navigation or expanding it into the application-developer journey rebuild.

**Architecture:** Treat current implementation, tests, public types, and the generated research scaffold as the source of truth. Add a narrow drift guard first, then repair seven non-overlapping content groups with the minimum local edits needed for accuracy. Keep the implementation docs-only except for `scripts/check-docs.mjs`, and finish with the complete repository validation lane.

**Tech Stack:** Next.js App Router, React, TypeScript, MDX, Node.js 24, pnpm, repository documentation checks.

---

## File map

The implementation is intentionally grouped so tasks do not edit the same files.

| Responsibility | Files |
|---|---|
| Accuracy drift guard | `scripts/check-docs.mjs` |
| Route and streaming examples | `apps/web/content/docs/recipes/{typed-state,stream-output,dispatch-from-route,retry-flaky-tools,index}.mdx`, `apps/web/content/docs/{routes,agents,retry}.mdx` |
| Onboarding, tests, evals, migration | `apps/web/content/docs/{getting-started,mental-model,testing-agents,evals,migrating-from-langgraph,upgrading}.mdx` |
| Tool and prompt security | `apps/web/content/docs/{tools,subagents,access-control,permissions,workspace}.mdx` |
| Memory and public contracts | `apps/web/content/docs/{memory,configuration,api}.mdx` |
| Runtime and deployment truth | `apps/web/content/docs/{state,middleware,ag-ui,dev-server,deployment,sandbox}.mdx`, `apps/web/content/docs/recipes/auth-middleware.mdx` |
| Human and machine discovery | `apps/web/app/components/landing/Quickstart.tsx`, `apps/web/content/prompts/index.ts`, `apps/web/app/{llms.txt,llms-full.txt}/route.ts`, `apps/web/content/blueprints/deploy/docker.md`, `apps/web/content/blueprints/observability/opentelemetry.md` |

No navigation file, page wrapper, historical blog post, package implementation,
example README, or publishable package source is changed in this pull request.

## Closed claim ledger

Only the following claims may drive content edits. A newly discovered topic is
recorded for PR 2 unless it makes one of these corrections unsafe.

| ID | Page/source | False claim or broken example | Implementation/test authority | Minimal replacement | Verification |
|---|---|---|---|---|---|
| A01 | `recipes/typed-state.mdx` | Dynamic URL segments are injected and must be omitted from the state schema. | `packages/core/src/typegen/render-route-types.ts`; `packages/cli/test/run-command.test.ts`; `state.mdx` | Put `tenant` in Zod state and in JSON input; say the route id remains parameterized. | `node scripts/check-docs.mjs` requires `tenant: z.string()` and rejects the injection sentence. |
| A02 | `recipes/stream-output.mdx` | The research agent accepts `{ query }`, and `chunk` is `{ content }`. | `packages/cli/src/lib/runtime/stream-types.ts`; `packages/cli/test/stream-types.test.ts` | Send `messages`; parse `chunk` as the raw JSON string; ignore `: ping` comments. | Guard rejects `payload.content`/research `{ query }`; compare example event table with `stream-types.test.ts`. |
| A03 | `recipes/dispatch-from-route.mdx` | `task()` looks like authored TypeScript; cross-service agent input/output are `{ query }` and `{ output }`. | `packages/core/src/subagents`; `packages/cli/src/lib/dev/runtime-fetch-core.ts`; default research route state | Label `task` as a model-emitted internal call; send `messages`; read final message state. | Guard rejects the stale request/output fragments. |
| A04 | Retry recipe, `retry.mdx`, `routes.mdx`, `agents.mdx` | Route retry is presented as tool retry; streaming `baseDelay` is promised although the streaming loop uses 1s; disconnect behavior is transport-agnostic. | `packages/langchain/src/agent-adapter.ts`; `packages/langchain/src/retry.ts`; `packages/cli/src/lib/dev/runtime-fetch-core.ts`; `packages/cli/src/lib/dev/agui-handler.ts` | Teach transient model/agent retry; say tool retry belongs inside the tool; disclose streaming 1s base; distinguish AP, AG-UI, explicit cancel, and shutdown. | `node scripts/check-docs.mjs`; targeted `rg` confirms no “tool-level retry” or client-disconnect blanket claim remains. |
| A05 | `getting-started.mdx` | The installed research scaffold tree, coordinator, memory config, and test count are from an older template. | `packages/devkit/templates/app-research/**` | Mirror shared tools, `memory.md`, `memory.ts`, recall/remember, candidate writes, eval, and sandbox test; describe behaviors instead of a fixed test count. | Compare every shown path/snippet with the template; guard requires shared tools and memory definition. |
| A06 | `mental-model.mdx` | Tools appear route-local only; `AGENTS.md` is the only undifferentiated “memory”; middleware/runtime ownership is local/LangSmith-only. | tool discovery; built-in memory markers; Node/Hono targets | Mention shared and route-local tools, distinguish prompt/typed/episodic memory, and include built Dawn runtimes. | Web MDX build and focused source comparison. |
| A07 | `testing-agents.mdx` | A reset thread is “multi-turn”; tests “never” use live models; cleanup need not be awaited; scaffold has four tests; process-global aimock constraint is absent. | `packages/testing/src/harness.ts`; `examples/chat/server/test/capabilities.e2e.test.ts`; current scaffold tests | Show same-thread follow-up without reset, separate isolation example, distinguish replay CI from gated live smoke, await `close()`, and describe current scaffold behaviors without a count. | Web build; snippet imports/types checked by inspection against harness signatures. |
| A08 | `evals.mdx` | `--record` captures scorer model calls; programmatic example uses an undeclared harness and passes `unknown` input; built-in scorer list is exhaustive but omits memory scorers. | `packages/cli/src/commands/eval.ts`; `packages/evals/src/run-eval.ts`; `packages/evals/src/index.ts`; `packages/testing/src/harness.ts` | Say recording covers agent-run calls only; create/close a harness and type-guard input; add the shipped memory scorers to the existing inventory. | Web build; compare exports and `runCase` signature; guard rejects “including scorer model calls.” |
| A09 | `migrating-from-langgraph.mdx` | Example replaces working nodes with no-ops yet calls behavior identical; graph routes are said to receive `ctx.tools`; `.dawn` is under `src`; dynamic segments are injected. | `packages/langgraph` route contracts; `routes.mdx`; route typegen | Preserve imported graph behavior, reserve `RuntimeContext` for workflow, put `.dawn/` at root, and make route input explicit. | Web build and source contract comparison. |
| A10 | `upgrading.mdx` | Uses the wrong create package, four-check verify description, and omits the Node 24 and `/node` import migrations. | package `engines`; `packages/cli/src/commands/verify.ts`; `packages/core/src/node.ts`; `packages/permissions` and `packages/workspace` exports | Correct package/verify facts and add concise migration callouts for Node 24+ and explicit Node subpaths. | Guard requires Node 24 wording; compare command and export registries. |
| A11 | `tools.mdx`, `subagents.mdx` | A subagent sees only its route-local authored tools, implying shared sensitive tools are withheld. | `packages/cli/src/lib/runtime/tool-discovery.ts`; `packages/core/src/tool-scope.ts`; `packages/core/test/tool-scope.test.ts` | Add a compact shared/route/capability matrix and show explicit deny for a shared sensitive tool. | Guard rejects “only its own route-local”; run `pnpm --filter @dawn-ai/core test -- tool-scope.test.ts`. |
| A12 | `access-control.mdx` | Workspace `runBash` is placed in both allow and approve, causing double prompts; control model omits delegation. | `packages/cli/src/lib/runtime/execute-route-core.ts`; `dawn check` validation; `packages/core/src/subagents/policy.ts` | Use command-prefix permissions for `runBash`, an authored tool for name-level approval, and list delegation as a separate gate. | Guard rejects the double-policy example; web build. |
| A13 | `permissions.mdx`, `configuration.mdx` | Permission values are “glob-style”; config entries are seeded to `.dawn/permissions.json`; every `always` write uses that file. | `packages/permissions/src/pattern-matching.ts`; `packages/permissions/src/node.ts`; `packages/postgres-storage/src/permissions.ts` | State prefix vs exact reserved keys, static vs runtime decisions, and “configured permissions store; default file …”. | Guard rejects `glob-style` and `seeded`; run `pnpm --filter @dawn-ai/permissions test`. |
| A14 | `workspace.mdx`, `memory.mdx` | Writable `workspace/AGENTS.md` is described without its shared persistent-prompt trust boundary. | `packages/core/src/capabilities/built-in/agents-md.ts`; workspace write gates | Warn that every consuming `agent()` route/subagent can receive persisted instructions; recommend trust/tenant isolation and constrained writes. | Required warning fragments in docs guard. |
| A15 | `memory.mdx` | Reflection is called deferred; model-facing `remember.content` is optional; one ID formula covers all kinds. | `packages/core/src/capabilities/built-in/memory.ts`; `packages/memory/src/reconcile.ts` | Mark reflection shipped and procedural deferred; require content in agent calls; separate semantic IDs from timestamp-salted episodic/reflection IDs. | Guard rejects the stale reflection/content phrases; relevant core/memory tests. |
| A16 | `memory.mdx` | SQLite and HNSW pgvector recall ordering is identical. | `packages/memory/src/sqlite-store.ts`; `packages/memory-pgvector/src/pgvector-store.ts`; memory conformance tests | Promise shared fusion/scoring semantics, not identical candidate sets or order; name exact versus approximate retrieval. | Guard rejects “Recall ranking is identical to SQLite.” |
| A17 | `configuration.mdx` | The “key reference” omits current memory fields and says env loading is local/LangSmith-only. | `packages/core/src/types.ts`; `packages/cli/src/commands/{start,inspect}.ts`; runtime config loading | Add `enabled` (inert), `vector`, `episodes`, and `distill` compactly; include `start`/`inspect`; link rather than duplicate operations guidance. | Compare `DawnConfig.memory`; web build. |
| A18 | `api.mdx` | `RuntimeContext` is injected into tools; all client disconnects abort both context signals; pgvector method inventory is exhaustive but stale. | `packages/sdk/src/runtime-context.ts`; `packages/sdk/src/workspace-fs.ts`; transport handlers; `packages/memory/src/types.ts` | Separate route `RuntimeContext` and tool `DawnToolContext`, describe abort by transport, and update only the existing exhaustive store-method list. | Web build; compare public types/exports. |
| A19 | `sandbox.mdx` | Docker and Kubernetes share identical enforcement; Kubernetes deny mode is “zero egress”; Node 22 examples; HPA is safe without topology prerequisites. | Docker/Kubernetes sandbox implementations; charts; process-local run registry | Add provider matrix, DNS/CNI caveat, Node 24 images, and remove or strongly gate HPA behind shared stores plus routing/serialization. | Guard requires cluster DNS/CNI language; web build. |
| A20 | `deployment.mdx` | Node output is multi-stage Node 22; verify has four checks; LangSmith omits tool scope/permissions/capabilities; only Node is production runtime; generated Dockerfile never overwrites. | Node/LangSmith/Hono target emitters; route materialization; verify command | Correct Node 24 single-stage marker behavior and five checks; add precise target matrix; retain sandbox/HTTP/middleware differences. | Guard requires Node 24 and LangSmith policy wording; web build. |
| A21 | `deployment.mdx`, `state.mdx` | Hono support says nothing else is gated although `memory.md`/`plan.md` deactivate without MarkerFs; runtime request parity collapses Dawn HTTP and LangSmith envelopes. | edge capability gate/module emitter; built-in marker capabilities; runtime handlers | Narrow edge claims and identify marker limitations; distinguish Dawn Node/Hono `{ route, input }` from LangSmith `assistant_id`. | Guard rejects “Nothing else is gated”; web build. |
| A22 | `middleware.mdx`, auth recipe | Middleware is local-only. | Node/Hono module emitters; runtime fetch core; LangSmith target | State dev/Node/Hono support and LangSmith generated-entry exception. | Guard rejects local-only wording; web build. |
| A23 | `ag-ui.mdx`, `dev-server.mdx` | AG-UI disconnect can continue; endpoint count is stale; memory candidate endpoints and heartbeats are absent from an exhaustive runtime description; single-replica warning is tied only to local storage. | AG-UI handler; `runtime-fetch-core.ts`; cancellation/heartbeat tests | Correct disconnect split, avoid a fixed count, list candidate routes and `: ping` comments, and make process-local gate/cancel limitation independent of storage. | Updated endpoint guard reads `runtime-fetch-core.ts`; run CLI cancellation tests. |
| A24 | Landing `Quickstart.tsx` | Scaffolding starts a server and creates a support route; porting a graph is the canonical third step. | current create-app research template | Use scaffold → offline tests/eval → opt into live/dev/deploy or adapt a route. | Web lint/typecheck and component text guard. |
| A25 | `content/prompts/index.ts` | Tool prompts teach only route-local tools; deploy prompt says no production runtime, LangSmith-only, Node 22. | tool discovery; build target emitters; CLI command registry | Teach both tool locations; make deploy prompt choose Node/Hono/LangSmith with target-specific contracts and `dawn start`. | Guard requires `dawn start` and rejects no-runtime claim. |
| A26 | `llms.txt` route | Omits `start`, `inspect`, cancel/memory endpoints and teaches LangSmith-only deployment/shared-tool-incomplete shape. | CLI registry; runtime route table; build targets; scaffold | Add the missing current commands/endpoints, shared tools, and concise target matrix. | Guard requires command and endpoint fragments. |
| A27 | Served Docker/OTel blueprints | Docker blueprint is entirely the old LangGraph CLI path and says Dawn has no server/defaults to LangSmith; OTel calls LangSmith the deploy target. | Node target Dockerfile/server emitter; build config | Rewrite Docker blueprint around `build.targets: ["node"]`, generated `server.mjs`/Dockerfile, and marker behavior; remove single-default wording from both. | Guard rejects the three stale claims and requires generated server path. |
| A28 | `llms-full.txt` route | Historical blog bodies are concatenated under “Full Reference” without a non-normative boundary. | blog post index and approved design | Label the Blog section historical and non-normative; do not rewrite posts. | Guard requires the historical label; web route build. |

### Task 1: Add a failing guard for high-risk website contracts

**Files:**
- Modify: `scripts/check-docs.mjs`
- Test: `scripts/check-docs.mjs` through `node scripts/check-docs.mjs`

- [ ] **Step 1: Add file-specific accuracy contracts**

Add these helpers after the existing `checks` loop:

```js
const accuracyContracts = [
  {
    file: "apps/web/content/docs/recipes/typed-state.mdx",
    required: ["tenant: z.string()"],
    forbidden: ["[tenant] is injected from the pathname"],
  },
  {
    file: "apps/web/content/docs/recipes/stream-output.mdx",
    required: ['input: { messages: [{ role: "user"', 'typeof payload === "string"'],
    forbidden: ["payload.content"],
  },
  {
    file: "apps/web/content/docs/tools.mdx",
    required: ["src/tools/", "capability tools"],
    forbidden: ["only its own route-local `tools/*.ts`"],
  },
  {
    file: "apps/web/content/docs/deployment.mdx",
    required: ["node:24-slim", 'node_version: "22"'],
    forbidden: ["Nothing else is gated"],
  },
  {
    file: "apps/web/content/prompts/index.ts",
    required: ["dawn start", 'targets: ["node"]'],
    forbidden: ["Dawn itself is not a production runtime"],
  },
  {
    file: "apps/web/app/llms.txt/route.ts",
    required: ["dawn start", "dawn inspect", "/threads/:thread_id/cancel"],
    forbidden: ["Production runs on LangSmith or another runtime"],
  },
  {
    file: "apps/web/content/blueprints/deploy/docker.md",
    required: [".dawn/build/server.mjs", "node:24-slim"],
    forbidden: ["Dawn has no standalone server", "Dawn's default deploy target"],
  },
  {
    file: "apps/web/app/llms-full.txt/route.ts",
    required: ["historical", "non-normative"],
    forbidden: [],
  },
]

for (const contract of accuracyContracts) {
  const source = readFileSync(resolve(repoRoot, contract.file), "utf8")
  for (const required of contract.required) {
    if (!source.includes(required)) {
      failures.push(`${contract.file} is missing accuracy contract text: ${required}`)
    }
  }
  for (const forbidden of contract.forbidden) {
    if (source.includes(forbidden)) {
      failures.push(`${contract.file} retains stale accuracy text: ${forbidden}`)
    }
  }
}
```

- [ ] **Step 2: Point endpoint coverage at the real route table**

Replace the `runtime-server.ts`-only endpoint probe with a read of
`packages/cli/src/lib/dev/runtime-fetch-core.ts`. Keep the AG-UI checks, then add:

```js
const runtimeEndpointContracts = [
  ["POST /threads/:thread_id/cancel", "POST /threads/:thread_id/cancel"],
  ["GET /memory/candidates", "GET /memory/candidates"],
  ["POST /memory/candidates/:id/approve", "POST /memory/candidates/:id/approve"],
  ["POST /memory/candidates/:id/reject", "POST /memory/candidates/:id/reject"],
]

for (const [sourceText, docsText] of runtimeEndpointContracts) {
  if (runtimeFetchCoreSource.includes(sourceText) && !devServerDocs.includes(docsText)) {
    failures.push(`apps/web/content/docs/dev-server.mdx is missing runtime endpoint: ${docsText}`)
  }
}
```

- [ ] **Step 3: Build before running the dist-backed checker**

Run:

```bash
source /Users/blove/.nvm/nvm.sh
nvm use 24
pnpm build
```

Expected: PASS and fresh `dist/` output for every package.

- [ ] **Step 4: Verify the guard is red on stale website content**

Run:

```bash
node scripts/check-docs.mjs
```

Expected: FAIL only for the newly guarded accuracy contracts and missing memory
candidate endpoint text. Existing baseline checks remain healthy.

- [ ] **Step 5: Commit the red guard**

```bash
git add scripts/check-docs.mjs
git commit -m "test(docs): guard high-risk website contracts"
```

### Task 2: Repair route, dispatch, stream, and retry examples

**Files:**
- Modify: `apps/web/content/docs/recipes/typed-state.mdx`
- Modify: `apps/web/content/docs/recipes/stream-output.mdx`
- Modify: `apps/web/content/docs/recipes/dispatch-from-route.mdx`
- Modify: `apps/web/content/docs/recipes/retry-flaky-tools.mdx`
- Modify: `apps/web/content/docs/recipes/index.mdx`
- Modify: `apps/web/content/docs/routes.mdx`
- Modify: `apps/web/content/docs/agents.mdx`
- Modify: `apps/web/content/docs/retry.mdx`

- [ ] **Step 1: Make typed state input-driven**

Add `tenant: z.string()` to the schema, infer `HelloState` directly from the
schema, remove the path-injection comments, and show both invocations:

```bash
echo '{"tenant":"acme"}' | dawn run '/hello/[tenant]'
```

```json
{ "route": "/hello/[tenant]#workflow", "input": { "tenant": "acme" } }
```

State plainly that a concrete `/hello/acme` pathname is not how Dawn populates
route state.

- [ ] **Step 2: Repair the streaming client**

Change the research input to:

```ts
input: {
  messages: [{ role: "user", content: "latest LLM benchmarks" }],
},
```

Keep the frame loop, but ignore SSE comments before locating fields and consume
the raw string payload:

```ts
if (frame.startsWith(":")) continue // `: ping` keepalive comment
const eventLine = lines.find((line) => line.startsWith("event: "))
const dataLine = lines.find((line) => line.startsWith("data: "))
if (!eventLine || !dataLine) continue

const eventType = eventLine.slice("event: ".length)
const payload: unknown = JSON.parse(dataLine.slice("data: ".length))

if (eventType === "chunk" && typeof payload === "string") {
  process.stdout.write(payload)
  continue
}
```

Change the event table's `chunk` shape to `string` and state that `: ping`
comments carry no event/data payload.

- [ ] **Step 3: Make dispatch semantics explicit**

Label the `task({ subagent, input })` block as the internal tool call the model
emits, not a function authored route code imports or calls. In the HTTP example,
send the research `messages` envelope and read the final assistant message from
the returned state:

```ts
const result = (await res.json()) as {
  readonly messages?: readonly { readonly content?: unknown }[]
}
const content = result.messages?.at(-1)?.content
return {
  ...state,
  summary: typeof content === "string" ? content : JSON.stringify(content ?? ""),
}
```

- [ ] **Step 4: Reframe retry around model calls**

Keep the existing recipe URL, but title it “Retry transient model calls.” Remove
the flaky `fetch-doc` tool and say route retry applies to transient provider/
model execution before any stream event is emitted. Add a small tool-local
example that catches/retries its own `fetch` if an application needs tool retry.

In `retry.mdx`, distinguish the paths:

- the non-stream fallback honors configured `baseDelay`;
- the current streaming path starts at 1 second regardless of configured
  `baseDelay`;
- AP viewer disconnect does not abort the run;
- AG-UI disconnect, explicit AP cancel, and server shutdown do abort;
- tools/providers must cooperate with the propagated signal.

Update related-card labels and remove “agent / tool level” language.

- [ ] **Step 5: Run focused verification**

```bash
node scripts/check-docs.mjs
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
git diff --check
```

Expected: web lint/typecheck and diff check PASS. The docs checker remains red
only for accuracy contracts owned by later tasks.

- [ ] **Step 6: Commit the corrected examples**

```bash
git add apps/web/content/docs/recipes apps/web/content/docs/routes.mdx apps/web/content/docs/agents.mdx apps/web/content/docs/retry.mdx
git commit -m "docs: correct route and streaming examples"
```

### Task 3: Align onboarding, testing, evals, and migration guidance

**Files:**
- Modify: `apps/web/content/docs/getting-started.mdx`
- Modify: `apps/web/content/docs/mental-model.mdx`
- Modify: `apps/web/content/docs/testing-agents.mdx`
- Modify: `apps/web/content/docs/evals.mdx`
- Modify: `apps/web/content/docs/migrating-from-langgraph.mdx`
- Modify: `apps/web/content/docs/upgrading.mdx`

- [ ] **Step 1: Sync Getting Started to the generated research app**

Use `packages/devkit/templates/app-research` as the literal source for the tree.
Show shared `src/tools/readDoc.ts` and `src/tools/searchCorpus.ts`, route
`memory.md`/`memory.ts`, the eval, the main test file, and the optional Docker
sandbox test. Update the coordinator/config excerpts to include `recall`,
`remember`, and `memory.writes: "candidate"`. Replace a fixed test count with a
behavior list so new scaffold tests do not stale the page again.

- [ ] **Step 2: Correct the mental model**

Name both tool discovery locations. Replace the single “AGENTS.md provides
memory” sentence with a three-part distinction:

- `workspace/AGENTS.md`: persistent prompt guidance shared by consuming agents;
- route `memory.ts`: typed cross-session long-term memory;
- episodic records: retained run history used by recall/distillation.

State that middleware runs in dev and built Dawn HTTP runtimes, and replace the
LangSmith-only ownership table with qualified Node, Hono, and LangSmith roles.

- [ ] **Step 3: Fix testing lifecycle examples**

Change the opening to “CI tests replay fixtures; optional gated local smoke tests
may use a live model.” Await cleanup everywhere:

```ts
afterAll(async () => {
  await h.close()
})
```

Show two `h.run()` calls without `h.reset()` for a same-thread conversation;
move `h.reset()` into a separate “fresh thread/test isolation” example. Add a
warning that one harness may be alive per process because aimock endpoint/env
and materialized-model state are process-global; use sequential suites or
subprocess isolation. Describe the current scaffold's seven behaviors without
promising a count.

- [ ] **Step 4: Correct eval recording and programmatic execution**

Replace “including scorer model calls” with an explicit limitation: `--record`
writes fixtures for the agent-run requests; a scorer such as `llmJudge` needs a
separate committed/mocked fixture. Add the existing memory scorers to the
exhaustive list: `memoryRecalled`, `memoryFresh`, and `memoryIsolated`.

Make the programmatic example self-contained:

```ts
const harness = await createAgentHarness({ appRoot, route: "/chat#agent" })
try {
  const report = await runEval(myEval, {
    runCase: async (testCase) => {
      if (typeof testCase.input !== "string") {
        throw new TypeError("This agent harness expects a string case input")
      }
      return harness.run({ input: testCase.input, fixtures: testCase.fixtures })
    },
    baseDir: fileURLToPath(new URL(".", import.meta.url)),
  })
  console.log(report.passed, report.mean)
} finally {
  await harness.close()
}
```

Include the missing `createAgentHarness` import and define `appRoot`.

- [ ] **Step 5: Repair the LangGraph migration example**

Keep the user's real graph nodes/edges in the Dawn `graph` export instead of
replacing them with identity functions. Put `.dawn/` at project root. Remove
`ctx.tools` from graph-route prose and say only a `workflow(state, ctx)` entry
receives `RuntimeContext`; existing graphs keep using their own imported tools.
Put dynamic-segment values in request state.

- [ ] **Step 6: Add the missing upgrade facts**

Use `create-dawn-ai-app`, describe all five verify phases (app, routes, typegen,
dependencies, runtime readiness), add Node 24+, and show Node-only imports moving
to explicit `/node` entry points without expanding into a full release history.

- [ ] **Step 7: Verify and commit**

```bash
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
git diff --check
git add apps/web/content/docs/getting-started.mdx apps/web/content/docs/mental-model.mdx apps/web/content/docs/testing-agents.mdx apps/web/content/docs/evals.mdx apps/web/content/docs/migrating-from-langgraph.mdx apps/web/content/docs/upgrading.mdx
git commit -m "docs: align onboarding and testing guidance"
```

Expected: all focused checks PASS.

### Task 4: Correct tool inheritance, approvals, and prompt trust boundaries

**Files:**
- Modify: `apps/web/content/docs/tools.mdx`
- Modify: `apps/web/content/docs/subagents.mdx`
- Modify: `apps/web/content/docs/access-control.mdx`
- Modify: `apps/web/content/docs/permissions.mdx`
- Modify: `apps/web/content/docs/workspace.mdx`

- [ ] **Step 1: Document actual subagent tool inheritance**

Add this compact matrix to Tools and summarize/link it from Subagents:

| Tool origin | Top-level agent | Subagent default |
|---|---|---|
| Shared authored `src/tools/*` | Available | Available |
| That route's local `tools/*` | Available | Available to that route only |
| Parent route's local tools | N/A | Not inherited |
| Capability tools | Available when capability is active | Withheld unless explicitly allowed |

Show a child policy with `deny: ["deployProd"]` for a sensitive shared authored
tool. Keep the internal `task` mechanism outside tool policy.

- [ ] **Step 2: Remove the double-prompt access-control recipe**

Remove `approve: ["runBash"]`. Use `permissions.allow.bash`/
`permissions.deny.bash` for command-prefix decisions, and demonstrate
`tools.approve` with a separate authored tool such as `deployProd`. Add guarded
delegation as the fourth decision plane before a child sees sensitive input.
Update sandbox images in the example to `node:24-slim`.

- [ ] **Step 3: Correct permission matching and storage wording**

Use the precise contract everywhere:

> Bash, path, and memory entries are prefix patterns. The reserved `tool` and
> `subagent` entries match exactly. Static config entries stay in configuration;
> they are not copied into the runtime store. Only an `always` decision adds an
> allow entry to the configured permissions store (the default Node store is
> `.dawn/permissions.json`); `once` and `deny` are not persisted.

Retain the different suggested-pattern granularity for bash, path, memory, tool,
and subagent gates.

- [ ] **Step 4: Add the `workspace/AGENTS.md` trust boundary**

Warn that the file is re-read into prompt context for every consuming Dawn
`agent()` route and subagent. A route with `writeFile` can persist instructions
for later requests. Recommend separate workspaces for different tenants/trust
zones, constrained/denied writes for untrusted agents, review of seeded content,
and never copying raw untrusted text into the file.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @dawn-ai/core test -- tool-scope.test.ts
pnpm --filter @dawn-ai/permissions test
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
git diff --check
git add apps/web/content/docs/tools.mdx apps/web/content/docs/subagents.mdx apps/web/content/docs/access-control.mdx apps/web/content/docs/permissions.mdx apps/web/content/docs/workspace.mdx
git commit -m "docs: correct capability security contracts"
```

Expected: tests and web checks PASS.

### Task 5: Reconcile memory, configuration, and API contracts

**Files:**
- Modify: `apps/web/content/docs/memory.mdx`
- Modify: `apps/web/content/docs/configuration.mdx`
- Modify: `apps/web/content/docs/api.mdx`

- [ ] **Step 1: Correct memory-kind and write contracts**

Say semantic, episodic, and reflection are wired; procedural remains deferred.
Document `content` as required in the model-facing `remember` schema. Split IDs:

- semantic: `sha1(namespace | JSON(data))` prefix;
- episodic/reflection: the same data basis plus the request timestamp so repeated
  events append instead of collapsing.

Keep the existing operational sections; do not split or reorder the page.

- [ ] **Step 2: Narrow retrieval guarantees**

Replace the “identical to SQLite” callout with:

> Both stores use Dawn's fusion and final scoring rules. SQLite scans vectors
> exactly; pgvector's HNSW search is approximate and can supply a different
> candidate set, so arbitrary queries are not guaranteed to return identical
> rows or ordering.

Add the `workspace/AGENTS.md` trust warning from A14 next to its current write
instructions, without creating a second security guide.

- [ ] **Step 3: Complete only the existing configuration contract**

Add concise rows for `memory.enabled` (historical/inert), `memory.vector`,
`memory.episodes`, and `memory.distill`, with links into existing Memory anchors.
Include `dawn start` and `dawn inspect` in env-loading scope and stop describing
production env solely through `langgraph.json`. Preserve the single-replica
warning for the process-local run gate even when Postgres stores are configured.
In the existing permissions section, replace “glob-style” with the prefix/exact
matching contract from A13, remove the claim that static allow entries are
seeded into `.dawn/permissions.json`, and point runtime `always` decisions at the
configured permissions store (whose default Node implementation uses that
file).

- [ ] **Step 4: Fix context and method references in API**

Describe `RuntimeContext` as the route-entry context and `DawnToolContext` as the
tool-function context. State signal behavior by transport rather than “client
disconnect” globally. Extend the existing `MemoryStore`/pgvector method inventory
with `browse`, `stats`, and `prune`; do not add unrelated new export tables.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @dawn-ai/core test
pnpm --filter @dawn-ai/memory test
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
git diff --check
git add apps/web/content/docs/memory.mdx apps/web/content/docs/configuration.mdx apps/web/content/docs/api.mdx
git commit -m "docs: reconcile memory and API contracts"
```

Expected: tests and web checks PASS.

### Task 6: Correct runtime, middleware, sandbox, and deployment guidance

**Files:**
- Modify: `apps/web/content/docs/state.mdx`
- Modify: `apps/web/content/docs/middleware.mdx`
- Modify: `apps/web/content/docs/recipes/auth-middleware.mdx`
- Modify: `apps/web/content/docs/ag-ui.mdx`
- Modify: `apps/web/content/docs/dev-server.mdx`
- Modify: `apps/web/content/docs/deployment.mdx`
- Modify: `apps/web/content/docs/sandbox.mdx`

- [ ] **Step 1: Correct middleware and transport behavior**

State that middleware runs under `dawn dev`, the Node runtime used by
`dawn start`, and Hono builds; generated LangSmith graph entries do not include
Dawn HTTP middleware. Correct the auth recipe's related text. State that AG-UI
disconnect aborts its ephemeral run, while Agent Protocol disconnect does not.

- [ ] **Step 2: Make the runtime endpoint description exhaustive again**

Remove the fixed endpoint count. Add the three public memory-candidate routes:

```text
GET  /memory/candidates
POST /memory/candidates/:id/approve
POST /memory/candidates/:id/reject
```

Document `: ping\n\n` as a 15-second SSE comment on long-running AP stream and
resume responses, which clients must ignore. Qualify `{ route, input }` request
parity to Dawn's Node/Hono runtimes; LangSmith uses its own `assistant_id`
envelope. Make the one-run gate and cancel registry single-replica limitation
explicit even with shared Postgres storage.

- [ ] **Step 3: Add provider-specific sandbox truth**

Change examples to `node:24-slim`. Add a small Docker/Kubernetes enforcement
matrix. Docker deny uses `--network none`; Kubernetes deny permits cluster DNS,
depends on a NetworkPolicy-enforcing CNI, and does not prevent DNS tunneling.
Explain that `pidsLimit` and network enforcement differ by provider. Remove the
unqualified HPA example or gate it behind all shared stores plus sticky routing
or distributed per-thread serialization/cancel routing.

- [ ] **Step 4: Correct the deployment target comparison**

Lead the existing page with this factual split, without creating a new page:

| Target | What runs | Included | Important exclusions/limits |
|---|---|---|---|
| Node | Dawn HTTP runtime (`server.mjs`) | AP, AG-UI, middleware, policies, capabilities, sandbox | Process-local run/cancel coordination; Node 24+ |
| Hono | Dawn fetch runtime | AP, AG-UI, middleware, supported policies/capabilities | No sandbox/filesystem capabilities; marker-backed `memory.md`/`plan.md` deactivate without `MarkerFs` |
| LangSmith | Generated policy-aware LangGraph entries | Tool scope, capabilities, permission gates in graph materialization | No Dawn HTTP middleware, AG-UI server, or sandbox manager; generated config currently says Node 22 despite Dawn packages requiring 24+ |

Correct the Node artifact prose to one-stage `node:24-slim`, five verify phases,
and marker-aware Dockerfile replacement. Remove “Nothing else is gated.” State
that Postgres persistence does not distribute run/cancel coordination.

- [ ] **Step 5: Correct state boundary wording**

List `dawn run`, `dawn dev`, Node, and Hono as Dawn state boundaries using the
Dawn request envelope. Keep LangSmith separate and avoid saying the same HTTP
request body crosses both products.

- [ ] **Step 6: Run focused runtime verification**

```bash
pnpm --filter @dawn-ai/cli test -- run-cancellation.test.ts
pnpm --filter @dawn-ai/cli test -- hono-target.test.ts
pnpm --filter @dawn-ai/sandbox test
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
git diff --check
```

Expected: targeted runtime tests and web checks PASS.

- [ ] **Step 7: Commit runtime/deployment corrections**

```bash
git add apps/web/content/docs/state.mdx apps/web/content/docs/middleware.mdx apps/web/content/docs/recipes/auth-middleware.mdx apps/web/content/docs/ag-ui.mdx apps/web/content/docs/dev-server.mdx apps/web/content/docs/deployment.mdx apps/web/content/docs/sandbox.mdx
git commit -m "docs: correct runtime and deployment guidance"
```

### Task 7: Update human and machine discovery surfaces

**Files:**
- Modify: `apps/web/app/components/landing/Quickstart.tsx`
- Modify: `apps/web/content/prompts/index.ts`
- Modify: `apps/web/app/llms.txt/route.ts`
- Modify: `apps/web/app/llms-full.txt/route.ts`
- Modify: `apps/web/content/blueprints/deploy/docker.md`
- Modify: `apps/web/content/blueprints/observability/opentelemetry.md`

- [ ] **Step 1: Correct the landing quickstart**

Use the three current steps:

1. Scaffold the research app.
2. Run its offline agent tests and eval.
3. Opt into live/dev operation, adapt a route, or build a deployment target.

Do not say the scaffold starts a server or creates a support route.

- [ ] **Step 2: Refresh task-specific prompts**

In scaffold/tool/route prompts, distinguish shared `src/tools/*` from
route-local `<route>/tools/*`, and await harness cleanup in the testing prompt.
Rewrite the deploy prompt as a target decision:

- `{ build: { targets: ["node"] } }` for the Dawn Node runtime, followed by
  `dawn build`, `dawn start`, or the generated Dockerfile;
- `{ build: { targets: ["hono"] } }` for compatible edge apps after capability
  validation;
- `{ build: { targets: ["langsmith"] } }` for generated LangGraph entries,
  including the current Node 22 config limitation.

Update the prompt description from “Ship … to LangSmith” to target-neutral
deployment wording.

- [ ] **Step 3: Refresh compact machine reference**

Add shared tools and current scaffold memory files to the project shape. Add
`dawn start` and `dawn inspect` to commands. Add thread cancel and memory
candidate routes to the runtime API. Replace the LangSmith-only deployment
paragraph with the same compact three-target distinction used by Deployment.

- [ ] **Step 4: Mark historical content in the full reference**

Change the heading and preamble before blog bodies to:

```ts
sections.push(
  "# Historical Blog Posts",
  "",
  "The posts below are historical, non-normative snapshots. Use the Documentation, Task-Specific Prompts, and Agent Config Templates above for current contracts.",
  "",
)
```

Do not edit historical post bodies.

- [ ] **Step 5: Replace the obsolete Docker blueprint**

Bump its blueprint version and replace the LangGraph CLI flow with the current
Dawn Node target:

1. require Node 24+ and Docker;
2. ensure `@dawn-ai/cli` is a runtime dependency;
3. set `build.targets: ["node"]`;
4. run `pnpm exec dawn verify` and `pnpm exec dawn build --clean`;
5. explain emitted `.dawn/build/server.mjs` and marker-aware root/build-dir
   Dockerfile behavior;
6. build using the emitted Dockerfile and keep `.dawn/build` in the context;
7. run on port 8000 and check `/healthz`;
8. warn that local stores and process-local run/cancel coordination require one
   replica; shared Postgres stores alone do not remove the coordination limit.

Use the actual generated base image `node:24-slim`; remove LangGraph CLI,
Postgres/Redis platform, and license-key instructions. In the OpenTelemetry
blueprint, replace “LangSmith (Dawn's deploy target)” with target-neutral tracing
language.

- [ ] **Step 6: Run focused website verification**

```bash
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
node scripts/check-docs.mjs
git diff --check
```

Expected: all commands PASS. This is the first point at which every new accuracy
contract is green.

- [ ] **Step 7: Commit discovery updates**

```bash
git add apps/web/app/components/landing/Quickstart.tsx apps/web/content/prompts/index.ts apps/web/app/llms.txt/route.ts apps/web/app/llms-full.txt/route.ts apps/web/content/blueprints/deploy/docker.md apps/web/content/blueprints/observability/opentelemetry.md
git commit -m "docs: refresh website discovery guidance"
```

### Task 8: Review the closed ledger and run the Definition of Done

**Files:**
- Modify: `docs/superpowers/plans/2026-08-09-docs-website-accuracy-sweep.md` (checkboxes only)
- Verify: every file listed in Tasks 1–7

- [ ] **Step 1: Audit every ledger row against the final diff**

For A01–A28, confirm the false claim is gone, the replacement is supported by
the named authority, and no page reorganization or unrelated completeness work
entered the diff. Record any new content opportunity for PR 2 instead of adding
it here.

- [ ] **Step 2: Search for the highest-risk stale phrases**

```bash
rg -n 'injected from the pathname|payload\.content|only its own route-local|Dawn itself is not a production runtime|Dawn has no standalone server|Nothing else is gated|including scorer model calls|multi-stage `node:22-slim`' apps/web
```

Expected: no matches in normative documentation, prompts, templates, or served
blueprints. Historical blog bodies may contain dated product descriptions and
remain unchanged.

- [ ] **Step 3: Run repository validation**

```bash
source /Users/blove/.nvm/nvm.sh
nvm use 24
pnpm ci:validate
```

Expected: every Definition of Done lane passes. No changeset is required because
publishable package code is unchanged.

- [ ] **Step 4: Run pull-request changeset verification**

```bash
node scripts/check-changesets.mjs
```

Expected: PASS with no required changeset.

- [ ] **Step 5: Review branch hygiene**

```bash
git diff --check main...HEAD
git status --short
git log --oneline --decorate -10
```

Expected: no whitespace errors; a clean worktree; only the approved design,
plan, docs checker, and website content commits are on
`blove/docs-website-refresh`.

- [ ] **Step 6: Commit completed plan tracking if needed**

```bash
git add docs/superpowers/plans/2026-08-09-docs-website-accuracy-sweep.md
git commit -m "docs: record accuracy sweep completion"
```

Skip this commit if checkbox tracking produced no diff.
