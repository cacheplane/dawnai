# dawn-sandbox-infra

Cluster-side infrastructure for the Dawn `kubernetesSandbox` provider
(`@dawn-ai/sandbox`). One `helm install` makes a cluster "sandbox-ready":

- A **namespace** (default `dawn-sandboxes`) with configurable **Pod
  Security Standard** labels.
- Least-privilege **RBAC** for the orchestrator — exactly the API surface
  the provider needs (pods, pods/exec, persistentvolumeclaims,
  networkpolicies), nothing more.
- A namespace-wide **default-deny egress NetworkPolicy** backstop (+ DNS
  carve-out), defense in depth alongside the provider's per-thread
  policies.
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

```sh
helm install dawn-sandbox-infra charts/dawn-sandbox-infra
```

Or, once published, from GHCR:

```sh
helm install dawn-sandbox-infra oci://ghcr.io/cacheplane/charts/dawn-sandbox-infra
```

Then point `dawn.config.ts` at the same namespace:

```ts
sandbox: {
  provider: kubernetesSandbox({ namespace: "dawn-sandboxes" });
}
```

## Values

| Key | Default | Description |
| --- | --- | --- |
| `namespace.create` | `true` | Whether the chart creates the namespace. |
| `namespace.name` | `dawn-sandboxes` | Namespace the provider's `opts.namespace` must match. |
| `podSecurityStandard.enforce` | `baseline` | `privileged` \| `baseline` \| `restricted`. |
| `podSecurityStandard.warn` | `restricted` | Same enum. |
| `podSecurityStandard.audit` | `restricted` | Same enum. |
| `orchestrator.serviceAccount.create` | `true` | Create the orchestrator ServiceAccount. |
| `orchestrator.serviceAccount.name` | `dawn-orchestrator` | SA name (also used to bind an existing SA when `create=false`). |
| `orchestrator.subjects` | `[]` | Extra RoleBinding subjects (e.g. a cross-namespace SA). |
| `networkPolicy.defaultDenyEgress` | `true` | Namespace-wide egress backstop. **Note:** with this on, the provider's per-thread `network: "allow"` mode is still denied at the namespace level — set this to `false` if you need working allow-mode. |
| `resourceQuota.enabled` | `true` | Gate the ResourceQuota. |
| `resourceQuota.hard` | see `values.yaml` | Aggregate namespace caps. |
| `limitRange.enabled` | `true` | Gate the LimitRange. |

## PID limits

Unlike Docker's `--pids-limit`, Kubernetes has **no** per-Pod or per-namespace
process-count cap — `pids` is not a valid `LimitRange`/`ResourceQuota` resource.
Fork-bomb defense is a **node-level** kubelet setting: set `podPidsLimit` in the
kubelet configuration (or `--pod-max-pids`) on the nodes that run sandbox Pods.
The chart cannot template this (it's node config, not a namespaced object). The
provider's `security.pidsLimit` therefore has no effect on the Kubernetes provider.
| `limitRange.default` | `{cpu: "1", memory: 512Mi}` | Container default limits. |
| `limitRange.defaultRequest` | `{cpu: 100m, memory: 128Mi}` | Container default requests. |
| `limitRange.maxEphemeralStorage` | `1Gi` | Container default ephemeral-storage limit. |
| `reaper.enabled` | `true` | Gate the PVC reaper CronJob. |
| `reaper.schedule` | `"17 * * * *"` | Cron schedule (hourly by default). |
| `reaper.ttlHours` | `168` | Hours a PVC may stay continuously unbound before deletion. |
| `reaper.image` | `docker.io/alpine/k8s:1.31.1` | Image bundling `sh` + `date` + `kubectl`. |

## Honest scope

- NetworkPolicy enforcement (backstop + per-thread) requires a
  policy-capable CNI (e.g. Calico, Cilium) — this chart does not install
  one.
- Pod Security Standards, ResourceQuota, and LimitRange are
  Kubernetes-native admission controls; the chart configures them, but
  enforcement is the cluster's.
- Deferred: multi-namespace tenancy, HPA/autoscaling, a bundled CNI,
  cross-cluster federation, PodDisruptionBudgets.
