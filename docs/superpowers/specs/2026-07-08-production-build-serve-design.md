# Production build & serve (Node/Docker target) — design

**Date:** 2026-07-08
**Status:** approved (brainstorm)
**Topic:** Make `dawn build` emit a runnable production server — Dawn's own runtime, sandbox-capable, serving Agent Protocol **and** AG-UI, bound to `0.0.0.0` — plus a hardened Dockerfile, behind a build-target seam that extends to edge targets later. This is sub-project A ("SP-A") of the broader deploy-anywhere epic, and the dependency that unblocks the paused full-arc sandbox smoke.

## Problem

Today `dawn build` generates **LangSmith/LangGraph-Platform artifacts only** — a merged `langgraph.json` plus per-route `materializeAgentGraph` entry files under `.dawn/build/`. That path is served by the LangGraph platform server, which does **not** run Dawn's runtime. Concretely:

- **The execution sandbox never engages under a built app.** The sandbox is acquired per-thread in Dawn's *runtime* (`packages/cli` `execute-route.ts` / `SandboxManager`), not in the compiled graph (`@dawn-ai/langchain`'s `materializeAgentGraph`). Serving via `langgraphjs`/LangSmith bypasses it, so workspace tools fall back to **local** backends.
- **The only server that runs Dawn's runtime is `dawn dev`**, which hardcodes `server.listen(port, "127.0.0.1")` (runtime-server.ts) with only a `--port` flag — not reachable from a Kubernetes Service, a Docker network, or a container readiness probe.
- **Net:** there is no supported way to run a container that both serves reachably (`0.0.0.0`) *and* engages the sandbox. The shipped `dawn-app` Helm chart + `kubernetesSandbox` provider (0.8.9) cannot actually be composed in production, and the self-host docs (which point at `langgraphjs dockerfile`) are silently wrong for sandboxed apps.

This gap was discovered while designing the full-arc smoke: the smoke needs exactly this artifact.

## Goal

`dawn build` emits a **first-class Node/Docker deployment target** — a runnable Dawn-runtime server on `0.0.0.0` (serving `/threads` AP, `/agui/:routeId` AG-UI, and `/healthz`) plus a hardened production Dockerfile — behind a target seam that keeps the existing LangSmith artifact and leaves room for edge targets. A thin `dawn start` runs the built server.

## Non-goals / honest bounds

- **No single-file bundle in the MVP.** The built server runs from `node_modules` (like `dawn dev`). Bundling (esbuild) is a deferred optimization, not required for correctness.
- **Edge/non-node targets are out of scope here** — but their requirements are enumerated (see "Non-node analysis") so the seam is designed with them in mind.
- **No route/agent authoring changes.** This only changes how a built app is *served*, not how it's written.
- The `langgraph.json`/LangSmith path is **kept**, not removed — demoted to an explicitly-labeled "platform deploy, no Dawn runtime → no sandbox" target.

## Architecture

### 1. `serveRuntime()` — a bindable production server

Factor the `dawn dev` boot sequence (currently in `dev-session.ts`) into a reusable function in `packages/cli`:

```
serveRuntime({ appRoot, host, port, signal? }): Promise<{ url, close }>
```

It performs the one-time boot — `loadDawnConfig` → `discoverRoutes` → `runTypegen` → build the runtime registry + SQLite checkpointer + threadsStore + `resolveSandboxManager` → `createRuntimeRequestListener` → `createServer(listener).listen(port, host)` — with **no file-watching**. Defaults: `host = process.env.HOST ?? "0.0.0.0"`, `port = Number(process.env.PORT ?? 8000)`. Graceful shutdown: SIGTERM/SIGINT → the listener's existing drain/`close` path (the same `listenerClose` wiring the sandbox reaper/shutdown already depends on), so in-flight runs finish and sandboxes are released before exit.

`dawn dev` is refactored to call the shared boot with `host = "127.0.0.1"` + its watch loop; the two front-ends (`dev`, `start`) share one runtime. Because `createRuntimeRequestListener` already registers `/threads`, `/agui/:routeId`, and `/healthz`, the production server serves **all three** with no extra work.

The hardcoded `"127.0.0.1"` in `listen()` becomes the caller-supplied host.

### 2. Build-target seam

`dawn build` gains a notion of **targets**, configured in `dawn.config.ts` under `build.targets` (array; also `--target <name>` on the CLI to override). Each target is a small module that, given the discovered manifest + build dir, emits its artifacts.

