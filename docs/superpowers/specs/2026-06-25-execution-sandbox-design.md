# Execution Sandbox (Design)

**Status:** Approved for planning
**Date:** 2026-06-25
**Roadmap:** Phase 4 (Richer Authoring Systems) — the **execution sandbox**: a hard isolation boundary for the agent's workspace (fs + exec + network). Complements tool scoping (PR #261): tool scoping limits *which* tools the model may name; the sandbox bounds *what an allowed tool can actually do*. This is the least-privilege layer eve and flue both have and Dawn is behind on (see `project_competitors_eve_flue`).

## Problem

Dawn's workspace capability gives an agent real `readFile`/`writeFile`/`listDir`/`runBash` against `<appRoot>/workspace/` on the **host**, through pluggable `FilesystemBackend`/`ExecBackend` (`@dawn-ai/workspace`). The path-jail (`workspace-fs.ts`) and the HITL `runBash` permission gate are soft, host-side controls: a determined or prompt-injected agent that runs `runBash("python -c '...'")` executes arbitrary code on the host, with host network and host environment. Tool scoping reduced the *surface*; it explicitly deferred *execution isolation* as "a separate, larger effort." This spec is that effort.

The goal is a **hard boundary suitable for untrusted code / multi-tenant**: the agent's whole workspace — filesystem, shell, network egress — runs inside a real isolated environment, **one per conversation thread**, while Dawn's orchestration (LLM calls, checkpointer, AP server) stays on the trusted host. Dawn is a meta-framework, so it does **not** build an isolation runtime; it defines a provider-agnostic contract and ships one reference integration on Docker.

## Decisions (from brainstorming)

