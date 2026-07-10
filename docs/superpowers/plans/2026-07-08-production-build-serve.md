# Production build & serve (Node/Docker target) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `dawn build` emits a runnable production Dawn-runtime server (sandbox-capable, serving Agent Protocol + AG-UI, bound `0.0.0.0`) plus a hardened Dockerfile, behind a build-target seam; `dawn start` runs it.

**Architecture:** Extract the `dawn dev` boot into a reusable `serveRuntime({ appRoot, host, port })` that binds a configurable host (default `0.0.0.0:8000`). Add a build-target seam to `dawn build`: a new `node` target emits `.dawn/build/server.mjs` (calls `serveRuntime`) + a hardened `Dockerfile`; the existing `langgraph.json` emission becomes the kept-but-labeled `langsmith` target. Add `dawn start`. `dawn dev` is refactored onto the same boot with `host=127.0.0.1` + watch — no behavior change.

**Tech Stack:** TypeScript (NodeNext ESM), `node:http`, existing `createRuntimeRequestListener`/`startRuntimeServer`, commander, Vitest, Biome, changesets.

**Spec:** `docs/superpowers/specs/2026-07-08-production-build-serve-design.md`

**Branch:** `feat/production-build-serve` (off origin/main @ 0.8.11). Pin before dispatching subagents (multi-worktree detached-HEAD hazard). Never bare `biome check --write`; use `pnpm lint`.

---

## Orienting notes for every task

- `packages/cli/src/lib/dev/runtime-server.ts` — `createRuntimeRequestListener(options)` (builds the router incl. `/threads`, `/agui/:routeId`, `/healthz`), `startRuntimeServer(options)` (wraps it with `createServer` + `listen(server, options.port)`, hardcodes `127.0.0.1` in both `listen()` at ~line 962 and the returned `url` at ~line 191), and the `close()` graceful-drain path (`listenerClose` → releases sandboxes). `StartRuntimeServerOptions` defines what the caller assembles (registry, checkpointer, threadsStore, sandboxManager, appRoot, port).
- `packages/cli/src/lib/dev/dev-session.ts` — how `dawn dev` assembles those options today (config load → discover → typegen → registry/checkpointer/threadsStore/sandboxManager) and how it watches. This is the boot `serveRuntime` must reproduce (minus watch).
- `packages/cli/src/commands/build.ts` — current build: typegen → `.dawn/build/<route>.ts` entries → merged `langgraph.json` via `extractDeploymentConfig` (`packages/cli/src/lib/build/deployment-config.js`).
- `exactOptionalPropertyTypes: true` — conditional-spread optional fields. `src/` imports `.js`; tests import `.ts`.

---

## Task 1: `listen(host)` + `startRuntimeServer` host option

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`
- Test: `packages/cli/test/runtime-server-host.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, expect, test } from "vitest"
import { startRuntimeServer } from "../src/lib/dev/runtime-server.ts"
import { makeMinimalServerOptions } from "./support/runtime-server-fixtures.ts" // see note

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined })

test("startRuntimeServer binds the requested host and reports it in the url", async () => {
  const server = await startRuntimeServer({ ...(await makeMinimalServerOptions()), host: "127.0.0.1", port: 0 })
  close = server.close
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
})
```

If no minimal-options helper exists, build the options inline the way an existing runtime-server test does — search `packages/cli/test` for a test that already calls `startRuntimeServer`/`createRuntimeRequestListener` and reuse its option-assembly (do NOT invent the shape). If such a test exists, mirror it; the assertion is only about host/url.

- [ ] **Step 2: Run it — expect fail** (`host` not accepted / url hardcoded 127.0.0.1). `pnpm --filter @dawn-ai/cli test runtime-server-host`.

- [ ] **Step 3: Implement**

- Add `readonly host?: string` to `StartRuntimeServerOptions`.
- Change `async function listen(server, port)` → `listen(server, host, port)` and call `server.listen(port ?? 0, host ?? "127.0.0.1", …)`.
- In `startRuntimeServer`, pass `options.host` into `listen`, and build the returned `url` from the resolved host: `http://${options.host ?? "127.0.0.1"}:${port}` (when host is `0.0.0.0`, still report a dialable url — use `127.0.0.1` in the url string if host is `0.0.0.0`, since `0.0.0.0` isn't dialable; add a small `urlHost = host === "0.0.0.0" ? "127.0.0.1" : host` helper).