- **`node` (new):** emits
  - `.dawn/build/server.mjs` — a tiny entrypoint: `import { serveRuntime } from "@dawn-ai/cli"; await serveRuntime({ appRoot: <resolved> })`. Reads `HOST`/`PORT` from env via `serveRuntime`'s defaults.
  - `Dockerfile` (emitted at app root, or `.dawn/build/Dockerfile`; do not clobber a user-authored `Dockerfile` — if one exists, emit to `.dawn/build/Dockerfile` and note it) — multi-stage, hardened:
    - base `node:22-slim`; deps stage installs production deps; final stage copies app + `.dawn/build`;
    - runs as **non-root `1000:1000`** (matches the `dawn-app` chart's `runAsNonRoot` default);
    - `EXPOSE 8000`; `ENV HOST=0.0.0.0 PORT=8000`;
    - `HEALTHCHECK` curling `/healthz`;
    - `CMD ["node", ".dawn/build/server.mjs"]` — runs the emitted entrypoint directly (CLI-arg-independent, no dependency on the `dawn` bin being on PATH).
- **`langsmith` (existing, kept):** the current `langgraph.json` + entry-file emission (via `extractDeploymentConfig`), unchanged, but labeled in docs/output as the platform path that does **not** run Dawn's runtime (no sandbox).

**Default `build.targets` = `["node", "langsmith"]`** so existing LangSmith users don't regress while `node` becomes first-class. `dawn check` validates target names.

### 3. `dawn start`

A thin new command: resolves the app, requires a prior `dawn build` (or runs the boot directly against source like `dev` — decide in plan; simplest MVP: `dawn start` calls `serveRuntime` against the app root directly, so it works with or without a prebuilt `server.mjs`). Binds `0.0.0.0:8000` by default. This is the container `CMD` and the local "run it like prod" command.

### 4. Docs / chart / memory alignment

- **`dawn-app` chart:** values/docs point at a dawn-build image, `containerPort: 8000`, probes on `/healthz`. (The chart already defaults these; confirm + document the image-build path.)
- **`sandbox.mdx` / self-host docs:** the production/sandboxed path is `dawn build` (node target) → the emitted Dockerfile → the runtime server on `0.0.0.0`, serving **AP and AG-UI**. State plainly that the `langgraphjs`/LangSmith path does **not** run the Dawn runtime and therefore does **not** engage the sandbox.
- **Memory:** update `project_dawn_self_host_docker` — its current "containerize via `langgraphjs dockerfile`" guidance is incomplete for sandboxed apps.

### 5. Non-node analysis (deferred, documented — do not build)

Enumerate what an edge target (Cloudflare Workers, Vercel Edge) would require, so the seam is future-aware:

- **HTTP:** `node:http createServer` → a Web-standard `fetch(request): Response` handler. The AG-UI adapter's mapping is already pure/transport-agnostic; the AP router (`createRuntimeRequestListener`) would need a `fetch`-shaped variant.
- **State:** `node:sqlite` checkpointer + threadsStore → a non-node backend (Cloudflare D1 / Durable Objects / KV; Vercel KV/Postgres). The `checkpointer`/`threadsStore` config points are already pluggable.
- **Sandbox:** node-only (`child_process`, docker CLI, `@kubernetes/client-node`). On edge it must be **off** or a **remote** provider (a hosted sandbox service called over HTTP). `dawn check` should warn when a node-only feature is configured for an edge target.
- **No `child_process` / no local FS** on edge — the workspace capability's local backends don't apply; only remote/sandbox-backed or memory backends.

This section is analysis only; edge targets are separate future sub-projects.

## Testing

- **`serveRuntime` unit/integration test:** boot on an ephemeral port bound to `127.0.0.1` (test only), assert `GET /healthz` 200, drive one AP run and one AG-UI run via the existing `@dawn-ai/testing` harness/aimock, assert graceful `close()` releases resources.
- **`dawn build` test:** with `build.targets` including `node`, assert `.dawn/build/server.mjs` and a `Dockerfile` are emitted and structurally valid (server entry imports `serveRuntime`; Dockerfile parses, runs non-root, EXPOSE 8000, CMD present). Assert `langsmith` still emits `langgraph.json`.
- **`dawn start` smoke:** starts the server against a fixture app, hits `/healthz`, shuts down.
- **The real container run** (build the image, run it, drive a sandboxed turn) is proven by the **resumed full-arc smoke**, which consumes this artifact.

## File / component structure

- `packages/cli/src/lib/dev/serve-runtime.ts` (new) — `serveRuntime()`; the shared boot extracted from `dev-session.ts`.
- `packages/cli/src/lib/dev/runtime-server.ts` — `listen()` takes a host argument (default preserved for dev).
- `packages/cli/src/commands/dev.ts` — refactored onto the shared boot (localhost + watch).
- `packages/cli/src/commands/start.ts` (new) — `dawn start`.
- `packages/cli/src/lib/build/targets/{node,langsmith}.ts` (new/refactor) — the target seam; `node` emits server entry + Dockerfile, `langsmith` wraps the existing emission.
- `packages/cli/src/commands/build.ts` — dispatch over `build.targets`.
- `packages/core/src/types.ts` — `DawnConfig.build.targets?: string[]`.
- `packages/cli/src/commands/check.ts` — validate target names.
- `apps/web/content/docs/sandbox.mdx` (+ self-host docs) — corrected serving guidance.
- `charts/dawn-app/` — docs/values note the dawn-build image.

## Sequencing (for the plan)

1. `serveRuntime()` extraction + `listen(host)` param (TDD); refactor `dawn dev` onto it (no behavior change: still 127.0.0.1 + watch).
2. `dawn start` command over `serveRuntime` (0.0.0.0 default).
3. Build-target seam + `node` target (server.mjs + Dockerfile); keep `langsmith`; `build.targets` config + `dawn check` validation.
4. Docs + chart + memory alignment.
5. Changeset (patch, fixed-group) + full verification + PR.
6. (Separate, after merge) Rebase the full-arc smoke branch onto this and finish it.

Each of 1–3 lands independently and is independently testable.