1. **Threat model:** hard boundary for untrusted code / multi-tenant — not just blast-radius reduction. Soft in-process policy is insufficient.
2. **Substrate:** a provider-agnostic `SandboxProvider` contract (Dawn's seam) + **one reference integration on local Docker/Podman** (zero cloud dep, self-hostable, kernel-level isolation, dogfoodable). Cloud/microVM providers (E2B, Daytona, gVisor/Kata) plug in later with no core change.
3. **Boundary scope:** the **whole workspace** — both `ExecBackend` and `FilesystemBackend` target the sandbox; the workspace dir lives inside it, so `readFile`/`writeFile`/`listDir`/`runBash` all operate in the isolated env and the host fs is never touched. Dawn's LLM orchestration/checkpointer stay host-side.
4. **Lifecycle:** **per-thread** (per Agent-Protocol thread). One sandbox per `thread_id`, reused across turns (warm), idle-reaped, destroyed on thread delete. The workspace persists across turns and across server restarts (create-or-reattach).
5. **Network egress:** **allow-by-default + denylist** (configurable to deny+allowlist). Honest caveat (documented): allow mode protects the host and other tenants but does **not** stop an agent exfiltrating *its own* sandbox's data; the sandbox is not a data-loss-prevention boundary.
6. **Architecture:** Approach A — the provider yields per-thread fs+exec backends; the existing workspace capability consumes them unchanged. (Rejected: backend middleware — no thread/lifecycle context; and host-mounted volume + exec-only — touches the host fs, contradicting decision 3.)
7. **Honest scope:** it is Docker's boundary (not a microVM); the `allow`-mode denylist is best-effort in the Docker reference; tool *surface* is governed by tool scoping, not the sandbox. We do not over-claim.

## Naming (DX audit, 2026-06-25)

`dawn.config.ts` is a plain `export default {}` object (tsx-evaluated; `core/config.ts:22-40`). There is **no** `defineConfig`. We add, as part of this work, a typed identity helper named **`config()`** (not `defineConfig`) following the `agent()` (`sdk/agent.ts:57`) precedent — for IntelliSense on the config object; the plain object stays valid. Provider factories follow the `localExec`/`localFilesystem` convention: **`dockerSandbox()`** and the test double **`fakeSandbox()`** (a matched `docker`/`fake` pair). The config key is a plain **`sandbox`** (like `permissions`, `summarization`, `memory`). Type names: `SandboxProvider`, `SandboxHandle` (matches the existing `DevServerHandle`/`AimockHandle` family), `SandboxPolicy`, `SandboxConfig`. The broader `define*` → bare-noun rename (`defineMemory`/`defineEval`/`defineMiddleware`) is **out of scope** — a separate API-naming pass (`eval()` collides with the JS builtin; renaming shipped exports is breaking).

## Design

### 1. The contract (`@dawn-ai/sandbox`)

New package `@dawn-ai/sandbox` ships the contract + the Docker reference + (under a `/testing` subpath) `fakeSandbox` and a conformance kit. The author-facing **types** live where they avoid a dependency cycle: `SandboxConfig` (referenced by `DawnConfig`) and the contract types go in a types-only location reachable by `@dawn-ai/core`'s `DawnConfig` without `core` depending on `@dawn-ai/sandbox` (mirror the `ToolScope`-in-sdk / `DawnConfig`-in-core precedent; the plan pins exact placement and verifies no cycle). The impl (`dockerSandbox`, `fakeSandbox`) lives in `@dawn-ai/sandbox`.

```ts
import type { ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"

export interface SandboxProvider {
  readonly name: string                       // diagnostics + `dawn check`

  /** Create-or-reattach the thread's sandbox. Idempotent per threadId: called at
   *  the start of EVERY turn; returns the same live sandbox across turns until
   *  release()/destroy(). Provisions the workspace volume + applies the network
   *  policy. After a server restart or container reap, reattaches the existing
   *  volume by deterministic name rather than starting empty. */
  acquire(input: {
    readonly threadId: string
    readonly policy: SandboxPolicy
    readonly signal: AbortSignal
  }): Promise<SandboxHandle>

  /** Drop the warm compute (e.g. stop/remove the container) but KEEP the
   *  workspace volume so a later acquire() reattaches it. Idle-reap + shutdown. */
  release(threadId: string): Promise<void>

  /** Destroy the sandbox AND its workspace volume — full teardown. Thread delete. */
  destroy(threadId: string): Promise<void>

  /** Optional availability probe surfaced by `dawn check`. */
  preflight?(): Promise<{ readonly ok: boolean; readonly detail?: string }>
}

export interface SandboxHandle {
  readonly threadId: string
  readonly filesystem: FilesystemBackend   // the existing @dawn-ai/workspace interfaces —
  readonly exec: ExecBackend               // the workspace capability consumes them unchanged
  readonly workspaceRoot: string           // path INSIDE the sandbox, e.g. "/workspace"
}

export interface SandboxPolicy {
  readonly network:
    | { readonly mode: "allow"; readonly denylist?: readonly string[] }
    | { readonly mode: "deny";  readonly allowlist?: readonly string[] }
  readonly env?: Readonly<Record<string, string>>   // explicit; host env is NEVER inherited
  readonly resources?: { readonly memoryMb?: number; readonly cpus?: number; readonly timeoutMs?: number }
}

export interface SandboxConfig {
  readonly provider: SandboxProvider
  readonly network?: SandboxPolicy["network"]        // default { mode: "allow", denylist: [metadata ip] }
  readonly env?: SandboxPolicy["env"]
  readonly resources?: SandboxPolicy["resources"]
  readonly idleTimeoutMs?: number                    // manager-level; default 600_000
}
```

**Key reuse:** `SandboxHandle.filesystem`/`exec` implement the existing `FilesystemBackend`/`ExecBackend`. `workspace-fs.ts`'s `createWorkspaceFs` dispatches every op to `opts.backend.<method>()`, and the workspace capability (`built-in/workspace.ts:125-126`) already takes `context.backends?.filesystem ?? localFilesystem()`. So swapping the backend inputs redirects all of `readFile`/`writeFile`/`listDir`/`runBash` with **no change to the capability**. The handle's `workspaceRoot` is the in-sandbox path; the capability's existing path-jail resolves agent paths against it (defense-in-depth on top of the container).

### 2. `SandboxManager` (per-thread lifecycle)

A new runtime singleton (the only stateful new piece), constructed once per server in `createRuntimeRequestListener` (`runtime-server.ts:54-76`) alongside `threadsStore`/`checkpointer`, from `dawn.config.sandbox`. If no `sandbox` config, the manager is absent and the runtime falls through to today's local backends.

- **State:** `Map<threadId, { handle?, acquiring?: Promise<SandboxHandle>, lastUsedAt, inUse }>`.
- **`getForThread(threadId, policy, signal)`:** live handle → bump `lastUsedAt`/`inUse`, return; else `provider.acquire(...)`. Concurrent turns on the same thread share one in-flight `acquiring` promise (dedup → one sandbox); different threads acquire independently.
- **Idle reaper:** a `setInterval` (net-new; precedent = the shutdown-drain loop at `runtime-server.ts:117-132`) calls `provider.release(threadId)` for handles idle past `idleTimeoutMs` and not `inUse` — drops the warm container, **keeps the volume**. Cleared on server `close()`.
- **Release triggers:** (1) idle-reap → `release`; (2) server shutdown `close()` (`runtime-server.ts:107-133`) → `release` all (best-effort); (3) AP `DELETE /threads/:id` (`runtime-server.ts:268-285`) → **`destroy`** (container + volume).
- **Failure semantics:** an `acquire` failure (Docker down, image missing, OOM) is **not cached** — it rejects the current turn with an actionable error; the next turn retries cleanly. The manager never hands the capability a half-dead handle.

### 3. Runtime wiring

The integration is at the backend-construction site, not inside the capability.

- **Thread-id plumbing (the one structural change).** `prepareRouteExecution` (`execute-route.ts:~371`) currently does **not** receive `threadId`, though its callers `streamResolvedRoute`/`executeResolvedRoute` do (`:248`). Thread `threadId` (and a handle to the `SandboxManager`) **into** `prepareRouteExecution` — the same plumbing applied for `isSubagent` in tool scoping (TS3). The manager is passed from the route table (built with the singletons in `createRuntimeRequestListener`) through the run handlers into `streamResolvedRoute`/`executeResolvedRoute`.
- **Per-turn resolution.** When a `SandboxManager` is present, before constructing the workspace backends: `handle = await manager.getForThread(threadId, policy, signal)`, then use `handle.filesystem`/`handle.exec` and `workspaceRoot = handle.workspaceRoot` everywhere the local defaults are used today — `createWorkspaceFs` (`execute-route.ts:491-497`), the `applyCapabilities` `backends` context (`:548-556`), the `ctx.fs` tool injection (`:661-669`), and the offload store (`:~1091`). The capability logic is unchanged; only its inputs swap.
- **No `thread_id` (e.g. a direct non-AP invocation):** fall through to local backends + host workspace. Sandboxing requires the AP thread lifecycle.
- **Subagents inherit the thread's sandbox.** A subagent dispatch is a recursive `executeResolvedRoute` under the same `thread_id` + same manager → it resolves the *same* handle. The coordinator and its subagents share one isolated env per conversation (correct — they're one logical agent).
- **Composes with existing guards.** The path-jail still resolves agent paths against `workspaceRoot` (now in-sandbox); the HITL `runBash` gate still fires; tool scoping still filters the surface. Three orthogonal layers stack.

