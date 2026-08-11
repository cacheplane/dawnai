# Execution Sandbox

The execution sandbox gives each Agent-Protocol conversation thread a hard-isolated workspace — filesystem, shell, and network — instead of the local `<appRoot>/workspace/` directory the agent otherwise reads and writes on the host. It's opt-in: add a `sandbox` key to `dawn.config.ts` and every `readFile`, `writeFile`, `listDir`, and `runBash` call for that thread routes into the isolated environment through a provider-agnostic `SandboxProvider` contract. Dawn ships a Docker reference implementation.

This is a distinct layer from the other two access controls in Dawn: [tool scoping](/docs/tools) decides *which* tools the model may call; [permissions](/docs/permissions) decide *whether a given call should run* (human-in-the-loop approval); the sandbox decides *what an allowed, approved call can actually touch*. The three compose — none of them substitutes for the others.

## Quickstart

Docker must be installed and the daemon running. Configure a provider in `dawn.config.ts` using the typed `config()` helper (a bare object still works — `config()` is pure identity for IntelliSense):

```ts title="dawn.config.ts"
import { config } from "@dawn-ai/cli"
import { dockerSandbox } from "@dawn-ai/sandbox"

export default config({
  sandbox: {
    provider: dockerSandbox({ image: "node:24-slim" }),
    network: { mode: "allow", denylist: ["169.254.169.254"] },
    env: { NODE_ENV: "production" },
    resources: { memoryMb: 512, cpus: 1, timeoutMs: 120_000 },
    idleTimeoutMs: 600_000,
  },
})
```

No `sandbox` key means no behavior change — the app keeps using the local `workspace/` directory exactly as before.

`dawn check` validates the `sandbox` config shape and runs the provider's `preflight()` — for `dockerSandbox`, that means confirming the Docker daemon is reachable — so a misconfiguration or a stopped daemon fails at check time instead of mid-run.

## What's isolated

