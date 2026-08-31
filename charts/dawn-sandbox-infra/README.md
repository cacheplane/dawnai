# dawn-sandbox-infra

Cluster-side infrastructure for the Dawn `kubernetesSandbox` provider
(`@dawn-ai/sandbox`). One `helm install` makes a cluster "sandbox-ready":

- A **namespace** (default `dawn-sandboxes`) with configurable **Pod
  Security Standard** labels.
- Least-privilege **RBAC** for the orchestrator — exactly the API surface
  the provider needs (pods, pods/exec, persistentvolumeclaims,
  networkpolicies), with no direct Secret API reads.
- A **default-deny egress NetworkPolicy** backstop (+ DNS carve-out) for
  Dawn-managed sandbox Pods selected by `app.kubernetes.io/managed-by=dawn`.
  Helm-managed reaper and control-plane Pods are excluded so they retain
  Kubernetes API access.
- A **ResourceQuota** + **LimitRange** (default/request cpu, memory,
  ephemeral-storage). Note: PID limiting is **not** namespaced in
  Kubernetes — it is a node-level kubelet setting (`podPidsLimit`), so
  the chart cannot template it; see "PID limits" below.
- A self-bookkeeping **PVC reaper** CronJob that deletes orphaned,
  continuously-unbound sandbox PVCs past a configurable TTL.

This chart is pure infrastructure: it does not deploy a Dawn application
and does not touch `dawn.config.ts`. See the docs site for the
application-deployment chart.

## Install

Install the published chart with its Helm release in the separate `dawn-app`
management namespace. The chart still creates sandbox resources in
`dawn-sandboxes`, while the Helm release Secret stays with the application and
other credentials in `dawn-app`.

For a fresh release, prepare `dawn-sandbox-infra-values.yaml` with the complete planned subject list.
This canonical example authorizes the application-owned ServiceAccount as a
cross-namespace subject:

```yaml
orchestrator:
  subjects:
    - kind: ServiceAccount
      name: dawn-app
      namespace: dawn-app
```

```sh
helm install dawn-sandbox-infra oci://ghcr.io/cacheplane/charts/dawn-sandbox-infra \
  --namespace dawn-app \
  --create-namespace \
  --values dawn-sandbox-infra-values.yaml
```

For testing from a local checkout only, use the checkout-relative chart path
but keep the same management release namespace:

```sh
helm install dawn-sandbox-infra ./charts/dawn-sandbox-infra \
  --namespace dawn-app \
  --create-namespace \
  --values dawn-sandbox-infra-values.yaml
```

For an existing release, first capture its installed chart version and export
its effective values:

```sh
INFRA_CHART_VERSION="$(helm get metadata dawn-sandbox-infra --namespace dawn-app | awk '$1 == "VERSION:" { print $2 }')"
test -n "$INFRA_CHART_VERSION" || { printf '%s\n' "unable to determine installed infrastructure chart version" >&2; exit 1; }
helm get values dawn-sandbox-infra --all --output yaml \
  --namespace dawn-app \
  > dawn-sandbox-infra-rbac-values.yaml
```

Edit `dawn-sandbox-infra-rbac-values.yaml` so `orchestrator.subjects` contains
the complete intended subject list: preserve every existing item and append
the application ServiceAccount as a cross-namespace subject. Helm replaces arrays,
so never write a guessed numeric subject index. Inspect the complete
file, then apply it:

```sh
helm upgrade dawn-sandbox-infra oci://ghcr.io/cacheplane/charts/dawn-sandbox-infra \
  --version "$INFRA_CHART_VERSION" \
  --namespace dawn-app \
  --values dawn-sandbox-infra-rbac-values.yaml
```

Then point `dawn.config.ts` at the same namespace:

```ts
sandbox: {
  provider: kubernetesSandbox({ namespace: "dawn-sandboxes" });
}
```

## Runtime prerequisites

