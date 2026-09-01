# Root README claim-evidence matrix

This is the source-of-truth review for material claims planned for the root
README. `keep` means the claim can be stated within the recorded boundary;
`qualify` means that boundary must accompany it; `remove` means it should not
appear without new evidence. The matrix intentionally contains no benchmark,
popularity, adoption, or quantitative code-reduction claims.

### Drift-control legend

- **A — automated merge gate:** the `validate` job in
  `.github/workflows/ci.yml`, principally `pnpm test`,
  `pnpm verify:harness:framework`, and `node scripts/check-docs.mjs`. Each row
  names the owning file/test and, where useful, a reproducible targeted command;
  those package tests also run through `validate`'s `pnpm test`.
- **G — gated CI lane:** a separately named `.github/workflows/ci.yml` job that
  needs Docker, credentials, or dedicated infrastructure. The row gives the
  job and its exact test command.
- **M — manual pre-publication observation:** the README/release owner reruns
  the exact command in this file whenever root README copy will describe
  `npm create ...@latest` or when a new npm `latest` is published. The owner
  replaces the dated receipt under [Clean-room activation
  observation](#clean-room-activation-observation); the retained output is
  this checked-in section, reviewed in the same change.

## Claims

| Claim | Code/test/doc evidence | Conditionality | Drift control | Disposition |
| --- | --- | --- | --- | --- |
| Dawn is a TypeScript meta-framework for LangGraph.js. | `apps/web/content/docs/mental-model.mdx` defines the boundary; `packages/langchain/src/agent-adapter.ts` materializes `agent()` descriptors with `@langchain/langgraph/prebuilt`; `packages/langgraph/src/langgraph-adapter.ts` executes raw graph/workflow entries; `packages/langchain/package.json` carries the LangGraph runtime dependency. | Category description, not a claim that Dawn replaces LangGraph.js or supports its Python runtime. | A: `pnpm --filter @dawn-ai/langchain test`, `pnpm --filter @dawn-ai/langgraph test`, and `node scripts/check-docs.mjs`. | keep |
| “Build LangGraph agents like Next.js apps” describes Dawn's file-system convention. | `apps/web/content/docs/routes.mdx` documents App-Router-style groups and dynamic segments; `packages/core/test/discover-routes.test.ts` tests “strips route groups from pathnames” and “preserves dynamic segments in pathnames.” | An analogy about project and route conventions. Dawn is not a Next.js plugin, and the Dawn server does not require Next.js. | A: `pnpm --filter @dawn-ai/core test` (`discover-routes.test.ts`) and `node scripts/check-docs.mjs`. | qualify |
| Folders under `src/app/` become file-system routes. | `packages/core/test/discover-routes.test.ts` tests workflow, graph, and agent discovery from `index.ts`; `apps/web/content/docs/routes.mdx` documents pathname rules. | An `index.ts` must export exactly one supported entry shape; route groups are omitted, dynamic segments remain parameterized, and private segments are skipped. | A: `pnpm --filter @dawn-ai/core test` (`discover-routes.test.ts`) and `node scripts/check-docs.mjs`. | keep |
| The research starter's agent identity is `/research#agent`. | `packages/devkit/templates/app-research/server/src/app/research/index.ts` default-exports `agent()`; `packages/devkit/templates/app-research/server/test/research.test.ts.template` creates its harness with `route: "/research#agent"`; `test/generated/run-generated-research-activation.test.ts` tests “activates the default research scaffold through the complete npm lifecycle.” | `#agent` selects the entry kind. The pathname alone is `/research`. | A: `pnpm verify:harness:framework` (`run-generated-research-activation.test.ts`) and `pnpm --filter create-dawn-ai-app test`. | keep |
| Dawn supports shared tools in `src/tools/`. | `packages/core/src/compiler/analyze-route-tools.ts` reads the configured shared tools directory; `packages/core/test/extract-tool-types.test.ts` tests “merges shared and route-local tools”; the research starter contains `server/src/tools/searchCorpus.ts` and `server/src/tools/readDoc.ts`. | Shared authored tools remain subject to tool policy and runtime constraints. | A: `pnpm --filter @dawn-ai/core test` (`extract-tool-types.test.ts`) and `pnpm --filter create-dawn-ai-app test` (“scaffolds external mode…”). | keep |
| Dawn supports route-local tools in a route's `tools/` directory. | `packages/core/src/compiler/analyze-route-tools.ts` reads `<routeDir>/tools`; `packages/core/test/extract-tool-types.test.ts` tests merging and “route-local tools shadow shared tools of the same name”; `packages/cli/test/test-command.test.ts` tests a route-local mock alongside a real shared tool. | The default research starter demonstrates shared tools, not route-local tools. Do not depict `server/src/app/research/tools/*` as generated starter content. | A: `pnpm --filter @dawn-ai/core test` (`extract-tool-types.test.ts`) and `pnpm --filter @dawn-ai/cli test test-command`. | qualify |
| Dawn generates TypeScript route, route-parameter, state, and tool types. | `packages/core/test/render-route-types.test.ts` tests exact `dawn:routes` exports, route params, tools, and optional state exports; `packages/cli/test/run-typegen.test.ts` tests “writes types and schemas from one combined route analysis”; `packages/cli/test/typegen-command.test.ts` tests writing generated route types. | State exports exist only when discoverable state supplies valid defaults; declarations are compile-time artifacts regenerated by typegen/build. | A: `pnpm --filter @dawn-ai/core test` and `pnpm --filter @dawn-ai/cli test run-typegen typegen-command`. | keep |
| The starter's normal test path is deterministic and fixture-backed. | `packages/devkit/templates/app-research/server/test/research.test.ts.template` uses `createAgentHarness()` and `script()`; `packages/testing/test/fixture-file-e2e.test.ts` tests committed-fixture replay; `apps/web/content/docs/testing-agents/fixtures.mdx` states unmatched replay fails instead of falling through to a provider. | Applies to replay/fixture paths. `--live`, recording modes, and explicitly injected provider calls are not offline claims. | A: `pnpm --filter @dawn-ai/testing test` (`fixture-file-e2e.test.ts`) and `pnpm verify:harness:framework` (generated starter `npm test`). | keep |
| `npm test` in the published starter passes without provider credentials. | The sanitized clean-room observation below removed and asserted absence of 14 common provider variables, then ran the public activation; it ended with one passed plus one skipped test file, and seven passed plus one skipped tests. | Date/version-specific: verified 2026-08-31 against `npm view create-dawn-ai-app@latest version` = `0.8.21`, Node v24.19.0, npm 10.9.2. One opt-in file/test was skipped. | M: README/release owner reruns the sanitized command below before publication and replaces the receipt in this file. | qualify |
| The Workbench can restore a checkpoint-backed transcript after a browser reload while the server stays running. | `packages/devkit/templates/app-research/web/app/lib/thread-source.test.ts.template` tests “survives a reload through storage” and maps a 200 checkpoint; `packages/devkit/templates/app-research/web/app/components/AppShell.test.tsx.template` tests “restores the checkpointed messages, with the plan card in front”; `apps/web/content/docs/recipes/research-web-ui.mdx` documents `GET /threads/:id/state`. | Browser storage retains the rail entry; the server checkpoint restores messages, tool calls/results, and todos. Earlier subagent activity cards are not checkpointed. The server must remain available. | A: `pnpm verify:harness:framework`; its generated starter `npm test` executes `thread-source.test.ts` and `AppShell.test.tsx`. | qualify |
| Default SQLite-backed state can survive a `dawn dev` process restart. | `packages/testing/test/restart-persistence.test.ts` tests “persists thread state across a real dawn dev process restart (Layer C)” with two processes against one app root; `packages/sqlite-storage/test/threads.test.ts` tests metadata surviving a fresh store instance. | Requires the same persistent app root and SQLite files. It does not imply survival of filesystem loss, container/Pod replacement, or multi-replica coordination; `apps/web/content/docs/deployment/kubernetes.mdx` says chart-local `.dawn` data is ephemeral across Pod replacement. | A: `pnpm --filter @dawn-ai/testing test restart-persistence`, `pnpm --filter @dawn-ai/sqlite-storage test`, and `node scripts/check-docs.mjs`. | qualify |
| The default build emits a runnable Node server, Dockerfile, and LangSmith graph artifacts. | `packages/cli/test/build-targets.test.ts` tests “default targets emit both the node bundle and the langsmith config,” asserting `.dawn/build/server.mjs`, a hardened `Dockerfile`, and `.dawn/build/langgraph.json`; `test/generated/run-generated-research-activation.test.ts` then runs generated `npm start`, waits for health, completes an AG-UI turn, and verifies the report output. | Node is Dawn's Agent Protocol/AG-UI HTTP runtime. LangSmith receives generated graph entries and uses its platform envelope; it is not the Dawn HTTP server. | A: `pnpm --filter @dawn-ai/cli test build-targets` plus `pnpm verify:harness:framework` (`run-generated-research-activation.test.ts`). | keep |
| Hono is an opt-in edge build target. | `apps/web/content/docs/deployment.mdx` lists artifacts and the capability gate; `packages/cli/test/build-targets.test.ts` covers target selection; `packages/cli/test/hono-node-roundtrip.test.ts` is the validate job's Docker-backed, Node-hosted emitted-app/Postgres round trip; `packages/cli/test/workerd-lane.test.ts` is the separate real-workerd proof. | Filesystem, shell, workspace, skills, long-term memory, and sandbox surfaces are gated. Node-hosted and local workerd evidence is not a claim about a live provider deployment. | A: `DAWN_REQUIRE_DOCKER=1 pnpm test` in `validate`. G: `edge-workerd` runs `DAWN_TEST_WORKERD=1 pnpm --filter @dawn-ai/cli test workerd-lane --reporter=default --reporter=json` and asserts zero skips. | qualify |
| Vercel is an opt-in build/deployment target. | `packages/cli/test/build-targets.test.ts` tests “vercel target is opt-in and leaves the default targets unchanged” and combination with Node/LangSmith; `.github/workflows/ci.yml` contains the credentialed native Vercel deployment and cleanup job. | Not a default target. Production confidence depends on the credentialed lane; local artifact tests alone do not prove a live deployment. | A: `pnpm --filter @dawn-ai/cli test build-targets`. G: `vercel-native` runs `pnpm --filter @dawn-ai/cli test vercel-native-lane.test.ts --reporter=json`, then cleanup and `--assert-receipt`. | qualify |
| Kubernetes deployment uses the generated Node image plus Dawn's Helm chart. | `apps/web/content/docs/deployment/kubernetes.mdx` says to build the Node image first; `charts/dawn-app/README.md` says the chart runs, but does not build, that image; `.github/workflows/ci.yml` defines chart validation and kind smoke lanes. | The chart does not provision secrets, make SQLite durable, or translate `dawn.config.ts`. Sandbox infrastructure is a separate chart and gated lane. | G: `chart-validate` runs strict Helm lint, chart render scripts, and kubeconform; `chart-apply-smoke` installs `charts/dawn-app` into kind and curls the Service. | qualify |
| The current default research starter is a two-package npm workspace with a Dawn server and Workbench web app. | `packages/create-dawn-app/src/index.ts` initializes `template = "research"`; `packages/devkit/templates/app-research/package.json.template` declares `server` and `web`; `packages/create-dawn-app/test/create-app.test.ts` “scaffolds external mode…” asserts root/server/web manifests plus the research route, state, plan, tools, subagent, skills, eval, test, and corpus. | Current checked-in 0.8.22 source. Published `latest` resolved to 0.8.21 and generated the earlier single-package research shape. Do not attribute the two-workspace tree to `@latest` until published and reverified. | A: `pnpm --filter create-dawn-ai-app test` and `pnpm verify:harness:framework`. M: after publishing, rerun the sanitized clean room below before calling this the `@latest` shape. | qualify |
| The current research starter uses server port 3002 and Workbench port 3010. | `packages/devkit/templates/app-research/server/package.json.template` has `dawn dev --port 3002`; `packages/devkit/templates/app-research/web/package.json.template` has `next dev -p 3010`; `packages/create-dawn-app/src/index.ts` prints both; `packages/create-dawn-app/test/create-app.test.ts` asserts both lines. | Current checked-in source only until published. Verified 0.8.21 `@latest` printed and used a single server on port 3000. | A: `pnpm --filter create-dawn-ai-app test` (stdout assertions). M: after publishing, rerun the sanitized clean room and update the version/ports receipt below. | qualify |
| The research starter example uses `gpt-5-mini`. | `packages/devkit/templates/app-research/server/src/app/research/index.ts` and its researcher subagent specify `gpt-5-mini`; `packages/devkit/templates/app-research/server/test/research.test.ts.template` covers the fixture-backed route independently of a live model. | A live run requires provider credentials; the offline fixture test does not call that model. | A: `node scripts/check-docs.mjs` rejects provider-prefixed example ids. M: README author runs `rg -n 'model: "gpt-5-mini"' packages/devkit/templates/app-research/server/src/app/research` and reviews the output in the README change. | keep |
| The canonical activation is `npm create dawn-ai-app@latest my-agent`, then `npm install`, then `npm test`. | The sanitized clean room below recorded `npm view create-dawn-ai-app@latest version` = `0.8.21`, printed `✔ Created my-agent (research template)`, installed successfully, and passed the default suite. `packages/create-dawn-app/README.md` documents the executable and Node requirement. | Date/version-specific, network- and registry-dependent; `@latest` can lag repository source. | M: README/release owner reruns the exact sanitized command below before publication and replaces the dated receipt in this file. | qualify |
| Node.js 24+ is required; package-manager wording must reflect what is enforced. | `packages/create-dawn-app/src/index.ts` sets `NODE_FLOOR_MAJOR = 24`; `packages/create-dawn-app/test/node-floor.test.ts` tests rejection below 24 and acceptance at/above it; current research root/server manifests declare Node `>=24.0.0`. `packages/devkit/templates/app-research/README.md` says npm 11, but the published clean room succeeded with npm 10.9.2. | Node 24+ is enforced. npm 11 is the current-source documented baseline, not an evidenced hard minimum for published 0.8.21; do not claim broad npm 10 support from one run. | A: `pnpm --filter create-dawn-ai-app test` (`node-floor.test.ts`). M: record `node --version`, `npm --version`, and `npm view create-dawn-ai-app@latest version` in the clean-room receipt. | qualify |
| Dawn is pre-1.0, its API surface is moving, and users should pin versions and read release notes. | Public manifests are currently `0.8.22`; `apps/web/content/docs/upgrading.mdx` states the pre-1.0 posture and fixed-group releases; `SECURITY.md` defines support as fixes on the default branch through the normal release process. | “Supported” means documented public surfaces on the current release line, not a 1.0 stability guarantee or long-term-support promise. | A: `pnpm check:release-inventory` and `node scripts/check-docs.mjs`. M: README author compares maturity copy with `apps/web/content/docs/upgrading.mdx` and `SECURITY.md` in the same review. | keep |
| How Dawn fits: LangGraph.js remains the graph runtime; Dawn supplies application conventions around it. | `packages/langgraph/src/langgraph-adapter.ts`, `packages/langchain/src/agent-adapter.ts`, `apps/web/content/docs/mental-model.mdx`, and `apps/web/content/docs/migrating-from-langgraph.mdx` preserve this boundary. | Dawn requires LangGraph.js; it is not a replacement runtime. Raw graphs may need explicit checkpointer invocation adaptation at a target boundary. | A: `pnpm --filter @dawn-ai/langgraph test`, `pnpm --filter @dawn-ai/langchain test`, and `node scripts/check-docs.mjs`. | keep |
| How Dawn fits: LangChain remains usable, and Dawn's built-in `agent()` path uses LangChain integrations. | `packages/langchain/src/agent-adapter.ts` converts tools, creates a chat model, and calls `createReactAgent`; `packages/langchain/package.json` lists provider peers; `apps/web/content/docs/migrating-from-langgraph.mdx` says raw graph/chain routes retain imported packages. | Do not imply every LangChain package/provider is tested by Dawn. Raw routes own their imports and behavior. | A: `pnpm --filter @dawn-ai/langchain test` (`agent-adapter.test.ts`, `chat-model-factory.test.ts`, `model-provider-resolver.test.ts`) and `node scripts/check-docs.mjs`. | qualify |
| How Dawn fits: LangSmith is a separate deployment and observability platform that consumes Dawn's generated artifacts. | `packages/cli/test/build-targets.test.ts` asserts generated `langgraph.json`; `apps/web/content/docs/deployment.mdx` and `apps/web/content/docs/mental-model.mdx` distinguish LangSmith entries from Dawn's HTTP runtime. | Dawn does not provision or host LangSmith; local Node protocol behavior is not evidence of the LangSmith envelope. | A: `pnpm --filter @dawn-ai/cli test build-targets` and `node scripts/check-docs.mjs`. | qualify |
| How Dawn fits: model providers remain external and selectable. | `packages/langchain/src/model-provider-resolver.ts`, `packages/langchain/src/chat-model-factory.ts`, and `packages/langchain/package.json` define the implemented seam; `apps/web/content/docs/migrating-from-langgraph.mdx` distinguishes built-in agents from raw graph/chain ownership. | Built-in aliases depend on mappings and installed peers; raw graph/chain routes can instantiate LangChain-compatible providers. Credentials/provider availability remain the user's responsibility. | A: `pnpm --filter @dawn-ai/langchain test` (`model-provider-resolver.test.ts`, `chat-model-factory.test.ts`) and `node scripts/check-docs.mjs`. | qualify |
| How Dawn fits: CopilotKit composes with Dawn through AG-UI; Dawn remains backend-first. | `examples/chat/web/app/api/copilotkit/[...path]/route.ts` wires CopilotKit's `HttpAgent` to Dawn's AG-UI route; `test/security-dependencies/copilotkit-v2-runtime.test.ts` tests “streams a real HttpAgent run across the encoded Dawn AG-UI boundary”; `packages/ag-ui/test/conformance.test.ts` verifies an `HttpAgent` parses the stream. | Evidenced integration, not a claim that Dawn is a general frontend framework or every CopilotKit version is compatible. | A: `pnpm test` covers AG-UI conformance/dependency tests. G: `copilotkit-examples-e2e` runs both `pnpm --filter @dawn-example/chat-web test:e2e` and `pnpm --filter @dawn-example/research-web test:e2e`. | keep |
| How Dawn fits: Vercel AI SDK can be used inside a Dawn route. | The only checked-in comparison is prose in `apps/web/content/docs/faq.mdx`; there is no dedicated Vercel AI SDK integration fixture or compatibility test. | Generic TypeScript compatibility is not enough evidence for a root README product comparison, and the external surface can drift. | Remove from root README. Reconsider only after adding a maintained fixture/test and current primary-source review in the same change. | remove |
| How Dawn fits: Mastra is broader with its own runtime, while Dawn is narrower around LangGraph.js. | The only checked-in evidence is prose in `apps/web/content/docs/faq.mdx`; no code or compatibility test establishes the competitor characterization. | External-product scope can change, and the repository does not test it. | Remove from root README. Reconsider only after current primary-source review and maintained evidence are added in the same change. | remove |
| When Dawn fits: a TypeScript team wants LangGraph.js plus file-system routes, generated types, a local dev/test loop, persistence primitives, and build targets. | Evidence is distributed across `packages/core/test/discover-routes.test.ts`, `packages/core/test/render-route-types.test.ts`, `packages/cli/test/test-command.test.ts`, `packages/testing/test/restart-persistence.test.ts`, and `packages/cli/test/build-targets.test.ts`. | A fit description, not a guarantee every application needs or can use every capability on every target. | A: `pnpm test`, `pnpm verify:harness:framework`, and `node scripts/check-docs.mjs`; README review must preserve the qualifications from the component rows above. | qualify |
| When Dawn does not fit: projects that do not want LangGraph.js or require Python. | `apps/web/content/docs/faq.mdx` says LangGraph is required and Python is unsupported; packages/starters are TypeScript/Node, and typegen reads TypeScript signatures. | States Dawn's current boundary; it is not a judgment about LangGraph Python. | A: `pnpm check:release-inventory`, `pnpm typecheck`, and `node scripts/check-docs.mjs`. | keep |
| When Dawn fits: existing raw LangGraph.js graphs can migrate incrementally and remain raw `graph` routes. | `packages/core/test/discover-routes.test.ts` tests graph discovery; `packages/langgraph/src/langgraph-adapter.ts` executes invokable graph entries; `apps/web/content/docs/migrating-from-langgraph.mdx` gives the re-export shape and checkpointer caveat. | Existing nodes, edges, and imports can remain, but deployment/invocation/checkpointer behavior must be validated per target. | A: `pnpm --filter @dawn-ai/core test`, `pnpm --filter @dawn-ai/langgraph test`, and `node scripts/check-docs.mjs`. | qualify |
| When Dawn does not fit: teams seeking a hosted AI platform or infrastructure provisioning. | `apps/web/content/docs/deployment.mdx` says Dawn emits artifacts but does not provision infrastructure, host apps, or manage secrets; `charts/dawn-app/README.md` says the chart runs a user-built image and does not build it. | Users operate or contract with deployment platforms separately. | A: `node scripts/check-docs.mjs`. G: `chart-validate` verifies the chart artifact without changing the non-provisioning boundary. | keep |
| When Dawn fits in production: teams accept pre-1.0 change management and validate their runtime, storage, auth, and provider boundary. | `apps/web/content/docs/faq.mdx` recommends pinning; `apps/web/content/docs/deployment.mdx` says a green build is not a substitute for deployed-boundary testing; `apps/web/content/docs/upgrading.mdx` documents upgrades. | Do not use an unqualified “production-ready” label. Readiness is application- and target-specific. | A: `pnpm ci:validate`. G: the selected target's named job (`edge-workerd`, `vercel-native`, `chart-validate`, or `chart-apply-smoke`) must pass before making that target-specific claim. | qualify |

## Clean-room activation observation

Run on 2026-08-31 from the repository root with the required runtime prepended
to `PATH`. The wrapper removed 14 common provider variables and failed if any
remained before executing the public command sequence:

```text
provider credentials present after sanitization: 0/14
node: v24.19.0
npm: 10.9.2
npm latest: 0.8.21

✔ Created my-agent (research template)

added 195 packages, and audited 196 packages in 17s
found 0 vulnerabilities

Test Files  1 passed | 1 skipped (2)
Tests  7 passed | 1 skipped (8)
Duration  2.55s
```

The exact sanitized command was:

```bash
provider_vars=(
  OPENAI_API_KEY OPENAI_BASE_URL AZURE_OPENAI_API_KEY AZURE_OPENAI_ENDPOINT
  ANTHROPIC_API_KEY GOOGLE_API_KEY GOOGLE_GENERATIVE_AI_API_KEY
  MISTRAL_API_KEY GROQ_API_KEY XAI_API_KEY OPENROUTER_API_KEY
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
)
for key in "${provider_vars[@]}"; do unset "$key"; done
for key in "${provider_vars[@]}"; do
  if printenv "$key" >/dev/null; then
    printf "provider credential still present: %s\n" "$key" >&2
    exit 1
  fi
done
printf "provider credentials present after sanitization: 0/%s\n" "${#provider_vars[@]}"
node --version
npm --version
npm view create-dawn-ai-app@latest version

activation_root="$(mktemp -d)"
(
  cd "$activation_root"
  npm create dawn-ai-app@latest my-agent
  cd my-agent
  npm install
  npm test
)
```

This date/version-specific observation supports only the 0.8.21 package npm
resolved at that moment. It demonstrates the canonical activation and default
fixture suite with the listed provider variables absent; it does not prove that
all possible credential variables were absent or that arbitrary user changes
cannot enable a live path. It also does not prove the published package already
contains the current repository's two-workspace Workbench shape or its
3002/3010 ports: 0.8.21 generated the earlier single-package starter and printed
port 3000.

## Current-source verification observation

The required repository checks ran with Node v24.19.0 and pnpm 10.33.0:

```text
pnpm build
  Tasks: 25 successful, 25 total

pnpm --filter create-dawn-ai-app test
  Test Files 2 passed (2)
  Tests 11 passed (11)

source scan
  NODE_FLOOR_MAJOR = 24
  let template = "research"
  server dev port = 3002
  Workbench dev/start port = 3010
```

The source scan command was:

```bash
rg -n 'NODE_FLOOR_MAJOR|let template = "research"|3002|3010' \
  packages/create-dawn-app/src/index.ts \
  packages/create-dawn-app/test/create-app.test.ts \
  packages/devkit/templates/app-research
```

The current research template's root and server manifests declare Node
`>=24.0.0`; its README documents npm 11. Because the published clean-room run
succeeded with npm 10.9.2, root README wording must distinguish the enforced
Node floor from the current-template npm baseline instead of presenting npm 11
as a demonstrated hard minimum.