### 4. Config surface + `config()` helper

```ts
// dawn.config.ts — plain object stays valid; config() adds IntelliSense
import { config } from "@dawn-ai/cli"          // typed identity helper (new)
import { dockerSandbox } from "@dawn-ai/sandbox"

export default config({
  sandbox: {
    provider: dockerSandbox({ image: "node:22-slim" }),
    network: { mode: "allow", denylist: ["169.254.169.254", "metadata.google.internal"] },
    env: { NODE_ENV: "production" },     // injected explicitly; host env is NOT inherited
    resources: { memoryMb: 512, cpus: 1, timeoutMs: 120_000 },
    idleTimeoutMs: 600_000,
  },
})
```

- **`config(c: DawnConfig): DawnConfig`** — pure identity for IDE autocomplete, modeled on `agent()` (`sdk/agent.ts:57`). Exported from `@dawn-ai/sdk` and re-exported from `@dawn-ai/cli` (the import authors already use). The loader (`core/config.ts:22-40`) is unchanged — it reads `mod.default`, so a wrapped or bare object both work.
- **`DawnConfig.sandbox?: SandboxConfig`** added to `core/types.ts:9-80` (the 10th key), consistent with the existing optional nested keys.
- **Defaults** (manager-applied): `network: { mode: "allow", denylist: ["169.254.169.254"] }` (the cloud-metadata endpoint, the classic SSRF egress target, denied even in allow mode), `idleTimeoutMs: 600_000`, conservative `resources` caps.
- **`dawn check`** gains a sandbox pass (mirror `collectToolScopeErrors`, `check.ts:45-48`): validate the `sandbox` config shape and run `provider.preflight?.()` (e.g. "is the Docker daemon reachable / image pullable?") so misconfig fails at check-time, not mid-run.

### 5. Docker reference provider (`dockerSandbox`)

Shells out to the `docker` CLI via the existing `spawnProcess` helper — **no new runtime dependency** (Docker must be installed regardless).

