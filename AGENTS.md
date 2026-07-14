# AGENTS.md

Standards for anyone — human or coding agent — working in this repository: the
workspace map, the Definition of Done, and the conventions that keep changes
consistent.

## What this is (and isn't)

This is the **repo-root contributor/agent standards doc** — how to find your
way around the Dawn monorepo, what "done" means for a change, and the rules
that keep the codebase consistent. It's the canonical entrypoint; see
[Cross-links](#cross-links) for how it relates to `CONTRIBUTING.md` and
`CONTRIBUTORS.md`.

**This is not** the runtime `workspace/AGENTS.md` capability. Dawn ships a
built-in capability
(`packages/core/src/capabilities/built-in/agents-md.ts`) that auto-injects the
contents of an **app's** `<appRoot>/workspace/AGENTS.md` into that agent's
system prompt as its persistent "# Memory" — re-read every turn, updated by
the agent itself via `writeFile`. That's an end-user Dawn app feature,
documented at [dawnai.org/docs/memory](https://dawnai.org/docs/memory). The
name collision is real: this file (repo root, for contributors) and that file
(inside a generated app's `workspace/`, for the agent at runtime) share a
filename but nothing else. If you're looking for the runtime feature, this
isn't it.

## Workspace map

Every `packages/*` directory is a pnpm workspace member (verify: `pnpm -r list --depth -1`). One-line purpose is each package's own `README.md` first line.

**Core framework**

| Package | Purpose |
|---|---|
| `@dawn-ai/sdk` | The author-facing TypeScript SDK — `agent()`, `defineMiddleware()`, `allow()`/`reject()`, and the type primitives the CLI consumes. |
| `@dawn-ai/core` | Filesystem-based route discovery, app config loading, state-field resolution, and typegen primitives that the Dawn CLI builds on. |
| `@dawn-ai/cli` | The `dawn` CLI — local HMR dev runtime, route execution, validation, typegen, and the build step that produces LangSmith deployment artifacts. |
| `@dawn-ai/langgraph` | LangGraph runtime adapters and route module contracts (`graphAdapter`, `workflowAdapter`, `defineEntry`) used by the CLI. |
| `@dawn-ai/langchain` | LangChain backend adapters — materializes `chain` routes and provider-aware `agent` routes (tool conversion, streaming, retry). |

**Capabilities & integrations**

| Package | Purpose |
|---|---|
| `@dawn-ai/ag-ui` | AG-UI protocol translation for Dawn's local runtime — maps runtime stream chunks to AG-UI events and back, so CopilotKit and other AG-UI clients can drive Dawn agents. |
| `@dawn-ai/permissions` | Permission and access-control primitives for Dawn agents — gating tool and resource access at runtime. |
| `@dawn-ai/workspace` | Filesystem-backed workspace utilities for Dawn agents — reading, writing, and managing files in an agent's working directory. |
| `@dawn-ai/sandbox` | Reference sandbox providers for Dawn workspace execution — a Docker-backed `SandboxProvider` that redirects the workspace filesystem and shell tools into a per-thread isolated environment. |
| `@dawn-ai/vite-plugin` | Vite plugin for Dawn's typegen pipeline (extracts tool types and generates route ambient declarations). |

**Storage & memory**

| Package | Purpose |
|---|---|
| `@dawn-ai/memory` | Deterministic long-term memory storage and recall for Dawn's typed `memory.ts` capability — the storage/ranking layer under `@dawn-ai/core`. |
| `@dawn-ai/memory-pgvector` | Postgres + pgvector backend for Dawn's typed long-term memory store, for deployments where SQLite is too local (multiple instances, shared DB, HNSW retrieval at scale). |
| `@dawn-ai/sqlite-storage` | SQLite-backed storage adapter for Dawn — durable persistence for agent state and runtime data. |

**Testing & evals**

| Package | Purpose |
|---|---|
| `@dawn-ai/testing` | Testing utilities for Dawn apps — helpers for exercising routes, tools, and agent behavior in unit and scenario tests. |
| `@dawn-ai/evals` | Evaluation harness for Dawn agents — running and scoring agent behavior against datasets and scenarios. |

**Scaffolding & tooling**

| Package | Purpose |
|---|---|
| `create-dawn-ai-app` | Scaffold a new Dawn app — generates a working application from the supported starter templates with Dawn's canonical layout wired for local development. |
| `@dawn-ai/devkit` | Internal scaffold templates and dev-time tooling shared between `@dawn-ai/cli` and `create-dawn-ai-app`. |
| `@dawn-ai/config-typescript` | Shared TypeScript compiler configurations (`base`, `library`, `node`, `nextjs`) for Dawn workspace packages. |
| `@dawn-ai/config-biome` | Shared Biome lint/format configuration used by Dawn workspace packages. |

**Apps**

| Package | Purpose |
|---|---|
| `@dawn-ai/web` (`apps/web`) | The documentation website (dawnai.org) and its content/nav. |

**Examples** (`examples/*`, pnpm workspace members; consume Dawn via `workspace:*` and are typechecked in CI)

| Package | Purpose |
|---|---|
| `@dawn-example/chat-server` / `@dawn-example/chat-web` (`examples/chat`) | Foundational agent-harness primitives (filesystem + bash) end-to-end, plus planning, skills, subagents, workspace, and HITL permissions, with a disposable smoke-test web client. |
| `@dawn-example/memory` (`examples/memory/server`) | Long-term memory with a backend-switchable store — zero-setup SQLite by default, Postgres + pgvector via `DATABASE_URL`, hybrid keyword + vector recall via `OPENAI_API_KEY`. |
| `@dawn-example/research-server` / `@dawn-example/research-web` (`examples/research`) | The flagship deep-research assistant example — routes, tools, subagents, memory, planning, offloading, HITL permissions, and an optional Docker sandbox. |

Note: `examples/chat/package.json` and `examples/research/package.json` are
orchestration-only (`private: true`, one level above `server`/`web`) and are
**not** themselves pnpm workspace members — the actual members are the
`server`/`web` subdirectories, matched by the `examples/*/*` glob in
`pnpm-workspace.yaml`.

**Charts** (Helm charts under `charts/`, not pnpm workspace members)

| Chart | Purpose |
|---|---|
| `charts/dawn-app` | Runs a built Dawn app image (from `langgraphjs dockerfile`) on Kubernetes as a Deployment + Service, with optional Ingress, HorizontalPodAutoscaler, and PodDisruptionBudget, wired to the in-cluster `kubernetesSandbox` orchestrator ServiceAccount. |
| `charts/dawn-sandbox-infra` | Cluster-side infrastructure for the Dawn `kubernetesSandbox` provider — namespace, least-privilege RBAC, default-deny egress, quotas/limits, Pod Security Standards, and a PVC reaper. |

`test/` and `scripts/` are repo-level (verification lanes and workspace
scripts respectively) — not workspace packages.

## Definition of Done

The exact gates a change must pass are the `validate` job in
`.github/workflows/ci.yml`, in order:

1. `pnpm lint`
2. `pnpm check:build-cache`
3. `pnpm build`
4. `pnpm typecheck`
5. `pnpm test`
6. `node scripts/check-docs.mjs`
7. `pnpm pack:check`
8. `pnpm verify:harness:self-test`
9. `pnpm verify:harness:framework`
10. `pnpm verify:harness:runtime`
11. `pnpm verify:harness:smoke`

On pull requests, a separate `changesets` job also runs
`node scripts/check-changesets.mjs` to require a changeset for user-facing
package changes.

Run `pnpm ci:validate` locally to approximate this lane (it exists as a
script in the root `package.json`). It runs the same lint → build-cache →
build → typecheck → test → docs-check → pack-check → harness sequence, plus a
few extra local-only release-script unit tests
(`test:release-publish`, `test:upload-release-assets`,
`test:backfill-release-tags`) that aren't separate CI steps.

**Gated lanes** — these run as separate CI jobs behind env flags or dedicated
infrastructure, not part of `validate`, and aren't required for most PRs:
`sandbox-docker` (`DAWN_TEST_DOCKER=1`), `pgvector-docker`
(`DAWN_TEST_PGVECTOR=1`), `sandbox-k8s` (`DAWN_TEST_K8S=1`, kind + Calico),
`sandbox-k8s-e2e` / `sandbox-docker-e2e` (`DAWN_TEST_SMOKE_E2E=1`, full-arc
deployed-app smoke), `chart-validate` (Helm lint + kubeconform), and
`chart-apply-smoke` (kind install smoke).

## Conventions

- **Changesets are a fixed group, patch on 0.x.** All publishable packages
  release together (`.changeset/config.json`'s `fixed` group). On a 0.x train
  a `minor` bump takes every package to `1.0.0` — use `patch` unless you
  intend a real 1.0 release.
- **`exactOptionalPropertyTypes: true`.** Never assign `{ x: undefined }` to
  an optional field; use a conditional spread (`...(x !== undefined ? { x } : {})`)
  instead, or the type checker will reject it.
- **Never run bare `biome check --write`.** It mass-reformats the whole
  workspace. Use `pnpm lint` (or `pnpm lint:fix` to auto-fix), or scope Biome
  to the files you changed.
- **Import specifiers: `src/` uses `.js`, `test/` uses `.ts`.** This is
  NodeNext ESM — source files import sibling `src/*.ts` modules with a `.js`
  extension; test files import with `.ts`. Follow the existing pattern in the
  package you're editing.
- **Examples/docs/scaffolds use gpt-5-family models only** (canonical default
  `gpt-5-mini`; no `gpt-4o`, though it stays in the provider registry,
  validation tests, and recorded fixtures). This is a project convention, not
  currently enforced by `scripts/check-docs.mjs` — check it by eye when
  touching examples.
- **Branch per PR; pin before dispatching parallel/subagent work.** In a
  multi-worktree setup, a subagent's commits can land on a detached HEAD
  tracking the wrong branch if the feature branch isn't checked out first.
- **Build before running anything against `dist/`.** Packages compile
  `src/*.ts` to a gitignored `dist/`, and consumers import the built output —
  a stale or skewed `dist/` (from a branch switch or a per-package filtered
  build) produces false negatives in ad-hoc scripts. Run `pnpm build` first;
  see `CONTRIBUTING.md`'s "Build before running anything against `dist/`".
- **Banned doc phrases.** `scripts/check-docs.mjs` greps `README.md`,
  `CONTRIBUTING.md`, `CONTRIBUTORS.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  `apps/web/app`, `apps/web/content`, `docs/` (excluding
  `docs/superpowers/`), and `packages/` for stale or overstated wording —
  e.g. the retired `dawn-ai.org` domain, provider-prefixed model ids
  (`openai:gpt...`), the old `agent.bindTools` / `.dawn/generated` /
  `auto-bound`/`auto-registered` phrasing, and claims like "byte-identical"
  or "speaks the LangSmith protocol natively" that overstate local/prod
  parity. This file (`AGENTS.md`) isn't in that scanned set, but keep it
  honest anyway — see the `forbiddenContent` list in
  `scripts/check-docs.mjs` for the exact patterns.
- **Always run commands from the repo root.** Turbo and workspace-package
  resolution assume it.

## Where things live

- Docs site content: `apps/web/content/docs/*.mdx` (nav registered in
  `apps/web/app/components/docs/nav.ts`).
- Specs, plans, audits, runbooks: `docs/superpowers/`.
- CI: `.github/workflows/ci.yml`.
- Changeset config (fixed group, patch-on-0.x): `.changeset/config.json`.

## Cross-links

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — the public PR path: setup, issues,
  PRs, CLA/DCO, code of conduct.
- [`CONTRIBUTORS.md`](./CONTRIBUTORS.md) — internal monorepo guide: local
  setup, the `--mode internal` scaffold path, and verification lanes. Its
  per-package responsibilities point back at the workspace map above.
- [`README.md`](./README.md) — project overview and quickstart.