Sandbox workloads require dynamic provisioning for `ReadWriteOnce` PVCs. The
provider can name a StorageClass explicitly; otherwise the cluster must have
exactly one annotated default StorageClass. The namespace also requires Pod
Security Admission for the chart's `restricted` labels. A policy-enforcing CNI
is required for the chart backstop and provider-created NetworkPolicies to
enforce egress; creating NetworkPolicy objects alone is not enforcement.

Keep this namespace dedicated to disposable sandbox infrastructure. The
orchestrator Role denies direct Secret API reads, but its Pod-create permission
can mount a known Secret into a Pod. The sandbox namespace must therefore
contain no application credentials, including Helm release Secrets or Dawn app
Secrets.

## Compatibility evidence

The canonical compatibility policy pins Kind v0.32.0, kubectl v1.35.6, and
Calico v3.32.1. Dawn exercises these policy-pinned patch releases:

- Kubernetes 1.34 (1.34.8)
- Kubernetes 1.35 (1.35.5)
- Kubernetes 1.36 (1.36.1)

The Kind node images are digest-pinned and the Calico manifest and images are
checksum-verified.

Dawn's Kind/Calico coverage does not certify managed Kubernetes services, other CNI implementations, or storage drivers.

Run the same focused chart/provider lifecycle against an already selected
cluster with:

```sh
pnpm verify:k8s:compat -- --target <1.34|1.35|1.36> --context <exact-context> [--storage-class <name>] [--keep-on-failure]
```

`--target` must match the server minor, and `--context` must exactly equal the
current kubeconfig context; the command refuses to switch contexts. It requires
`pnpm`, Helm, and kubectl, a dynamically provisioned RWO StorageClass (the
single annotated default or the exact `--storage-class`), Pod Security
Admission, and a policy-enforcing CNI.

Before changing the cluster, the command preflights the server minor, unused
temporary namespace names, storage selection, and every administrative
permission it will use. The permission preflight reports every denial and every
failed authorization review, covering namespace lifecycle and StorageClass
reads at cluster scope; Helm release Secrets, ServiceAccounts and token
requests, Roles, RoleBindings, ConfigMaps, ResourceQuotas, LimitRanges, PVCs,
Services, Pods and `pods/exec`/`pods/log`, Deployments, CronJobs, Jobs,
NetworkPolicies, Events, and SelfSubjectAccessReviews at their required
management or sandbox scope.

Dynamic RWO provisioning is a runtime prerequisite verified by the lifecycle,
not proven by preflight.

## Values

| Key | Default | Description |
| --- | --- | --- |
| `namespace.create` | `true` | Whether the chart creates the namespace. |
| `namespace.name` | `dawn-sandboxes` | Namespace the provider's `opts.namespace` must match. |
| `namespace.extraLabels` | `{}` | Extra labels for a chart-created namespace. Pod Security and chart ownership labels are reserved. |
| `podSecurityStandard.enforce` | `restricted` | `privileged` \| `baseline` \| `restricted`. |
| `podSecurityStandard.warn` | `restricted` | Same enum. |
| `podSecurityStandard.audit` | `restricted` | Same enum. |
| `orchestrator.serviceAccount.create` | `true` | Create the orchestrator ServiceAccount. |
| `orchestrator.serviceAccount.name` | `dawn-orchestrator` | SA name (also used to bind an existing SA when `create=false`). |
| `orchestrator.subjects` | `[]` | Extra RoleBinding subjects (e.g. a cross-namespace SA). |
| `networkPolicy.defaultDenyEgress` | `true` | Egress backstop for Dawn-managed sandbox Pods selected by `app.kubernetes.io/managed-by=dawn`. Helm-managed reaper/control-plane Pods are excluded. **Note:** provider sandbox Pods using `network: "allow"` are still denied while this is on. |
| `resourceQuota.enabled` | `true` | Gate the ResourceQuota. |
| `resourceQuota.hard` | see `values.yaml` | Aggregate namespace caps. |
| `limitRange.enabled` | `true` | Gate the LimitRange. |
| `limitRange.default` | `{cpu: "1", memory: 512Mi}` | Container default limits. |
| `limitRange.defaultRequest` | `{cpu: 100m, memory: 128Mi}` | Container default requests. |
| `limitRange.maxEphemeralStorage` | `1Gi` | Container default ephemeral-storage limit. |
| `reaper.enabled` | `true` | Gate the PVC reaper CronJob. |
| `reaper.schedule` | `"17 * * * *"` | Cron schedule (hourly by default). |
| `reaper.ttlHours` | `168` | Hours a PVC may stay continuously unbound before deletion. |
| `reaper.image` | `docker.io/alpine/k8s:1.35.6@sha256:b7a12c5ddf261994c33d2eaaa06fd69a0803ff6b38683bfa3d30a76dcdf92807` | Image bundling `sh`, `date`, `sort`, `grep`, and `kubectl`. |