- **`acquire`** — container `dawn-sbx-<threadId>`, named volume `dawn-sbx-vol-<threadId>` mounted at `/workspace` (workdir), labeled `dawn.sandbox=<threadId>`. Lookup by name: running → reattach; stopped → `start`; absent → `docker run -d` with the image, the volume, `--memory`/`--cpus`, a **clean env** (only `policy.env`, never the host's), the network policy, and a `sleep infinity` entrypoint so the container persists for `exec` across turns.
- **`SandboxHandle.filesystem`** — a `FilesystemBackend` whose ops are `docker exec` calls: `readFile`→`cat` (size-capped via `maxBytes`), `writeFile`→piped `cat >`, `listDir`→`ls`, `realPath`→`realpath`, plus optional `stat/remove/touch/mkdir` (all required for offload GC, which routes through the same backend). `workspaceRoot = "/workspace"`.
- **`SandboxHandle.exec`** — `runCommand` → `docker exec <c> sh -c '<command>'` with cwd/env, capturing stdout/stderr/exit, killing on `signal` abort.
- **`release`** — `docker rm -f <container>` (volume kept). **`destroy`** — `docker rm -f` + `docker volume rm`.
- **`preflight`** — daemon reachable + image present/pullable.
- **Orphan sweep** — on manager init, `docker ps -aq --filter label=dawn.sandbox` reaps containers whose threads are unknown to the live `threadsStore`, so crashes don't leak containers.

**Network enforcement (honest limitation):** `mode:"deny"` → `--network none` (exact, zero egress). `mode:"allow"` → default bridge; the **denylist is best-effort** — true per-host egress filtering needs an in-container iptables rule (NET_ADMIN) or an egress-proxy sidecar; the reference injects an iptables rule when the container has the capability, else **logs a clear warning that the denylist is unenforced**. The *contract* supports full allow/deny lists; a cloud/microVM provider with native egress rules implements them fully.

**Perf:** each fs op is one `docker exec` round-trip (tens of ms); acceptable, and offloading already curbs large reads. Batching is a later optimization.

## Authoring examples

```ts
// Strict tenant: no egress, tight caps
export default config({
  sandbox: { provider: dockerSandbox({ image: "python:3.12-slim" }), network: { mode: "deny" },
    resources: { memoryMb: 256, cpus: 0.5, timeoutMs: 60_000 } },
})
```

```ts
// Later, swap to a cloud microVM provider — nothing else changes
export default config({ sandbox: { provider: e2bSandbox({ apiKey: process.env.E2B_KEY! }) } })
```

## Error handling / edge cases

- **Docker down / image missing at runtime** → `acquire` rejects with an actionable error ("Sandbox unavailable: Docker daemon not reachable — run `dawn check`"); not cached; retried next turn.
- **Container crash / OOM mid-thread** → the named volume outlives the container, so the next turn's `acquire` recreates the container and reattaches the volume — **workspace state survives**; only in-flight work is lost. A non-zero `exec` is a normal failed command the agent sees.
- **Server restart** → in-memory manager map is gone but the conversation checkpoint survives (SQLite); `acquire` reattaches `dawn-sbx-vol-<threadId>` by name — the agent's files survive the restart, matching its conversation.
- **Idle reaper safety** → never reaps an `inUse` (mid-turn) handle; only truly idle; `release` keeps the volume so a later turn restores the workspace.
- **`release`/`destroy` failure** → logged, best-effort; the startup orphan sweep is the backstop.
- **Abort/cancel** → `signal` kills the in-flight `docker exec`; the container stays warm.

## Testing

Mirrors Dawn's "real-thing-but-gated" discipline (aimock, Verdaccio). Default `validate` stays **Docker-free**.

1. **`fakeSandbox()` (in-memory)** — a `SandboxProvider` over an in-memory `FilesystemBackend` (`Map`) + scripted `ExecBackend`. Lets the **`SandboxManager` lifecycle** (per-thread keying, concurrent-acquire dedup, idle-reap = release-not-destroy, destroy-on-delete, create-or-reattach) be unit-tested deterministically. The bulk of the new logic; 100% CI-safe.
2. **Provider conformance kit** — a reusable suite any provider must pass (`acquire` idempotent-per-thread, reattach returns the same workspace, `release` keeps the volume / `destroy` removes it, fs round-trips, `exec` exit codes, abort). Run against `fakeSandbox` in CI and real Docker in the gated lane → the fake can't silently drift from the contract.
3. **Gated real-Docker lane** — a dedicated `sandbox-docker` CI job (GitHub ubuntu runners ship Docker), **not** part of `validate`: the conformance kit + an e2e (file written inside survives a turn, `runBash` runs isolated, `network:"deny"` blocks egress via a failing `curl`, host fs untouched, restart reattaches). Locally gated by `DAWN_TEST_DOCKER`/daemon-detection.
4. **Wiring e2e via `@dawn-ai/testing` + `fakeSandbox`** — an aimock agent run with `sandbox.provider = fakeSandbox()` asserting `writeFile`/`readFile`/`runBash` route through the handle (not `localExec`), per-thread isolation, and a subagent sharing the thread's sandbox. Proves §3 wiring **without Docker**.

So lifecycle + wiring are fully covered Docker-free in `validate`; the real boundary is verified in the separate Docker lane; the conformance kit keeps the fake honest.

## Packaging & rollout

- **New package `@dawn-ai/sandbox`** (fixed group → versions with the rest). Exports contract types, `dockerSandbox`; `@dawn-ai/sandbox/testing` exports `fakeSandbox` + the conformance kit. **GOTCHA 1 (new-package OIDC bootstrap):** the first publish needs the one-time manual `npm publish` + trusted-publishing config — same as `@dawn-ai/memory` at 0.8.3 (`project_release_harness_workspace_dep`). Call it out at release.
- **`@dawn-ai/sdk`** — add `config()`; place the `SandboxConfig`/contract types to avoid a `core`↔`sandbox` cycle (plan pins exact location).
- **`@dawn-ai/core`** — `DawnConfig.sandbox?`.
- **`@dawn-ai/cli`** — `SandboxManager`, the `threadId`→`prepareRouteExecution` plumbing, the `DELETE`→`destroy` + shutdown→`release` hooks, the idle reaper, re-export `config()`, and the `dawn check` pass.
- **No default-scaffold change** — sandbox is opt-in, not in the `create-dawn-ai-app` template, so `SCAFFOLD_PACKAGES` is untouched (the Verdaccio harness publishes the whole workspace, so the new package is covered; wiring tests use `fakeSandbox`, never npmjs).
- **Changeset — GOTCHA 6:** a feature + new package is semantically `minor`, but a `minor` in the fixed 0.x group forces the group to **1.0.0**. To stay pre-1.0 ship it as **`patch`** (the tool-scoping precedent, #268). Surface this explicitly at the changeset step.
- **Docs** — new `apps/web/content/docs/sandbox.mdx` (+ nav): config, the `config()` helper, the threat-model framing, and the honest-scope section verbatim.
- **Rollout** — opt-in, default off, **zero behavior change** without `sandbox` config.

## Honest scope (ships in docs verbatim)

- **IS:** per-thread kernel-level fs/process isolation; host fs never touched; host env never leaked; CPU/mem/wall-time caps; multi-tenant separation by thread; `network:"deny"` = zero egress; workspace survives turns, restarts, and container crashes.
- **IS NOT:** a guarantee against container-escape 0-days (Docker's boundary, not a microVM — that's why the seam is provider-agnostic; a gVisor/Kata/cloud-microVM provider is the stronger drop-in); the `allow`-mode denylist is best-effort in the Docker reference; it does **not** stop an agent exfiltrating *its own* sandbox's data under `allow` mode. Tool *surface* is tool scoping's job, not the sandbox's.
- **Framing:** "Dawn ships the isolation *seam* + a Docker reference; for hostile-grade multi-tenant, plug a microVM-backed provider."

## Out of scope (later)

- Cloud/microVM provider integrations (E2B, Daytona, gVisor/Kata) — the contract supports them; reference is Docker only.
- Full host-level egress enforcement in the Docker reference (proxy sidecar / guaranteed iptables) — best-effort + warning for v1.
- Per-tool sandbox policies, per-thread resource autoscaling, snapshot/restore of volumes, image build from the app.
- The broader `define*` → bare-noun API rename (separate naming pass).
- Channels ingress, blueprint system (separate Phase-4 sub-projects).

## Risks

- **Thread-id plumbing** must reach `prepareRouteExecution` correctly for top routes *and* recursive subagent dispatch (so subagents share the thread's sandbox). Covered by the wiring e2e + the `isSubagent` precedent.
- **Backends are captured per route-prep, not per-op** — fine because the handle is resolved per turn before prep and a thread reuses one sandbox; verified by the per-thread isolation test.
- **Idle-reap vs in-flight** — the `inUse` guard must be correct or a mid-turn container could be reaped; covered by a lifecycle unit test.
- **Denylist over-claim** — must be framed as best-effort in the Docker reference; deny mode is the exact guarantee.
- **Offload store** routes through the same backend — the Docker filesystem backend must implement `stat/remove/touch/mkdir` or offload GC breaks; covered by the conformance kit.
