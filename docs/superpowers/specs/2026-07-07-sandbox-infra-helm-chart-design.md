# Sandbox-Infra Helm Chart — Design

**Date:** 2026-07-07
**Status:** Approved (brainstorm — decisions locked; user delegated execution while publishing 0.8.9)
**Sub-project:** 2 of 3 in the "run Dawn on Kubernetes" arc (provider #317 → **this chart** → app-deploy chart).

## Goal

A Helm chart, `charts/dawn-sandbox-infra/`, that provisions the cluster-side infrastructure the `kubernetesSandbox` provider (shipped in #317, `@dawn-ai/sandbox`) assumes: a namespace, least-privilege RBAC for the orchestrator, a default-deny egress NetworkPolicy backstop, a ResourceQuota + LimitRange (carrying the `pids` limit the provider delegates), configurable Pod Security Standards, and a self-bookkeeping PVC reaper. One `helm install` makes a cluster "sandbox-ready." Pure infra — it does **not** deploy a Dawn app (sub-project 3) and does not touch `dawn.config.ts`.

## Context (what the provider requires)

From the merged provider (`packages/sandbox/src/kubernetes/`):
- Objects are created **in a single namespace** (`opts.namespace`, default `dawn-sandboxes`), labelled `app.kubernetes.io/managed-by: dawn` + `dawn.sh/thread: <sanitized-threadId>`.
- Per thread: a Pod `dawn-sbx-<id>` (keeper `sleep infinity`, hardened SecurityContext, `automountServiceAccountToken: false`), a PVC `dawn-sbx-vol-<id>` (RWO) at `/workspace`, and — for `network:deny` — a per-thread NetworkPolicy `dawn-sbx-net-<id>` (egress deny except DNS + allowlist CIDRs).
- **Exact API surface** the orchestrator's credential must allow, all namespaced:
  - `pods`: create, get, delete
  - `pods/exec`: create (the exec subresource)
  - `persistentvolumeclaims`: create, get, delete
  - `networkpolicies` (networking.k8s.io): create, get, list, update (replace→PUT), delete
  - `selfsubjectaccessreviews` (authorization.k8s.io): create — used by `preflight`; **cluster-scoped and allowed to all authenticated users by default**, so no explicit grant needed (documented, not templated).
- `pidsLimit` has **no pod-level field** in the provider — it is delegated here to the namespace LimitRange.
- `release()` deletes the Pod but keeps the PVC (idle thread → unbound PVC that a later `acquire` re-binds). `destroy()` deletes both. Orphan PVCs can leak on orchestrator crash → the reaper is the backstop.

## Decisions (from the brainstorm)

- **Delivery:** in-repo source at `charts/dawn-sandbox-infra/` + CI validation (`helm lint`, `helm template` + `kubeconform`) **and** publish to an **OCI registry (GHCR)** on release.
- **Pod Security Standards:** configurable; default `enforce=baseline` + `warn=restricted` + `audit=restricted` (blocks the dangerous class always, keeps the provider's opt-outs working, logs/warns on restricted shortfalls). Tightenable to `enforce=restricted`.
- **PVC reaper:** self-bookkeeping unbound-TTL CronJob — marks `dawn.sh/unbound-since` on managed PVCs with no bound pod, clears it when a pod re-binds, deletes PVCs continuously unbound past a configurable TTL. Its own least-privilege ServiceAccount.

## Architecture

### Chart layout

```
charts/dawn-sandbox-infra/
  Chart.yaml            # name, version (chart SemVer, independent of npm), appVersion
  values.yaml           # documented, safe defaults
  values.schema.json    # JSON Schema validating values (helm lint enforces it)
  README.md             # install + values reference (generated/maintained)
  templates/
    _helpers.tpl        # name/label helpers (standard Helm labels + dawn labels)
    namespace.yaml      # Namespace + PSS labels (gated by values.namespace.create)
    rbac-orchestrator.yaml   # ServiceAccount + Role + RoleBinding (provider surface)
    networkpolicy-default-deny.yaml  # namespace-wide egress backstop (+ DNS)
    resourcequota.yaml  # aggregate namespace caps (gated)
    limitrange.yaml     # default/max cpu/mem/ephemeral-storage + default pids limit
    reaper-rbac.yaml    # reaper ServiceAccount + Role + RoleBinding (least-priv)
    reaper-cronjob.yaml # the PVC reaper CronJob
    NOTES.txt           # post-install: how to point dawn.config.ts at this namespace
```

`_helpers.tpl` defines a `dawn-sandbox-infra.namespace` helper so every object references the same `values.namespace.name`. All templated objects carry the standard Helm recommended labels; the namespace itself does **not** get `managed-by: dawn` (that label is the provider's per-thread marker — the chart must not collide with the reaper's selector).

### RBAC (orchestrator)

A namespaced **Role** (least privilege — no ClusterRole; the chart owns namespace creation so the orchestrator never needs cluster-scoped verbs) granting exactly the surface above:

```yaml
rules:
  - apiGroups: [""]
    resources: ["pods", "persistentvolumeclaims"]
    verbs: ["create", "get", "delete"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["networkpolicies"]
    verbs: ["create", "get", "list", "update", "delete"]
```

A **ServiceAccount** (`values.orchestrator.serviceAccount.name`, default `dawn-orchestrator`) + a **RoleBinding** binding the Role to it. The chart creates the SA by default (for the in-cluster topology where a Dawn app runs in the same or a peer namespace and uses this SA). `values.orchestrator.serviceAccount.create=false` + a `name` lets an operator bind an existing SA (or a cross-namespace subject via `values.orchestrator.subjects`). `get` on pods/pvcs covers the provider's `readNamespacedPod*`/`pvcExists`; `list` on networkpolicies covers `listNamespacedNetworkPolicy` (the `preflight` CNI probe); `update` covers the create→409→replace upsert.

### Default-deny NetworkPolicy backstop

A namespace-wide NetworkPolicy selecting **all** pods (`podSelector: {}`), `policyTypes: [Egress]`, egress limited to a DNS carve-out scoped to `kube-system` (mirrors the provider's per-thread policy). This makes sandbox pods fail **closed** even when the provider emits no per-thread policy (e.g. `network:allow`, or a provider bug) — defense in depth. Gated by `values.networkPolicy.defaultDenyEgress` (default `true`). Documented caveat: only enforced by a policy-capable CNI (Calico/Cilium), same honest-scope note as the provider's `preflight`. Ingress is left to cluster default (the sandbox exposes no services).

**Interaction note:** the provider's per-thread `allow`-mode is "open egress" — but the chart's default-deny backstop would still block it. This is intentional and documented: with the backstop on, `network:allow` is *not* actually open (the namespace denies egress); an operator who wants working allow-mode sets `values.networkPolicy.defaultDenyEgress=false`. The backstop is a fail-closed safety default, and the honest-scope docs state that allow-mode + backstop = still denied.

### ResourceQuota + LimitRange

- **ResourceQuota** (gated, `values.resourceQuota.enabled`, default `true`): caps namespace aggregate `requests.cpu/memory`, `limits.cpu/memory`, `persistentvolumeclaims` count, and `requests.storage`. Defaults sized for a modest multi-tenant footprint, all overridable.
- **LimitRange** (`values.limitRange.enabled`, default `true`): sets container `default`/`defaultRequest` cpu/memory + `max` ephemeral-storage, **and the default `pids` limit** (`values.limitRange.defaultPids`, default `512` — matching the Docker provider's `--pids-limit 512`). This is where the provider's delegated `pidsLimit` lands. A `type: Container` LimitRange with `default: { "pids": "512" }` applies the fork-bomb cap the provider can't set at the pod level.

### Pod Security Standards

Namespace labels (templated from `values.podSecurityStandard`):
```yaml
pod-security.kubernetes.io/enforce: baseline   # default; → restricted | privileged
pod-security.kubernetes.io/enforce-version: latest
pod-security.kubernetes.io/warn: restricted
pod-security.kubernetes.io/audit: restricted
```
`values.podSecurityStandard.enforce` (default `baseline`), `.warn`/`.audit` (default `restricted`). Default posture blocks privileged/hostPath/host-namespaces (baseline) while allowing the provider's opt-outs, and warns/audits when a pod falls short of restricted. Setting `enforce: restricted` is the "no opt-outs" hard-mode (the provider's `runAsNonRoot:false` etc. then get admission-rejected — documented).

### PVC reaper

A **CronJob** (`values.reaper.enabled` default `true`; `values.reaper.schedule` default `"17 * * * *"` hourly) running a small `bitnami/kubectl`-style image with a shell script:

1. `kubectl get pvc -n <ns> -l app.kubernetes.io/managed-by=dawn -o json`.
2. Build the set of PVC claimNames currently referenced by any pod in the namespace (`kubectl get pods -o jsonpath` over `.spec.volumes[].persistentVolumeClaim.claimName`).
3. For each managed PVC:
   - **bound** (claim referenced by a pod) → `kubectl annotate --overwrite pvc <name> dawn.sh/unbound-since-` (remove the marker).
   - **unbound**, no `dawn.sh/unbound-since` → set it to `now` (epoch seconds, `date -u +%s` — see the arithmetic note below).
   - **unbound**, marker present and `now - unbound-since > ttlHours*3600` (default `168` = 7d) → `kubectl delete pvc <name>`.

Self-contained: no provider change, no external state. A resumed idle thread binds a pod → marker cleared → never reaped; a truly-leaked PVC stays unbound → reaped after the TTL. The CronJob mounts **no** extra privilege beyond its Role.

**Reaper image + timestamp arithmetic (implementation crux):** the reaper needs `kubectl` **plus a POSIX shell and `date`** in one image — the distroless `registry.k8s.io/kubectl` has no shell, so use an image that bundles all three (default `values.reaper.image: docker.io/alpine/k8s:<pinned>` or `bitnami/kubectl:<pinned>` — the plan pins a concrete digest/tag). The unbound-since comparison is done in-container: `date -u -d <iso>` (GNU) is not portable to Alpine/busybox, so the script converts both `unbound-since` and `now` to epoch seconds via `date -u -D %Y-%m-%dT%H:%M:%SZ -d <iso> +%s` **only if the chosen image's `date` supports it**; the portable fallback the plan implements is to store the marker as an **epoch-seconds** string (`date -u +%s`) rather than RFC3339, so the comparison is pure integer arithmetic with no date parsing. The reaper pod runs hardened (non-root, read-only rootfs, drop ALL caps) to satisfy the namespace PSS.

**Reaper RBAC** (separate least-privilege SA `dawn-reaper`):
```yaml
rules:
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get", "list", "patch", "delete"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list"]
```
Deliberately narrower than the orchestrator Role — no pod create/exec, no create/networkpolicy. `patch` is for the annotation bookkeeping. The reaper's timestamp bookkeeping uses `Date`-free logic in-cluster (it reads `date -u` inside the job at runtime — a live poller, not deterministic code).

### Values surface (defaults)

```yaml
namespace:
  create: true
  name: dawn-sandboxes
podSecurityStandard:
  enforce: baseline      # baseline | restricted | privileged
  warn: restricted
  audit: restricted
orchestrator:
  serviceAccount:
    create: true
    name: dawn-orchestrator
  subjects: []           # extra RoleBinding subjects (e.g. cross-namespace SA)
networkPolicy:
  defaultDenyEgress: true
resourceQuota:
  enabled: true
  hard:                  # all overridable
    requests.cpu: "8"
    requests.memory: 16Gi
    limits.cpu: "16"
    limits.memory: 32Gi
    persistentvolumeclaims: "50"
    requests.storage: 100Gi
limitRange:
  enabled: true
  defaultPids: 512
  default: { cpu: "1", memory: 512Mi }
  defaultRequest: { cpu: 100m, memory: 128Mi }
  maxEphemeralStorage: 1Gi
reaper:
  enabled: true
  schedule: "17 * * * *"
  ttlHours: 168
  image: docker.io/alpine/k8s:1.31.1   # sh + date + kubectl; plan pins a digest
```

`values.schema.json` validates types/enums (e.g. `podSecurityStandard.enforce` ∈ {baseline,restricted,privileged}); `helm lint` fails on schema violations.

## Testing

1. **`helm lint`** — schema + template sanity. CI + local.
2. **`helm template` + `kubeconform`** — render with (a) default values and (b) an override fixture (`enforce: restricted`, `reaper.enabled: false`, custom namespace), pipe through `kubeconform` (strict, k8s schema) to catch malformed manifests. CI + local.
3. **Gated real-cluster install smoke — reuse the existing `sandbox-k8s` lane.** Replace that lane's manual `kubectl create namespace dawn-sandboxes` with `helm install dawn-sandbox-infra charts/dawn-sandbox-infra`, then run the provider's existing `DAWN_TEST_K8S=1` integration suite **using the chart's `dawn-orchestrator` ServiceAccount** (kubeconfig context switched to that SA's token). This proves end-to-end: the chart's RBAC actually lets the provider create pods/pvcs/exec/networkpolicies, the default-deny backstop + per-thread policy coexist (egress-deny still passes), the LimitRange applies, and PSS baseline admits the hardened pods. A dedicated reaper unit test: create an unbound managed PVC, run the reaper script once (marks it), fast-forward by setting `unbound-since` to the past, run again → asserts deletion.

## Packaging / release

- **CI (PR):** a `chart` job (or steps in `validate`) — `helm lint` + `helm template | kubeconform`. Pin `helm`/`kubeconform` action SHAs per repo convention.
- **OCI publish (release):** a new workflow `.github/workflows/publish-chart.yml`, triggered on push to `main` under `charts/dawn-sandbox-infra/**`, that `helm package`s and `helm push`es to `oci://ghcr.io/cacheplane/charts` using the built-in `GITHUB_TOKEN` (`permissions: packages: write`, `helm registry login ghcr.io`). The chart version comes from `Chart.yaml` (bump it per change; a guard skips push if that version tag already exists in the registry to keep re-runs idempotent). Chart SemVer is **independent** of the npm 0.8.x line.

## Honest scope / out of scope

- NetworkPolicy (backstop + per-thread) only bites on a policy-capable CNI — the chart documents this; it does not install a CNI.
- The chart provisions infra; it does not run a Dawn app or wire `dawn.config.ts` (sub-project 3 does).
- PSS + ResourceQuota + LimitRange are Kubernetes-native admission controls; the chart configures them but their enforcement is the cluster's.
- Deferred: multi-namespace tenancy, HPA/autoscaling, a bundled CNI, cross-cluster federation, PodDisruptionBudgets.