The chart rejects `namespace.extraLabels` keys under
`pod-security.kubernetes.io/` and the ownership keys `helm.sh/chart`,
`app.kubernetes.io/name`, `app.kubernetes.io/instance`, and
`app.kubernetes.io/managed-by`. This prevents extra labels from weakening Pod
Security or replacing chart identity.

The chart enforces `restricted` by default. Baseline is needed only for
workloads or settings that actually violate Restricted admission, such as
`security.runAsNonRoot: false`. Setting
`security.readOnlyRootFilesystem: false` alone remains Restricted-compatible
and does not require lowering the namespace to Baseline. There is no automatic
downgrade:

```sh
helm upgrade dawn-sandbox-infra oci://ghcr.io/cacheplane/charts/dawn-sandbox-infra \
  --namespace dawn-app \
  --reuse-values \
  --set podSecurityStandard.enforce=baseline
```

## Provider preflight

`dawn check` runs a SelfSubjectAccessReview for every Kubernetes API operation
the provider can perform: create/get/delete Pods; create/get/delete PVCs;
create/get `pods/exec`; and create/get/list/update/delete NetworkPolicies. It
runs the complete set even when one review is denied or fails, then reports
missing permissions, authorization-review failures, and API transport failures
separately. Only after every required permission is granted does it check
NetworkPolicy enforcement; an unconfirmed policy-capable CNI produces a warning
rather than a successful enforcement claim.

## Reaper compatibility

The default reaper image provides the policy-pinned kubectl v1.35.6. For API
servers outside the tested minors above, override `reaper.image` with an image
containing a compatible Kubernetes client. The image must provide `sh`, `date`,
`sort`, `grep`, and `kubectl`.

Invalid or tampered reaper markers on unbound PVCs are re-marked, non-empty
markers on referenced PVCs are cleared (empty annotations may remain and are
harmless while referenced), and only trusted PVC metadata names drive annotation
or deletion operations.

## PID limits

Unlike Docker's `--pids-limit`, Kubernetes has **no** per-Pod or per-namespace
process-count cap — `pids` is not a valid `LimitRange`/`ResourceQuota` resource.
Fork-bomb defense is a **node-level** kubelet setting: set `podPidsLimit` in the
kubelet configuration (or `--pod-max-pids`) on the nodes that run sandbox Pods.
The chart cannot template this (it's node config, not a namespaced object). The
provider's `security.pidsLimit` therefore has no effect on the Kubernetes provider.

## Honest scope

- NetworkPolicy enforcement (backstop + per-thread) requires a
  policy-capable CNI (e.g. Calico, Cilium) — this chart does not install
  one.
- Arbitrary non-Dawn pods manually placed in the namespace are not selected by
  this NetworkPolicy backstop and remain the operator's responsibility.
- Pod Security Standards, ResourceQuota, and LimitRange are
  Kubernetes-native admission controls; the chart configures them, but
  enforcement is the cluster's.
- Deferred: multi-namespace tenancy, HPA/autoscaling, a bundled CNI,
  cross-cluster federation, PodDisruptionBudgets.