- [ ] **Step 4: Run — expect pass.** Then `pnpm --filter @dawn-ai/cli test runtime-server` (whole file) to confirm no regression, `typecheck`, `lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-server.ts packages/cli/test/runtime-server-host.test.ts
git commit -m "feat(cli): startRuntimeServer accepts a bind host (default preserved)"
```

---

## Task 2: `serveRuntime()` + refactor `dawn dev` onto it

**Files:**
- Create: `packages/cli/src/lib/dev/serve-runtime.ts`
- Modify: `packages/cli/src/lib/dev/dev-session.ts` (share the boot), `packages/cli/src/index.ts` or `runtime-exports.ts` (export `serveRuntime`)
- Test: `packages/cli/test/serve-runtime.test.ts` (create)

- [ ] **Step 1: Write the failing test** (uses the existing testing harness / a fixture app under `packages/cli/test/fixtures`; find one an existing runtime test already boots):

```ts
import { afterEach, expect, test } from "vitest"
import { serveRuntime } from "../src/lib/dev/serve-runtime.ts"
import { fixtureAppRoot } from "./support/..." // reuse an existing fixture-app helper

let handle: Awaited<ReturnType<typeof serveRuntime>> | undefined
afterEach(async () => { await handle?.close(); handle = undefined })

test("serveRuntime boots the runtime and serves /healthz on the given host/port", async () => {
  handle = await serveRuntime({ appRoot: fixtureAppRoot, host: "127.0.0.1", port: 0 })
  const res = await fetch(`${handle.url}/healthz`)
  expect(res.status).toBe(200)
})
```

- [ ] **Step 2: Run — expect fail** (module missing).

- [ ] **Step 3: Implement `serveRuntime`**

Extract the option-assembly currently in `dev-session.ts` (config load → `discoverRoutes` → `runTypegen` → build registry + checkpointer + threadsStore + `resolveSandboxManager`) into `serveRuntime({ appRoot, host, port, signal? })`. It calls `startRuntimeServer({ …assembledOptions, host, port })` and returns `{ url, close }`. Defaults: `host = process.env.HOST ?? "0.0.0.0"`, `port = Number(process.env.PORT ?? 8000)`. Wire SIGTERM/SIGINT → `close()` (only when serveRuntime owns the process, i.e. from `dawn start`, NOT in the test — gate signal handlers behind an `installSignalHandlers?: boolean` opt, default false; `dawn start` passes true).

Refactor `dev-session.ts` to call the SAME extracted assembly (so dev and start share one boot), keeping dev's `host: "127.0.0.1"` + file-watching + rebuild loop intact. **This must be a no-behavior-change refactor for dev.**

Export `serveRuntime` from the CLI package's public entry (mirror how `startRuntimeServer`/runtime pieces are exported — check `packages/cli/src/index.ts` / `runtime-exports.ts`).

- [ ] **Step 4: Verify**

- `pnpm --filter @dawn-ai/cli test serve-runtime` → pass.
- **Regression:** `pnpm --filter @dawn-ai/cli test dev-command` (and any dev-session tests) → still green (dev unchanged).
- `typecheck`, `lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/serve-runtime.ts packages/cli/src/lib/dev/dev-session.ts packages/cli/src/index.ts packages/cli/test/serve-runtime.test.ts
git commit -m "feat(cli): serveRuntime() shared boot; dawn dev refactored onto it (no behavior change)"
```

---

## Task 3: `dawn start` command

**Files:**
- Create: `packages/cli/src/commands/start.ts`
- Modify: the command registrar (where `dev`/`build` are registered — find it in `packages/cli/src/index.ts` or a `commands` index)
- Test: `packages/cli/test/start-command.test.ts` (create)

- [ ] **Step 1: Failing test** — register the command, run it against a fixture app on port 0 / host 127.0.0.1, assert it serves `/healthz` then shuts down cleanly. Mirror `dev-command.test.ts`'s spawn/teardown pattern (read it first).

- [ ] **Step 2: Run — expect fail.**

