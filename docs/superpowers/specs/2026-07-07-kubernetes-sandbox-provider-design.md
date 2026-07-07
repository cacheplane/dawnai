# Kubernetes Sandbox Provider — Design

**Date:** 2026-07-07
**Status:** Approved (brainstorm)
**Sub-project:** 1 of 3 in the "Run Dawn on Kubernetes" arc (provider → sandbox-infra Helm chart → app-deploy Helm chart).

## Goal

A `kubernetesSandbox` provider that implements the existing `SandboxProvider` contract by running each conversation thread's workspace as a Kubernetes **Pod** (with a per-thread **PersistentVolumeClaim** for the durable `/workspace`), instead of a Docker container + named volume. It carries the shipped Tier-1 hardening (`SandboxPolicy.security`) across to the Pod SecurityContext, and is the foundation the later Helm charts secure and deploy.

## Context

- The execution sandbox (PR #289, 0.8.6) defined a provider-agnostic contract: `SandboxProvider` with `acquire` (create-or-reattach per `threadId`), `release` (keep the durable volume), `destroy` (remove it), optional `preflight` (surfaced by `dawn check`). Types live in `@dawn-ai/workspace` (`SandboxProvider`/`SandboxPolicy`/`SandboxHandle`/`SandboxConfig`).
- The Docker reference `dockerSandbox` (in `@dawn-ai/sandbox`) talks to Docker through a narrow **injectable CLI wrapper** (`Docker`), with `dockerExec`/`dockerFilesystem` layered on top, a `fakeDocker` for unit tests, and a gated `sandbox-docker` CI lane against real Docker.
- Sandbox hardening tier 1 (PR #309, 0.8.8) added `SandboxPolicy.security` (a provider-agnostic intent: `dropAllCapabilities`, `noNewPrivileges`, `readOnlyRootFilesystem`, `runAsNonRoot`, `pidsLimit`), hardened-by-default at the provider. The whole point of expressing it as intent (not Docker flags) was so a second provider could satisfy the same fields against a different mechanism — this is that second provider.
- Lifecycle orchestration lives in the CLI's `SandboxManager` (idle-reaper → `release`, thread-DELETE → `destroy`, shutdown → `releaseAll`). It only calls contract methods, so it drives any provider unchanged.

## Decisions (from the brainstorm)

- **Goal:** integrated "run Dawn on Kubernetes" story, decomposed into 3 sub-projects; **this spec is sub-project 1 (the provider) only.**
- **Topology:** support both in-cluster (mounted ServiceAccount token) and out-of-cluster (kubeconfig), auto-detected; **in-cluster is the documented production path.**
- **Transport:** official `@kubernetes/client-node` as the default implementation of a narrow injectable `KubeClient` seam; faked in unit tests.
- **Persistence:** one dynamically-provisioned **PVC per thread** (`ReadWriteOnce`), the faithful analog of the Docker named volume.
- **Hardening:** reuse the `SandboxPolicy.security` intent verbatim; map to Pod SecurityContext; **`fsGroup` replaces Architecture B** (no chown-init, no ephemeral root); default `seccompProfile: RuntimeDefault`; `pidsLimit` explicitly delegated to the chart's LimitRange (no pod-level field).
- **Networking:** provider emits a per-thread NetworkPolicy for `deny`/`allow`; `preflight` warns when the CNI won't enforce it; the sub-project-2 chart backstops with a namespace default-deny.

## Architecture

### Package & the client seam

Ships **inside `@dawn-ai/sandbox`** (no new package to bootstrap-publish), under `packages/sandbox/src/kubernetes/`, mirroring `src/docker/`:

- `kube-client.ts` — the `KubeClient` interface + its default `@kubernetes/client-node` implementation.
- `kube-exec.ts` — `kubeExec(client, ns, pod, container, { timeoutMs })` → `ExecBackend`; ports `dockerExec` (env-key validation, `shellQuote`, in-container `timeout` wrapping, exit-124 annotation) onto the K8s exec API.
- `kube-filesystem.ts` — `kubeFilesystem(...)` → `FilesystemBackend`; read/write/list over `exec` (`cat`/`tee`/`base64`), a direct port of `dockerFilesystem`.
- `kube-sandbox.ts` — `kubernetesSandbox(opts)` provider (lifecycle).

`@kubernetes/client-node` is added as a `@dawn-ai/sandbox` dependency (it was previously dep-free apart from `@dawn-ai/workspace`).

**`KubeClient`** — the narrow seam (only what the provider needs):

```ts
export interface KubeClient {
  readNamespacedPodStatus(ns: string, name: string): Promise<PodStatus | null> // null = 404
  createNamespacedPod(ns: string, spec: PodSpecInput): Promise<void>
  deleteNamespacedPod(ns: string, name: string): Promise<void>
  createNamespacedPVCIfAbsent(ns: string, spec: PVCSpecInput): Promise<void>
  deleteNamespacedPVC(ns: string, name: string): Promise<void>
  upsertNamespacedNetworkPolicy(ns: string, spec: NetworkPolicyInput): Promise<void>
  deleteNamespacedNetworkPolicy(ns: string, name: string): Promise<void>
  exec(ns: string, pod: string, container: string, argv: readonly string[],
       opts: { stdin?: string; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; exitCode: number }>
  // capability probes for preflight:
  canI(ns: string, verb: string, resource: string): Promise<boolean>
  networkPolicyEnforced(ns: string): Promise<boolean | "unknown">
}
```

The default impl calls `KubeConfig.loadFromDefault()` (auto-detects in-cluster SA token vs `~/.kube/config`) and uses the client's `Exec` for streaming. Unit tests inject a `fakeKubeClient` (in-memory pod/PVC/NetworkPolicy registry), exactly like `fakeDocker`.

### Per-thread lifecycle

Naming is deterministic and label-driven:
- Pod `dawn-sbx-<threadId>`, PVC `dawn-sbx-vol-<threadId>`, NetworkPolicy `dawn-sbx-net-<threadId>`.
- Labels on every object: `app.kubernetes.io/managed-by: dawn`, `dawn.sh/thread: <threadId>` (the selector used for reattach and orphan sweeps).
- Pod = a single **keeper container** running `sleep infinity`, image = `opts.image`, PVC mounted at `/workspace` (`ROOT`), emptyDir mounts for `/tmp` and `/run` (writable under the read-only rootfs).

`acquire({ threadId, policy, signal })`:
1. `createNamespacedPVCIfAbsent` (size `resources.diskGb` default 1Gi, `storageClass` or cluster default, `ReadWriteOnce`).
2. `readNamespacedPodStatus`. `Running` → reattach. `null` (absent) → `createNamespacedPod` then **wait for Running/Ready** (poll `readNamespacedPodStatus` under `signal`, bounded by `startupTimeoutMs`). `Failed`/`Succeeded`/`Unknown` → delete + recreate.
3. If `network` non-default → `upsertNamespacedNetworkPolicy`.
4. Return `SandboxHandle { threadId, filesystem: kubeFilesystem(...), exec: kubeExec(..., { timeoutMs: policy.resources?.timeoutMs }), workspaceRoot: "/workspace" }`.

`release(threadId)` → `deleteNamespacedPod` (+ delete NetworkPolicy); **PVC kept**.
`destroy(threadId)` → delete Pod, NetworkPolicy, **and PVC**.
`preflight()` → `canI(create pods)` + API reachability + `networkPolicyEnforced` probe → `{ ok, detail }` (surfaced by `dawn check`).

Orchestration is unchanged: the existing `SandboxManager` drives this provider as-is.

**Orphan safety:** an orchestrator crash can leak Pods/PVCs. The provider exposes a label-scoped sweep the manager/shutdown path can call (delete pods with `managed-by=dawn` whose threads are gone); PVCs are deliberately *not* auto-swept (data durability), documented as an operator concern the sub-project-2 chart addresses with a reaper CronJob.

### Hardening → SecurityContext

The `SandboxPolicy.security` intent maps onto Pod/container SecurityContext (secure-by-default at the provider, per-flag opt-out, identical semantics to Docker):

| `security` intent | Kubernetes mechanism |
|---|---|
| `dropAllCapabilities` (default on) | `container.securityContext.capabilities.drop: ["ALL"]` |
| `noNewPrivileges` (default on) | `container.securityContext.allowPrivilegeEscalation: false` |
| `readOnlyRootFilesystem` (default on) | `container.securityContext.readOnlyRootFilesystem: true` + emptyDir `/tmp`,`/run` |
| `runAsNonRoot` (default 1000:1000) | `runAsNonRoot: true` + `runAsUser`/`runAsGroup` + **`fsGroup` + `fsGroupChangePolicy: OnRootMismatch`** (kubelet chowns the PVC — replaces Architecture B) |
| `pidsLimit` | **no pod field** — delegated to the chart's LimitRange; provider surfaces this honestly rather than silently dropping |
| `resources.memoryMb`/`cpus` | `container.resources.limits.memory`/`cpu` |
| `resources.timeoutMs` | unchanged — in-container `timeout` via `kubeExec` |
| (new default) | `seccompProfile.type: RuntimeDefault` |

`runAsNonRoot: false` opt-out → omit the user/fsGroup fields (runs as the image default). Custom `{ uid, gid }` → those values for user/group/fsGroup.

### Networking

- `network.mode: "deny"` → per-thread NetworkPolicy selecting the pod label, empty egress **except** a DNS carve-out (UDP/TCP 53 to kube-dns) so name resolution still works; everything else denied.
- `network.mode: "allow"` with `allowlist` → egress rules to the listed CIDRs/ports (deny the rest); bare `allow` (no list) → no policy (open), matching Docker's allow-mode baseline.
- Enforcement depends on a policy-capable CNI (Calico/Cilium). `preflight()` reports `networkPolicyEnforced` and `dawn check` **warns** when it can't be confirmed — the same honest-scope posture as Docker's best-effort allow-mode denylist.
- RBAC: needs `networkpolicies: create/delete` (granted by the sub-project-2 chart's ServiceAccount).

### Config surface

```ts
sandbox: {
  provider: kubernetesSandbox({
    image: "node:22-slim",
    namespace: "dawn-sandboxes",   // default; the chart creates it
    storageClass: undefined,        // undefined ⇒ cluster default StorageClass
    startupTimeoutMs: 60_000,       // wait-for-Running bound
  }),
  security: { /* Tier-1 intent, unchanged */ },
  network: { mode: "deny" },
  resources: { memoryMb: 512, cpus: 1, timeoutMs: 120_000, diskGb: 1 },
}
```

`diskGb` is a new optional `resources` field (PVC size); additive — Docker ignores it.

### Validation

`collectSandboxErrors` gains K8s-shape checks: `namespace` is a valid DNS-1123 label; `startupTimeoutMs`/`diskGb` positive; plus the `preflight()` reachability + RBAC + CNI probe as errors/warnings (mirrors the Docker preflight pass).

## Testing

Three layers, mirroring `dockerSandbox`:

1. **Unit** — `fakeKubeClient` (in-memory registry): lifecycle, create-or-reattach, SecurityContext/`fsGroup` wiring, NetworkPolicy emission, naming/labels, timeout wrapping, opt-out paths. No cluster.
2. **Provider conformance** — the existing `runProviderConformance` kit runs against `kubernetesSandbox` unchanged (contract-level).
3. **Gated real-cluster lane** — new CI job `sandbox-k8s` (gated like `sandbox-docker`): spin up **kind + Calico** (so NetworkPolicy is enforced), run adversarial conformance — workspace durability across `release`→reattach, PVC survives pod deletion, non-root `id -u`=1000, `/etc` write blocked while `/workspace`+`/tmp` writable, `resources.timeoutMs` exit 124, and egress-deny actually blocks a network call.

## Honest scope

- Kubernetes Pod isolation, not a microVM — same boundary class as the Docker provider (a `runsc`/Kata RuntimeClass is a future stronger substrate, orthogonal to this).
- NetworkPolicy egress control is only as strong as the cluster's CNI; the provider detects and reports, it does not guarantee.
- `pidsLimit` is not enforced by this provider alone — it becomes the chart's LimitRange (sub-project 2).
- PVC orphans are an operator concern (durability-over-auto-cleanup), addressed by the chart's reaper.

## Out of scope (later sub-projects / future)

- The sandbox-infra Helm chart (namespace, RBAC/SA, default-deny NetworkPolicy, ResourceQuota/LimitRange, Pod Security Standards, PVC reaper) — **sub-project 2**.
- The Dawn-app deployment Helm chart (Deployment/Service/Ingress, in-cluster wiring) — **sub-project 3**.
- Stronger RuntimeClass substrates (gVisor/Kata), horizontal autoscaling, multi-namespace tenancy.
