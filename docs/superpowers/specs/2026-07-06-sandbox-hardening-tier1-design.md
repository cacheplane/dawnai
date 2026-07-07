# Sandbox Hardening — Tier 1 (Design)

**Status:** Approved for planning
**Date:** 2026-07-06
**Roadmap:** Phase 4 follow-up to the execution sandbox (PR #289, shipped in 0.8.6). Tier 1 = the container-runtime hardening the initial `dockerSandbox` deliberately left off: capability drop, no-new-privileges, PID limit, read-only root filesystem, **run-as-non-root**, and per-command timeout enforcement.

## Problem

The shipped `dockerSandbox` isolates per thread (fs + exec + network) but runs each container with a weak runtime posture: **full Linux capabilities, root user, writable root filesystem, unbounded PIDs, and no per-command timeout** (`resources.timeoutMs` exists on the type but is never applied). `--cap-drop`, `--security-opt no-new-privileges`, `--pids-limit`, `--read-only`, and `--user` are all absent from the `docker run` in `ensureContainer` (`packages/sandbox/src/docker/docker-sandbox.ts`). For a feature positioned as a "hard boundary for untrusted/multi-tenant," these are table stakes: a hostile agent can currently fork-bomb the host, run privileged-capability operations, mutate the container root fs, and run unbounded-time commands.

This is Tier 1 of a hardening effort: the high-value, in-place runtime hardening that needs no new isolation substrate. (Stronger substrates — gVisor/Kata/microVM providers — remain the provider-agnostic escape hatch, out of scope here.)

## Decisions (from brainstorming)

1. **Hardened by default.** The structural flags are on by default (near-zero breakage). The sandbox shipped one day prior (0.8.6) → effectively no users to break, and pre-1.0 favors the correct default.
2. **Run-as-non-root by default, done properly now** (not deferred/opt-in) via **Architecture B**: no root in the container's steady state.
3. **Per-command timeout: enforce only when set** (`resources.timeoutMs`). A default would break legitimate long installs/builds; explicit opt-in with a clear timeout error is the chosen tradeoff.
4. **Hardening is provider-agnostic policy *intent*, in the contract** (`SandboxPolicy.security`) — NOT Docker-coupled options. Each provider translates intent → mechanism; the posture stays consistent for future providers and is verifiable via conformance.
5. **Prove it adversarially against real Docker** — property/attack-based conformance in the gated `sandbox-docker` lane, not just arg-string unit assertions.

## Design

### 1. Contract: `SandboxPolicy.security` intent (`@dawn-ai/workspace`)

Extend the contract with a provider-agnostic security intent object. `pidsLimit` lives here (it is hardened-by-default, unlike the opt-in `resources` caps). `timeoutMs` stays in `resources` (a quantitative cap, alongside memory/cpu) and simply gets wired.

```ts
// packages/workspace/src/sandbox-types.ts
export interface SandboxSecurityPolicy {
  /** Drop all Linux capabilities. Default true. */
  readonly dropAllCapabilities?: boolean
  /** Block privilege escalation via setuid/setgid. Default true. */
  readonly noNewPrivileges?: boolean
  /** Immutable root filesystem; the workspace + scratch stay writable. Default true. */
  readonly readOnlyRootFilesystem?: boolean
  /** Run the workload as a non-root user. Default true → uid/gid 1000:1000.
   *  `false` runs as the image default (typically root). */
  readonly runAsNonRoot?: boolean | { readonly uid: number; readonly gid: number }
  /** Max process count (fork-bomb defense). Default 512. */
  readonly pidsLimit?: number
}

export interface SandboxPolicy {
  readonly network: /* unchanged */
  readonly env?: Readonly<Record<string, string>>
  readonly resources?: {
    readonly memoryMb?: number
    readonly cpus?: number
    readonly timeoutMs?: number   // per-command wall clock; now ENFORCED when set
  }
  readonly security?: SandboxSecurityPolicy   // NEW
}
```

`SandboxConfig` (author-facing, same file) gains `readonly security?: SandboxSecurityPolicy`. `resolveSandboxManager` (cli) passes `config.security` straight into the built `SandboxPolicy` (like `env`/`resources` today) — no defaulting in the cli.

**Secure-by-default is enforced at the provider**, treating each unset field as its secure default. Rationale: `dockerSandbox` used directly (tests, conformance, non-manager callers) is then hardened without a manager in the loop; the *absence* of `security` means *fully hardened*, and authors relax explicitly.

### 2. Docker translation (`dockerSandbox`)

Resolve the effective posture once per `acquire`, defaulting unset fields:

```ts
const sec = policy.security ?? {}
const dropCaps  = sec.dropAllCapabilities   ?? true
const noNewPriv = sec.noNewPrivileges       ?? true
const readOnly  = sec.readOnlyRootFilesystem ?? true
const pids      = sec.pidsLimit             ?? 512
const user =                                     // undefined → root (image default)
  sec.runAsNonRoot === false ? undefined
  : typeof sec.runAsNonRoot === "object" ? sec.runAsNonRoot
  : { uid: 1000, gid: 1000 }                     // true or unset → default non-root
```

`ensureContainer` (create path) gains, appended to the existing `docker run -d` args:

```
...(dropCaps  ? ["--cap-drop", "ALL"] : [])
...(noNewPriv ? ["--security-opt", "no-new-privileges"] : [])
["--pids-limit", String(pids)]
...(readOnly  ? ["--read-only", "--tmpfs", "/tmp", "--tmpfs", "/run"] : [])
...(user      ? ["--user", `${user.uid}:${user.gid}`, "-e", "HOME=/workspace"] : [])
```

- `/workspace` is a mounted volume → writable regardless of `--read-only`; `/tmp` + `/run` are tmpfs scratch. tmpfs size is bounded by `--memory` when set (tmpfs pages count against the container memory cgroup); an explicit tmpfs size cap is a later refinement.
- `HOME=/workspace` (only when non-root) gives tools a writable, persistent home under the read-only root (npm/git config, caches). Chosen over a tmpfs home for persistence + simplicity.

### 3. Architecture B — non-root with volume ownership (no steady-state root)

A fresh named volume mounts `root:root`; a non-root workload cannot write `/workspace`. Fix with a **create-only, ephemeral, root chown-init** — the *only* root that ever runs, and it takes no agent input:

In `ensureContainer`, on the **create** branch (container absent), when `user` is set:
1. Probe volume existence: `docker volume inspect <volumeName>` (exit 0 = exists).
2. **If the volume is absent** (truly fresh): run the chown-init
   `docker run --rm --user 0:0 -v <vol>:/workspace <image> sh -c 'mkdir -p /workspace && chown <uid>:<gid> /workspace'`.
   Non-zero exit → throw an actionable "Sandbox unavailable: could not initialize workspace ownership … run `dawn check`" error.
3. **If the volume exists** (reattach after container reap/restart): **skip** the chown-init — ownership already correct; a `chown -R` on a populated volume would be wrong and slow.
4. Start the keeper with `--user <uid>:<gid>` (+ the flags from §2).

Every fs op (`dockerFilesystem`) and command (`dockerExec`) then runs as the keeper's non-root user automatically (`docker exec` inherits the run `--user`) — **no per-exec `--user`, and nothing in the live container graph is root.** `release`/`destroy` unchanged. Auditable claim: *nothing in a Dawn sandbox runs as root except a create-time, no-input chown.*

`runAsNonRoot: false` → no `--user`, no chown-init, no `HOME` override (image default, typically root).

### 4. Per-command timeout (`dockerExec`)

Thread the timeout into the exec backend; the provider passes it from policy:

```ts
// docker-sandbox.ts acquire:
exec: dockerExec(docker, container, { timeoutMs: policy.resources?.timeoutMs })
```

When `timeoutMs` is set, wrap the command with coreutils `timeout` **inside the container** so the actual process is killed (client-side `docker exec` abort alone leaves the in-container process running):

```
docker exec <c> timeout <ceil(ms/1000)>s sh -c '<envPrefix><cdPrefix><command>'
```

`timeout` exits `124` on kill → `runCommand` returns that result with `stderr` annotated `Command timed out after <ms>ms (resources.timeoutMs).` (Surfaced as a normal non-zero exit the agent sees — not thrown; consistent with how `runBash` reports failures.) When `timeoutMs` is unset, the command runs exactly as today. `ctx.signal` remains wired for cancel. Filesystem ops are **not** timeout-wrapped (fast + internal; `maxBytes` guards large reads).

### 5. `dawn check`

No new pass required — `collectSandboxErrors` already runs `provider.preflight()`. Add a lightweight config-shape validation for the new `security` fields inside `collectSandboxErrors` (e.g. `pidsLimit` must be a positive integer; `runAsNonRoot` object needs numeric `uid`/`gid`) so misconfig fails at check-time.

## Testing

Two layers, matching the sandbox's existing split.

**Unit (fake `Docker`, no daemon) — `docker-sandbox.unit.test.ts` / `docker-exec` tests:**
- Default `acquire` run args include `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512`, `--read-only --tmpfs /tmp --tmpfs /run`, `--user 1000:1000`, `-e HOME=/workspace`.
- Each opt-out removes exactly its flag(s): `dropAllCapabilities:false`, `readOnlyRootFilesystem:false`, `runAsNonRoot:false` (also drops `--user`/HOME/chown-init), custom `{uid,gid}`, custom `pidsLimit`.
- **Chown-init gating:** volume-absent (inspect fails) + non-root → a `docker run --rm --user 0:0 … chown` is issued before the keeper `run`; volume-present → NO chown-init; `runAsNonRoot:false` → NO chown-init.
- `dockerExec` wraps in `timeout Ns sh -c` iff `timeoutMs` set; exit 124 → annotated stderr; unset → unwrapped.

**Adversarial hardening conformance (REAL Docker, gated `sandbox-docker` lane only):** a new suite (fakeSandbox can't enforce kernel controls, so these are Docker-lane-only, distinct from the cross-provider behavioral conformance which stays as-is and must still pass under hardened defaults):
- Fork bomb (`:(){ :|:& };:` / a bounded process-spawn loop) → hits `--pids-limit`, host unaffected, command fails.
- Write `/etc/passwd` → fails (read-only root); write `/workspace/f` and `/tmp/f` → succeed.
- `id -u` → non-zero (non-root); an attempt to use a dropped capability (e.g. `chown` a root-owned path outside workspace, or `mount`) → denied.
- `sleep 999` with `resources.timeoutMs: 500` → returns exit 124 within a few seconds; a follow-up `ps` shows the process gone (killed in-container, not just client-detached).
- Restart durability + isolation (existing conformance) still green under hardened defaults — proof normal workloads survive.

Local run of the adversarial lane needs a working Docker daemon (`DAWN_TEST_DOCKER=1`); CI ubuntu runners are the authoritative gate (this dev machine's daemon can't pull images).

## Packaging & rollout

- **Changeset: patch** (`@dawn-ai/workspace` types, `@dawn-ai/sandbox` provider, `@dawn-ai/cli` resolve-passthrough). Fixed-group 0.x → patch keeps it off 1.0.0.
- **Docs (`/docs/sandbox`):** document the hardened defaults table, the opt-outs, non-root + `HOME=/workspace`, the timeout, and the guidance: *bake system deps into your image; mutate only your workspace at runtime.* Update the honest-scope section — `deny` network + `cap-drop ALL` + read-only + non-root materially raise the bar, still Docker's boundary (not a microVM); the provider-agnostic `security` intent is what a stronger substrate would satisfy.
- **Rollout:** behavior change ONLY for apps already using `sandbox` (they get hardened automatically). No sandbox config → still zero change.

## Honest scope / breakage (documented)

Hardened defaults **will** break: runtime `apt`/`npm -g`/system-directory writes (read-only + non-root), and images that require root or a specific user. This is correct behavior for a hard boundary. Project-local installs (into `/workspace`) and normal tool use continue to work. Escape hatches: `readOnlyRootFilesystem:false`, `runAsNonRoot:false`, or a custom `{uid,gid}`. The guidance is standard container hygiene.

## Out of scope (later tiers / follow-ups)

- Disk quota (`--storage-opt size=`) — requires xfs+pquota backing storage most Docker installs lack; belongs behind a provider capability probe.
- tmpfs explicit size caps, seccomp/AppArmor profile customization, user-namespace remapping.
- Non-Docker hardened providers (gVisor/Kata/cloud microVM) — the `security` intent is the seam they'd implement.
- The three prior sandbox follow-up chips (idle-reaper turn tracking, offloading-inside-sandbox, name-collision hardening) — independent.

## Risks

- **Non-root breakage surprise** — mitigated by the opt-outs, `HOME=/workspace`, docs, and near-zero current userbase.
- **Chown-init correctness** — must run on true-create only (volume-absence gate), never on reattach; covered by the gating unit tests + the real-Docker restart-durability conformance.
- **`timeout`/`chown` binary availability** — coreutils `timeout` + `chown` are in essentially all base images; the honest-scope note tells authors their image needs a POSIX shell + coreutils (already implied by `sh -c`).
- **Provider-default drift** — defaults live in the provider; a future provider must re-apply the same secure defaults. The adversarial conformance suite is the guardrail (any provider running it must pass hardened).