- [ ] **Step 3: Implement** — `registerStartCommand(program, io)`: `dawn start` with `--host <host>` and `--port <number>` options (defaults deferred to `serveRuntime`'s env-based defaults). Calls `serveRuntime({ appRoot, host?, port?, installSignalHandlers: true })`, logs the bound url, and keeps the process alive until a signal triggers `close()`. Match the option-parsing + `CommandIo` conventions in `dev.ts`.

- [ ] **Step 4: Verify** — `pnpm --filter @dawn-ai/cli test start-command`, `typecheck`, `lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/start.ts packages/cli/src/index.ts packages/cli/test/start-command.test.ts
git commit -m "feat(cli): dawn start — production serve on 0.0.0.0 (default)"
```

---

## Task 4: build-target seam + `node` target

**Files:**
- Create: `packages/cli/src/lib/build/targets/node.ts`, `packages/cli/src/lib/build/targets/langsmith.ts`, `packages/cli/src/lib/build/targets/index.ts`
- Modify: `packages/cli/src/commands/build.ts` (dispatch over targets), `packages/core/src/types.ts` (`DawnConfig.build.targets`), `packages/cli/src/commands/check.ts` (validate target names)
- Test: `packages/cli/test/build-targets.test.ts` (create)

- [ ] **Step 1: Failing test**

```ts
import { expect, test } from "vitest"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
// build the fixture app into a temp dir with targets ["node","langsmith"], then:
test("node target emits server.mjs importing serveRuntime + a hardened Dockerfile", async () => {
  const { buildDir, appRoot } = await runBuild(fixtureAppRoot, { targets: ["node", "langsmith"] })
  const server = await readFile(join(buildDir, "server.mjs"), "utf8")
  expect(server).toMatch(/serveRuntime/)
  const dockerfile = await readFile(join(appRoot, "Dockerfile"), "utf8") // or .dawn/build/Dockerfile if app Dockerfile exists
  expect(dockerfile).toMatch(/EXPOSE 8000/)
  expect(dockerfile).toMatch(/USER (1000|node)/)
  expect(dockerfile).toMatch(/HEALTHCHECK/)
  // langsmith still emitted:
  await readFile(join(buildDir, "langgraph.json"), "utf8")
})
```

Adapt `runBuild` to however `build.ts` is invoked in existing build tests (search `packages/cli/test` for a build test and reuse its invocation harness).

- [ ] **Step 2: Run — expect fail.**

- [ ] **Step 3: Implement**

- `DawnConfig.build?: { targets?: string[] }` in `packages/core/src/types.ts` (JSDoc it).
- Target modules with a shared shape, e.g. `interface BuildTarget { name: string; emit(ctx: BuildEmitContext): Promise<void> }` where `ctx` carries `{ appRoot, buildDir, manifest, routeEntries }`.
- `langsmith.ts` — move the existing `langgraph.json` + entry emission out of `build.ts` into this target (behavior-identical; the entry `.ts` files + merged config).
- `node.ts` — emit:
  - `.dawn/build/server.mjs`:
    ```js
    import { serveRuntime } from "@dawn-ai/cli"
    await serveRuntime({ appRoot: new URL("../..", import.meta.url).pathname })
    ```
    (Resolve `appRoot` correctly relative to `.dawn/build/server.mjs` — it is two levels up from the file. Verify the path math against the actual build dir layout.)
  - `Dockerfile` (multi-stage), emitted at app root if none exists, else `.dawn/build/Dockerfile` (never clobber a user Dockerfile — check + log which path was used):
    ```dockerfile
    # syntax=docker/dockerfile:1
    FROM node:22-slim AS deps
    WORKDIR /app
    COPY package.json package-lock.json* pnpm-lock.yaml* ./
    RUN npm ci --omit=dev || npm install --omit=dev
    FROM node:22-slim AS run
    WORKDIR /app
    ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000
    COPY --from=deps /app/node_modules ./node_modules
    COPY . .
    RUN dawn build || true
    USER 1000:1000
    EXPOSE 8000
    HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||8000) +'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
    CMD ["node", ".dawn/build/server.mjs"]
    ```
    (Treat this as a starting point; the implementer must make it actually build against the fixture app — adjust lockfile handling, the `dawn build` invocation, and non-root FS perms so the emitted `.dawn/build` is readable by uid 1000. If `RUN dawn build` inside the image is circular/awkward, instead COPY the already-built `.dawn/` from the build context and drop the in-image build.)
- `build.ts` — read `config.build?.targets ?? ["node", "langsmith"]`, dispatch to each target's `emit`.
- `check.ts` — error on unknown target names in `build.targets`.

- [ ] **Step 4: Verify** — `pnpm --filter @dawn-ai/cli test build-targets`; existing `build`/`check` tests still green; `typecheck`, `lint`. If Docker is available locally, actually `docker build` the emitted Dockerfile against the fixture app and confirm it builds (best-effort; the authoritative container proof is the resumed smoke).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/build packages/cli/src/commands/build.ts packages/cli/src/commands/check.ts packages/core/src/types.ts packages/cli/test/build-targets.test.ts
git commit -m "feat(cli): build-target seam + node target (server.mjs + hardened Dockerfile)"
```

---

## Task 5: docs + chart + memory alignment

**Files:**
- Modify: `apps/web/content/docs/sandbox.mdx` (+ the self-host docs page if separate — grep for the `langgraphjs dockerfile` guidance), `apps/web/content/docs/*` deployment page.
- Modify: `charts/dawn-app/values.yaml` / `README.md` (note the dawn-build image + `containerPort: 8000` + `/healthz`).
- Update memory: `project_dawn_self_host_docker`.

- [ ] **Step 1: Docs**

Correct the production/self-host guidance: sandboxed/production apps build via `dawn build` (node target) → the emitted Dockerfile → the runtime server on `0.0.0.0`, serving **both** Agent Protocol (`/threads`) and AG-UI (`/agui/:routeId`). State plainly that the `langgraphjs`/LangSmith path does **not** run the Dawn runtime and therefore does **not** engage the sandbox. Document `dawn start`, `HOST`/`PORT`, and `build.targets`. No banned phrases (`scripts/check-docs.mjs`); any model id gpt-5 family. Run `node scripts/check-docs.mjs` → PASS.

- [ ] **Step 2: Chart note** — confirm/annotate `dawn-app` values so the deployment image is the dawn-build output; nothing structural if the chart already assumes `containerPort: 8000` + `/healthz` (it does — just document the image origin).

- [ ] **Step 3: Memory** — update `/Users/blove/.claude/projects/-Users-blove-repos-dawn/memory/project_dawn_self_host_docker.md`: the langgraphjs-dockerfile guidance is superseded for sandboxed apps by `dawn build`'s node target; add the MEMORY.md pointer line if the hook is new.

- [ ] **Step 4: Commit**

```bash
git add apps/web/content/docs charts/dawn-app
git commit -m "docs: production serve via dawn build node target (AP + AG-UI, 0.0.0.0); langsmith path is sandbox-less"
```

---

## Task 6: Changeset + full verification + PR

**Files:**
- Create: `.changeset/production-build-serve.md`

- [ ] **Step 1: Changeset (PATCH — fixed-group 0.x; a `minor` would force 1.0.0)**

```md
---
"@dawn-ai/cli": patch
"@dawn-ai/core": patch
---

Add a production serve path: `dawn build` now emits a runnable Node/Docker target
(a `server.mjs` over the Dawn runtime + a hardened Dockerfile) alongside the existing
LangSmith `langgraph.json`, and a new `dawn start` command serves it on 0.0.0.0
(HOST/PORT configurable). This is the first server that runs the Dawn runtime in
production — so a deployed app engages the execution sandbox and serves both Agent
Protocol and AG-UI. The langgraphjs/LangSmith path does not run the runtime and does
not engage the sandbox.
```

Confirm the touched publishable set matches `git log --oneline origin/main..HEAD --name-only -- packages/ | grep '^packages/' | cut -d/ -f2 | sort -u` (expect `cli`, `core`).

- [ ] **Step 2: Full local verification**

```
pnpm build && pnpm typecheck && pnpm lint && pnpm test && node scripts/check-docs.mjs && pnpm verify:harness:framework
```

- [ ] **Step 3: Rebase on origin/main, push, open PR, watch CI.** Address advisory-review + CodeQL findings. Confirm the post-merge Version PR reads the next patch (NOT 1.0.0).

- [ ] **Step 4 (separate, after merge):** rebase `feat/sandbox-full-arc-smoke` onto main and finish the full-arc smoke — its Dockerfile/image build now uses `dawn build`'s node target + `dawn start` instead of a bespoke server, and the smoke asserts a deployed app engages the sandbox.

---

## Notes for the executor

- **`dawn dev` must not change behavior** — same localhost bind + watch. The Task-2 refactor is the risk; verify dev tests green.
- **Do not remove `langgraph.json`** — it's a kept target, just relabeled.
- **The container is proven by the resumed smoke**, not this PR — don't block this PR on a full `docker build` unless it's quick locally.
- Branch `feat/production-build-serve`; pin before subagent dispatch; patch changeset only.