- **Filesystem** — `readFile`, `writeFile`, and `listDir` operate inside the sandbox's workspace volume. The host filesystem is never touched.
- **Shell** — `runBash` executes inside the sandbox, still gated by the [permissions](/docs/permissions) allow/deny lists.
- **Network** — governed by the configured [network policy](#network-policy); the exact `deny` enforcement depends on the provider.
- **Environment** — the host's environment variables are never inherited. Only the key/value pairs in `sandbox.env` are injected into the sandbox.
- **Resources** — `resources.memoryMb` and `resources.cpus` cap the sandbox's memory and CPU; `resources.timeoutMs` caps how long a single exec call may run.

## Lifecycle

One sandbox is created per conversation thread, on that thread's first turn. It stays warm and is reused across every subsequent turn on the same thread — the agent isn't paying container start-up cost on every message.

- **Persistence** — the workspace (a named volume) survives across turns, across a container being idle-reaped, and across a full server restart. On the next turn, the provider reattaches the existing volume by its deterministic name rather than starting from an empty workspace.
- **Idle reap** — a thread with no activity for `idleTimeoutMs` (default 10 minutes) has its warm container released. The volume is kept, so the next turn on that thread reattaches it with all files intact.
- **Thread delete** — an Agent-Protocol `DELETE` on the thread destroys the sandbox *and* its volume. This is the only operation that discards the workspace permanently.

Turn trace: turn 1 on a new thread → no live sandbox → `acquire()` creates the container and volume. Turns 2..N on the same thread → the same live sandbox is reused. Thread idle past `idleTimeoutMs` → container released, volume kept. Next turn after that → `acquire()` reattaches the existing volume into a fresh container. Thread deleted → `destroy()` removes the container and the volume.

## Security hardening

The Docker provider is hardened by default — a fresh `dockerSandbox()` config with no `security` key applies all of the following:

| Control | Default | Effect |
| --- | --- | --- |
| Linux capabilities | `--cap-drop ALL` | The container gets none of the default Docker capability set (no `CAP_NET_RAW`, `CAP_SYS_ADMIN`, etc.) |
| Privilege escalation | `--security-opt no-new-privileges` | setuid/setgid binaries can't escalate to root inside the container |
| Process count | `--pids-limit 512` | Caps forked processes as a fork-bomb defense |
| Root filesystem | `--read-only` + `--tmpfs /tmp` + `--tmpfs /run` | The image's root filesystem is immutable; only the workspace volume and the two tmpfs mounts are writable |
| User | `--user 1000:1000` with `HOME=/workspace` | The process runs as a non-root uid/gid instead of the image's default (often root) |

This is expressed as a provider-agnostic `SandboxPolicy.security` intent, not a Docker-only flag set — a future microVM- or gVisor-backed provider implements the same fields against its own mechanism.

Every control has a per-flag opt-out for images that need it:

```ts title="dawn.config.ts"
import { config } from "@dawn-ai/cli"
import { dockerSandbox } from "@dawn-ai/sandbox"

export default config({
  sandbox: {
    provider: dockerSandbox({ image: "node:24-slim" }),
    security: { runAsNonRoot: false, readOnlyRootFilesystem: false }, // opt out if your image needs it
  },
})
```

`security` accepts:

- `dropAllCapabilities?: boolean` — default `true`
- `noNewPrivileges?: boolean` — default `true`
- `readOnlyRootFilesystem?: boolean` — default `true`
- `runAsNonRoot?: boolean | { uid: number; gid: number }` — default `true` (uid/gid `1000:1000`); pass an object for a different fixed uid/gid, or `false` to run as the image's default user
- `pidsLimit?: number` — default `512`

<Callout type="warn" title="Bake system deps into your image">
  The read-only root filesystem and non-root user mean runtime `apt`/`apk` installs, `npm install -g`, and writes outside the workspace all fail by default — there's nowhere writable for them to land. Install system packages and global tooling at image-build time, and let the agent mutate only its workspace at runtime. If a workload genuinely needs to write elsewhere or run as root, opt out with `readOnlyRootFilesystem: false` / `runAsNonRoot: false`.
</Callout>

### Per-command timeout

`resources.timeoutMs` bounds how long a single `runBash` call may run, enforced inside the container (the command is wrapped in `timeout`; an overrun exits with code `124`):

```ts
sandbox: {
  provider: dockerSandbox({ image: "node:24-slim" }),
  resources: { timeoutMs: 120_000 },
},
```

It's enforced only when set — omitting `resources.timeoutMs` leaves exec calls unbounded in duration (still subject to `memoryMb`/`cpus` caps, if configured). Enforcement shells out to the `timeout` binary (GNU coreutils) inside the container, so when you set `resources.timeoutMs` make sure your image ships it — most full base images (`node:24-slim`, `debian`, `ubuntu`) do, but minimal ones (`alpine` without the `coreutils` package, distroless) may not. The ceiling is rounded up to whole seconds (`timeoutMs: 500` enforces a 1-second limit).

## Network policy

`sandbox.network` takes one of two shapes. The portable config expresses intent; each provider maps it to different enforcement:

- **`{ mode: "deny" }`** — default-closed egress. Docker enforces this exactly with `--network none`. Kubernetes keeps cluster DNS reachable and can add allowlisted CIDRs, so it does not fully eliminate egress.
- **`{ mode: "allow", denylist?: [...] }`** — egress is on by default, with an optional denylist of hosts to block.

The default, when `network` is omitted, is `{ mode: "allow", denylist: ["169.254.169.254"] }`, expressing an intent to block the common cloud-metadata SSRF target. The reference providers do not rigorously enforce an allow-mode denylist; use an egress proxy or provider with stronger enforcement when that boundary matters.

<Callout type="warn" title="allow-mode denylist is best-effort">
  In the Docker reference provider, the `allow`-mode denylist is **best-effort**, not enforced with the same rigor as `deny` mode. Blocking arbitrary outbound hosts from inside a container needs an in-container firewall rule or an egress proxy; the reference does not guarantee every denylisted host is unreachable. `deny` mode's `--network none` remains exact. A provider backed by a microVM or a cloud sandbox can enforce the denylist more strongly.
</Callout>

## Kubernetes provider

`kubernetesSandbox` runs each thread's sandbox as a Kubernetes Pod instead of a local Docker container, for deployments where the Dawn server itself runs in a cluster:

```ts title="dawn.config.ts"
import { config } from "@dawn-ai/cli"
import { kubernetesSandbox } from "@dawn-ai/sandbox"

export default config({
  sandbox: {
    provider: kubernetesSandbox({ image: "node:24-slim", namespace: "dawn-sandboxes" }),
    network: { mode: "deny" },
    resources: { memoryMb: 512, cpus: 1, diskGb: 2 },
  },
})
```

`kubernetesSandbox({ image, namespace?, storageClass?, startupTimeoutMs? })` implements the same `SandboxProvider` contract as `dockerSandbox`. The shared `security`, `network`, and `resources` shape expresses the same intent, but it does **not** imply identical enforcement:

| Policy intent | Docker provider | Kubernetes provider |
|---|---|---|
| `network.mode: "deny"` | `--network none`; no network egress | `NetworkPolicy`; permits cluster DNS and allowlisted CIDRs, and requires a policy-enforcing CNI |
| `network.mode: "allow"` denylist | Best-effort; not rigorously enforced | Best-effort; no provider-created policy |
| `security.pidsLimit` | `--pids-limit` (default 512) | Not enforced by the provider; use the node-level kubelet PID limit |
| `resources.diskGb` | Ignored | PVC storage request |

Kubernetes DNS access also leaves a DNS-tunneling path. Choose and validate the provider against your threat model.

**Per thread:** a Pod plus a per-thread `ReadWriteOnce` PersistentVolumeClaim mounted at `/workspace`, mirroring the Docker provider's named-volume persistence. `release()` deletes the Pod but keeps the PVC, so the next turn's `acquire()` schedules a fresh Pod against the existing claim with the workspace intact. `destroy()` deletes both the Pod and the PVC, discarding the workspace permanently — the same lifecycle semantics as the Docker provider's container/volume split, just on Kubernetes' own objects.

**Auth:** the provider talks to the Kubernetes API using `@kubernetes/client-node`'s `loadFromDefault()`, which auto-detects an in-cluster ServiceAccount token when the Dawn server itself runs as a Pod, or a local kubeconfig otherwise. The in-cluster token path is the documented production setup.

`dawn check` runs a SelfSubjectAccessReview for every runtime operation before the provider is used: create/get/delete Pods; create/get/delete PVCs; create/get `pods/exec`; and create/get/list/update/delete NetworkPolicies. It runs the complete set even when a review is denied or fails, then reports missing permissions, authorization-review failures, and API transport failures separately. Only after all permissions pass does it probe NetworkPolicy enforcement; an unconfirmed policy-capable CNI produces a warning instead of an enforcement claim.

Custom `KubeClient` implementations must use the structured permission signature exported by the package:

```ts
import type { KubeClient, KubePermission } from "@dawn-ai/sandbox"

const canI: KubeClient["canI"] = async (
  namespace: string,
  permission: KubePermission,
) => review(namespace, permission)
```

Replace positional `canI(namespace, verb, resource)` implementations with `canI(namespace, permission)`. No compatibility overload exists.

**Sizing:** `resources.diskGb` sets the PVC's storage request. It's new to this provider — `dockerSandbox` ignores it, since Docker volumes aren't quota-bound the same way.

### Security hardening on Kubernetes

The `security` intent maps onto Pod and container `SecurityContext` fields instead of `docker run` flags. Most defaults and opt-outs match [Security hardening](#security-hardening); the process-limit exception is called out below:

| Control | Kubernetes mechanism |
| --- | --- |
| Non-root user | `securityContext.fsGroup` — kubelet recursively `chown`s the PVC to the given gid on mount, so there's no chown-init container and no root step at all |
| Read-only root filesystem | `readOnlyRootFilesystem: true` on the container `SecurityContext`, plus `emptyDir` volumes mounted at `/tmp` and `/run` for scratch space |
| Dropped capabilities | `capabilities.drop: ["ALL"]` |
| Privilege escalation | `allowPrivilegeEscalation: false` |
| Seccomp | `seccompProfile: { type: "RuntimeDefault" }` by default |

Sandbox Pods also set `automountServiceAccountToken: false`, so a compromised sandbox process has no Kubernetes API credentials to steal — it can't call the cluster API even if it escapes the container boundary.

`pidsLimit` is **not** enforced by this provider — Kubernetes has no per-Pod or per-namespace process-count field equivalent to Docker's `--pids-limit` (`pids` is not a valid `LimitRange`/`ResourceQuota` resource). Fork-bomb defense on Kubernetes is a **node-level** kubelet setting (`podPidsLimit` / `--pod-max-pids`) that a cluster operator configures on the nodes running sandbox Pods; it cannot be set by the provider or a namespaced chart.

### Network policy on Kubernetes

The same `network` config (`{ mode: "deny", allowlist? }` or `{ mode: "allow", denylist? }`) is honored, but enforcement is a Kubernetes `NetworkPolicy` object rather than a container network mode:

- **`{ mode: "deny" }`** — the provider creates a per-thread `NetworkPolicy` that denies all egress from the sandbox Pod except to cluster DNS and any CIDRs listed in `allowlist`.
- **`{ mode: "allow" }`** — no `NetworkPolicy` is created, so egress is open by default; a `denylist`, if given, is best-effort only and not enforced — the same honest-scope caveat as the Docker provider's `allow`-mode denylist.

<Callout type="warn" title="NetworkPolicy needs a policy-capable CNI">
  A Kubernetes `NetworkPolicy` object is inert unless the cluster's CNI plugin enforces it — Calico and Cilium do; some CNIs silently ignore `NetworkPolicy` entirely. `dawn check` runs this provider's `preflight()`, which warns when it can't confirm the cluster's CNI enforces `NetworkPolicy`, but it can't guarantee enforcement the way `--network none` does for Docker's `deny` mode. Even with enforcement, cluster DNS remains reachable and the policy does not prevent DNS tunneling. Confirm your cluster's CNI and DNS controls before relying on `deny` mode as a boundary.
</Callout>

Kubernetes Pod isolation is the same boundary class as Docker's container isolation, not a microVM — the same caveats in [What it is — and isn't](#what-it-is--and-isnt) apply. The namespace, RBAC, default-deny `NetworkPolicy`, `LimitRange`, and PVC-reaper are provisioned separately by the Helm chart below, not by the provider itself.

### Kubernetes compatibility evidence

The canonical compatibility policy pins Kind v0.32.0, kubectl v1.35.6, and Calico v3.32.1. Dawn exercises Kubernetes 1.34 (1.34.8), Kubernetes 1.35 (1.35.5), and Kubernetes 1.36 (1.36.1) with those pinned or checksum-verified inputs.

Dawn's Kind/Calico coverage does not certify managed Kubernetes services, other CNI implementations, or storage drivers.

From a Dawn repository checkout, run the same focused chart/provider lifecycle against an already selected cluster:

```bash
pnpm verify:k8s:compat -- --target <1.34|1.35|1.36> --context <exact-context> [--storage-class <name>] [--keep-on-failure]
```

`--target` must match the server minor. `--context` must exactly equal the current kubeconfig context; the command refuses to select or switch contexts for you. The host needs `pnpm`, Helm, and kubectl. The cluster needs dynamic provisioning for `ReadWriteOnce` PVCs (exactly one annotated default StorageClass or the named `--storage-class`), Pod Security Admission, and a policy-enforcing CNI.

The command uses temporary, distinct management and sandbox namespaces. Before changing the cluster, it validates the server minor, storage selection, unused namespace names, and every administrative permission it will need. The complete permission declaration covers namespace lifecycle and StorageClass reads at cluster scope; Helm release Secrets, ServiceAccounts and token requests, Roles, RoleBindings, ConfigMaps, ResourceQuotas, LimitRanges, PVCs, Services, Pods and `pods/exec`/`pods/log`, Deployments, CronJobs, Jobs, NetworkPolicies, Events, and SelfSubjectAccessReviews at their required management or sandbox scope. All reviews run, and every denial or failed review is reported together.

## Deploying the sandbox infrastructure (Helm)

For the orientation-level view of both charts before diving into the reference below, see [Deploying on Kubernetes](/docs/deployment#deploying-on-kubernetes).

`kubernetesSandbox` assumes a namespace already exists with the RBAC, quotas, and network policy the provider's Pods need. The `dawn-sandbox-infra` Helm chart provisions that cluster-side infrastructure — install it once per cluster (or per environment) before pointing `kubernetesSandbox` at it:

```bash
helm install dawn-sandbox-infra oci://ghcr.io/cacheplane/charts/dawn-sandbox-infra
```

Or from a local checkout of the chart:

```bash
helm install dawn-sandbox-infra ./charts/dawn-sandbox-infra
```

What it provisions:

- **Namespace** (`dawn-sandboxes` by default) with configurable Pod Security Standard labels.
- **Least-privilege RBAC** — a `dawn-orchestrator` ServiceAccount, Role, and RoleBinding scoped to exactly what the provider needs: creating/getting/deleting Pods and PersistentVolumeClaims, `pods/exec`, and managing NetworkPolicies. Direct Secret API reads are denied.
- **A default-deny egress `NetworkPolicy` backstop** — selects Dawn-managed sandbox Pods via `app.kubernetes.io/managed-by=dawn`, with a carve-out for cluster DNS. Helm-managed reaper and control-plane Pods are excluded so they retain Kubernetes API access.
- **`ResourceQuota` and `LimitRange`** — namespace-wide aggregate caps plus container-level cpu/memory/ephemeral-storage defaults. (PID limiting is node-level on Kubernetes and cannot be set by a namespaced chart — see [Security hardening on Kubernetes](#security-hardening-on-kubernetes).)
- **Pod Security Standards** — namespace labels controlling what the cluster's built-in admission controller allows.
- **A PVC reaper** — a CronJob that marks and eventually deletes sandbox PVCs that are no longer referenced by any Pod, so abandoned per-thread volumes don't accumulate.

### Key caveats

<Callout type="warn" title="The namespace must match the provider config">
  The chart's `namespace.name` (default `dawn-sandboxes`) **must match** the `namespace` passed to `kubernetesSandbox({ namespace })` in `dawn.config.ts`. If they diverge, the provider's Pods are created in a namespace with none of the RBAC, quota, or network policy the chart set up.
</Callout>

`namespace.extraLabels` adds operator labels when the chart creates the namespace. The template rejects every `pod-security.kubernetes.io/*` key plus `helm.sh/chart`, `app.kubernetes.io/name`, `app.kubernetes.io/instance`, and `app.kubernetes.io/managed-by`, so extra labels cannot replace the Pod Security or chart ownership labels.

Pod Security Standards default to `enforce`, `warn`, and `audit` all set to `restricted`. A sandbox image that opts out of the provider's restricted-compatible hardening is rejected by admission. To intentionally permit such a workload, opt the namespace down explicitly:

```bash
helm install dawn-sandbox-infra oci://ghcr.io/cacheplane/charts/dawn-sandbox-infra \
  --set podSecurityStandard.enforce=baseline
```

<Callout type="warn" title="The baseline override weakens admission">
  `podSecurityStandard.enforce=baseline` is an explicit opt-out from the chart's restricted default. There is no automatic downgrade or compatibility fallback. Keep `restricted` unless every weaker setting is intentional and separately controlled.
</Callout>

<Callout type="warn" title="Keep credentials out of the sandbox namespace">
  The orchestrator cannot read Secrets through the Secret API, but its Pod-create permission can mount a known Secret into a Pod. The dedicated sandbox namespace must contain no application credentials. Keep Dawn app Pods, app Secrets, and Helm release Secrets in a separate management namespace and bind the app ServiceAccount through `orchestrator.subjects`.
</Callout>

<Callout type="warn" title="The default-deny egress backstop overrides allow-mode">
  The chart's default-deny egress `NetworkPolicy` selects Dawn-managed sandbox Pods via `app.kubernetes.io/managed-by=dawn`. It excludes Helm-managed reaper and control-plane Pods so they can reach the Kubernetes API, but sandbox Pods configured with `network: { mode: "allow" }` still have no egress unless you disable the backstop:

  ```bash
  helm install dawn-sandbox-infra oci://ghcr.io/cacheplane/charts/dawn-sandbox-infra \
    --set networkPolicy.defaultDenyEgress=false
  ```

  With the backstop disabled, per-thread `deny`-mode NetworkPolicies created by the provider still work as documented — only the chart-managed backstop is removed.
</Callout>

The PVC reaper's time-to-live is configurable via `reaper.ttlHours` (default `168`, one week) — a PVC with no Pod referencing it for longer than the TTL is deleted:

```bash
helm install dawn-sandbox-infra oci://ghcr.io/cacheplane/charts/dawn-sandbox-infra \
  --set reaper.ttlHours=24
```

`dawn-sandbox-infra` is the second of three sub-projects in Dawn's Kubernetes arc: this chart hardens the cluster for the sandbox provider; the `dawn-app` chart below runs the Dawn app itself on Kubernetes, completing the arc.

## Deploying a Dawn app (Helm)

`dawn build`'s `node` target (see [Deploying to production (Node/Docker)](/docs/deployment#deploying-to-production-nodedocker)) emits a `server.mjs` plus a hardened `Dockerfile` that boot the real Dawn runtime. **Build that image when your app configures `kubernetesSandbox`** — the sandbox provider only runs inside the Dawn runtime process, so an image built from the `langsmith` target's `langgraph.json` (containerized separately with `@langchain/langgraph-cli`'s `langgraphjs dockerfile`) never calls the Kubernetes API and will not create sandbox Pods, even with `kubernetesSandbox` configured in `dawn.config.ts`. The `dawn-app` Helm chart takes that **user-built image** and runs it on Kubernetes as a Deployment + Service, with optional Ingress and PodDisruptionBudget. It owns only the Kubernetes deploy concerns — it does not build your image or bake `dawn.config.ts`; the image is the runtime contract.

Keep the app and its credentials in a management namespace separate from `dawn-sandboxes`. The commands below create a `dawn-app` namespace, bind its ServiceAccount to the sandbox Role, and install the app there. They assume `dawn-sandbox-infra` is already installed.

```bash
# Build the image via dawn build's node target (on by default)
dawn build
docker build -t ghcr.io/you/your-app:latest .

# Create the management namespace and authorize its app ServiceAccount
kubectl create namespace dawn-app
helm upgrade dawn-sandbox-infra charts/dawn-sandbox-infra \
  --reuse-values \
  --set-json 'orchestrator.subjects[0]={"kind":"ServiceAccount","name":"dawn-app","namespace":"dawn-app"}'

# Install the app chart against that image in the management namespace
helm install dawn-app oci://ghcr.io/cacheplane/charts/dawn-app \
  --namespace dawn-app \
  --set image.repository=ghcr.io/you/your-app \
  --set image.tag=latest \
  --set serviceAccount.create=true \
  --set serviceAccount.name=dawn-app \
  --set sandboxNamespace=dawn-sandboxes
```

Or from a local checkout of the chart:

```bash
helm install dawn-app ./charts/dawn-app \
  --namespace dawn-app \
  --set image.repository=ghcr.io/you/your-app \
  --set serviceAccount.create=true \
  --set serviceAccount.name=dawn-app \
  --set sandboxNamespace=dawn-sandboxes
```

`image.repository` is required — install/upgrade fails fast with a clear error if it's unset. `containerPort` (default `8000`) and `healthPath` (default `/healthz`) are also values, matching the `node` target's Dockerfile (`EXPOSE 8000`, `/healthz`) out of the box — verify both against your built image before relying on the defaults if you're deploying a differently-shaped image, since they drive the liveness/readiness/startup probes.

### ServiceAccount and namespace wiring

If your app's `dawn.config.ts` configures `kubernetesSandbox`, the app process calls the Kubernetes API to create sandbox Pods. Its Pod must run under a ServiceAccount bound to the `dawn-sandbox-infra` chart's `dawn-orchestrator` Role. Use a cross-namespace subject so application Secrets never share the sandbox namespace:

```bash
helm upgrade dawn-sandbox-infra charts/dawn-sandbox-infra \
  --reuse-values \
  --set-json 'orchestrator.subjects[0]={"kind":"ServiceAccount","name":"dawn-app","namespace":"dawn-app"}'
```

Set `dawn-app`'s `serviceAccount.create=true` and `serviceAccount.name=dawn-app` as shown above. Keep `sandboxNamespace` (informational only) in sync with the namespace passed to `kubernetesSandbox({ namespace })` in `dawn.config.ts` and with `dawn-sandbox-infra`'s `namespace.name`. The chart defaults reuse the existing `dawn-orchestrator` ServiceAccount only for a same-namespace installation; do not use that topology when the app needs credentials.

### Env, secrets, and replicas

Supply environment variables directly (`env`) or via an existing Secret (`secretName`, wired as a convenience `envFrom.secretRef` — the chart does not template Secrets itself):

```bash
helm upgrade dawn-app oci://ghcr.io/cacheplane/charts/dawn-app \
  --namespace dawn-app \
  --reuse-values \
  --set secretName=my-app-secrets
```

Ingress and a PodDisruptionBudget are opt-in:

```bash
helm upgrade dawn-app oci://ghcr.io/cacheplane/charts/dawn-app \
  --namespace dawn-app \
  --reuse-values \
  --set ingress.enabled=true --set ingress.className=nginx --set ingress.host=app.example.com \
  --set podDisruptionBudget.enabled=true
```

<Callout type="warn" title="Do not scale replicas without thread-aware routing">
  The Dawn HTTP runtime's one-run-per-thread gate and cancellation registry are process-local. Shared Postgres stores make thread data durable, but do not distribute that coordination. Multiple replicas require guaranteed thread-keyed sticky routing to one process **or** distributed per-thread serialization and cancel routing.
</Callout>

<Callout type="warn" title="A user-built image, not a Dawn-hosted runtime">
  This chart cannot validate a real Dawn app end-to-end in CI — that needs an app image and model credentials. CI instead validates the chart's manifests (lint, render, `kubeconform`) plus a gated `kind` smoke test that installs the chart with a placeholder image and confirms the Deployment and Service come up and serve traffic. Validating your actual app image against a real model is your responsibility.
</Callout>

## Subagents

A subagent dispatch runs under the same conversation thread as its parent, so it resolves to and shares the parent's sandbox — the coordinator and its subagents operate in one isolated environment, not one each.

## Custom providers

`SandboxProvider` is the contract any isolation backend implements — Docker, a microVM, or a cloud sandbox service:

```ts
import type { SandboxHandle, SandboxPolicy, SandboxProvider } from "@dawn-ai/workspace"

export interface SandboxProvider {
  readonly name: string
  acquire(input: {
    readonly threadId: string
    readonly policy: SandboxPolicy
    readonly signal: AbortSignal
  }): Promise<SandboxHandle>
  release(threadId: string): Promise<void>
  destroy(threadId: string): Promise<void>
  preflight?(): Promise<{
    readonly ok: boolean
    readonly detail?: string
    readonly warnings?: readonly string[]
  }>
}
```

`acquire` is create-or-reattach and idempotent per `threadId`: called at the start of every turn, it returns the same live sandbox until `release` or `destroy` is called. `release` drops warm compute but keeps the workspace volume (idle reap, server shutdown); `destroy` removes the volume too (thread delete). The returned `SandboxHandle`'s `filesystem` and `exec` are the same `FilesystemBackend`/`ExecBackend` interfaces the [workspace](/docs/workspace) capability already consumes, so wiring a new provider in requires no change to the capability itself.

Validate a custom provider against the same conformance suite `dockerSandbox` and `fakeSandbox` are held to:

```ts
import { runProviderConformance } from "@dawn-ai/sandbox/testing"
import { describe } from "vitest"
import { myCloudSandbox } from "./my-cloud-sandbox.js"

runProviderConformance({
  name: "my-cloud-sandbox",
  makeProvider: () => myCloudSandbox({ apiKey: process.env.MY_SANDBOX_KEY! }),
  describe,
})
```

The conformance kit checks `acquire` idempotency and reattachment, per-thread isolation, `release`-keeps/`destroy`-clears volume semantics, and that `exec` returns a numeric exit code.

## Testing your agent

`fakeSandbox()` from `@dawn-ai/sandbox/testing` is an in-memory `SandboxProvider` — deterministic, CI-safe, and requires no Docker daemon:

```ts title="dawn.config.ts (test)"
import { config } from "@dawn-ai/cli"
import { fakeSandbox } from "@dawn-ai/sandbox/testing"

export default config({
  sandbox: { provider: fakeSandbox() },
})
```

Use it in harness-driven tests the same way you'd test any other agent route — it satisfies the same `SandboxProvider` contract as `dockerSandbox`, so wiring behavior (per-thread isolation, warm reuse, subagents sharing a thread's sandbox) is exercised without spinning up containers.

## Verifying the full arc (end-to-end)

Two gated CI lanes prove the whole deployment path composes — a real Dawn app, built the user-facing way (`dawn build`'s [node target](/docs/deployment)) and deployed, drives the provider **from inside its own running workload** to spawn a real, isolated sandbox on an Agent-Protocol request, then tears it down:

- **`sandbox-docker-e2e`** — the app runs as a container with the host Docker socket mounted and drives `dockerSandbox` (docker-out-of-docker) to spawn a **sibling** sandbox container.
- **`sandbox-k8s-e2e`** — the app runs as a Pod (deployed by the [`dawn-app` chart](#deploying-a-dawn-app-helm), using the orchestrator ServiceAccount from the [`dawn-sandbox-infra` chart](#deploying-the-sandbox-infrastructure-helm)) and drives `kubernetesSandbox` to spawn a sandbox **Pod** in the sandbox namespace.

Both are deterministic (the agent turn is driven by a mocked model, no API key) and assert on the **real in-sandbox command output** — that `runBash` ran as the hardened non-root user (`id -u` = `1000`) inside the sandbox workload (not the app), and that the sandbox Pod/container and its volume are removed on thread delete. They're gated behind `DAWN_TEST_SMOKE_E2E=1` and run on demand, the same way the provider conformance lanes do.

The distinction they lock in: only the **Dawn runtime** server (`dawn dev`, `dawn start`, or the node target's `server.mjs`) engages the sandbox. An image built via the LangSmith/`langgraphjs` platform path never runs the Dawn runtime and never touches the sandbox — see [Deploying to production](/docs/deployment). The [`hono` target](/docs/deployment#edge-runtimes) does run the Dawn runtime, but an edge runtime can neither start a container nor talk to a container daemon, so that build fails with `DAWN_E1005` when `sandbox` is configured rather than deploying an app whose isolation silently does nothing.

The build gate is not the last word, because it can be bypassed: an entry composed by hand over `@dawn-ai/cli/fetch` never runs that target. So a runtime that supplies no filesystem fallbacks and was handed a `sandbox` block it cannot honor raises the same `DAWN_E1005` on **every** request, health checks included — it refuses to serve rather than running every tool unsandboxed. Injecting your own `sandboxManager` satisfies it; that caller is serving `sandbox` for real. None of this can fire on Node, whatever you configure: the check short-circuits on the presence of the filesystem fallbacks, which every Node entry point supplies, so a Node app with no `sandbox` key goes on reading and writing the host `workspace/` directory exactly as it always has.

## What it is — and isn't

**Is:** per-thread kernel-level filesystem and process isolation; the host filesystem is never touched; the host environment is never leaked into the sandbox; CPU and memory caps via `resources`; multi-tenant separation by thread; provider-specific deny-mode egress control; the workspace survives turns, server restarts, and container crashes; hardened by default — all Linux capabilities dropped, no privilege escalation, a read-only root filesystem, and a non-root user. Docker also applies a process-count limit; Kubernetes requires a node-level kubelet setting for that control.

**Is not:** a guarantee against container-escape zero-days. Dropped capabilities, a non-root user, a read-only root filesystem, and deny-mode networking materially raise the bar an attacker has to clear, but this remains Docker's isolation boundary, not a microVM. That's why the hardening is expressed as a provider-agnostic `SandboxPolicy.security` intent rather than a Docker-specific flag set: a gVisor-, Kata-, or cloud-microVM-backed provider satisfies the same seam with a stronger underlying substrate, as a drop-in replacement with no change to your app code. The `allow`-mode denylist is best-effort in the Docker reference; it does not stop an agent exfiltrating its own sandbox's data under `allow` mode. And the sandbox does not govern tool *surface* — that's [tool scoping](/docs/tools)'s job (`agent({ tools })`); the sandbox and tool scoping are complementary layers, not substitutes for each other.

Dawn ships the isolation seam plus a Docker reference. For hostile-grade multi-tenant isolation, plug in a microVM-backed provider.

The Kubernetes provider carries two of its own scope notes: its `deny`-mode `NetworkPolicy` only enforces egress control on a policy-capable CNI (Calico, Cilium) — a CNI that ignores `NetworkPolicy` leaves the Pod's network open regardless of config, which is why `dawn check` warns rather than guarantees; and its `pidsLimit` is not enforced at all — Kubernetes has no namespaced PID cap, so fork-bomb defense is a node-level kubelet setting (`podPidsLimit`) the cluster operator configures, not something the provider or the Helm chart can set.

## Related
