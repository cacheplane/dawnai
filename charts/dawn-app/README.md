# dawn-app

Runs a **user-built Dawn app image** on Kubernetes as a Deployment + Service
(+ optional Ingress, HorizontalPodAutoscaler, and PodDisruptionBudget), wired
to the in-cluster `kubernetesSandbox` provider via the ServiceAccount +
namespace provisioned by the `dawn-sandbox-infra` chart.

This chart does **not** build your image or bake `dawn.config.ts` — it wraps
a **user-built image** and owns only the *Kubernetes deployment* concerns.

**Recommended image source:** `dawn build`'s `node` target (the default —
see [docs/deployment.mdx](../../apps/web/content/docs/deployment.mdx)) emits
a `server.mjs` that boots the real Dawn runtime, plus a hardened
`Dockerfile`. Build that image and point this chart at it. Use the `node`
target whenever `dawn.config.ts` configures `kubernetesSandbox` — only the
Dawn runtime process creates and manages sandbox Pods, so an image built the
alternate way (the `langsmith` target's `langgraph.json`, containerized with
`@langchain/langgraph-cli`'s `langgraphjs dockerfile`) never calls the
sandbox provider even if the config is present.

## Install

```sh
# Build the image via dawn build's node target (default), then:
docker build -t ghcr.io/you/your-app:latest .

helm install dawn-app charts/dawn-app --set image.repository=ghcr.io/you/your-app --set image.tag=latest
```

Or, once published, from GHCR:

```sh
helm install dawn-app oci://ghcr.io/cacheplane/charts/dawn-app --set image.repository=ghcr.io/you/your-app
```

`image.repository` is required — `helm install`/`helm upgrade` will fail
fast with a clear error if it is unset (enforced by a template-level
`required` guard in `templates/deployment.yaml`, not the JSON Schema, so
that `helm lint`/`helm template` still pass without `--set` for CI/dev
convenience).

## Sandbox ServiceAccount wiring (read this)

The app process calls the Kubernetes API to create sandbox Pods, so its Pod
must run under a ServiceAccount bound to the `dawn-sandbox-infra` chart's
orchestrator Role. Two modes via `values.serviceAccount`:

- **`create: false` (default)** — reuse the ServiceAccount named
  `serviceAccount.name` (default `dawn-orchestrator`), the one the
  `dawn-sandbox-infra` chart creates. This works out of the box only if
  this app is installed **in the sandbox namespace** (`sandboxNamespace`,
  default `dawn-sandboxes`), or if the operator has added this app's SA as
  a cross-namespace subject on the `dawn-sandbox-infra` chart's
  `orchestrator.subjects`.
- **`create: true`** — this chart creates a ServiceAccount in the app's own
  namespace; the operator must then bind it to the `dawn-sandbox-infra`
  Role via that chart's `orchestrator.subjects`. `helm install`/`upgrade`
  prints the exact subject to add in the post-install NOTES.

Either way, keep `sandboxNamespace` (informational only) in sync with your
app's `dawn.config.ts`:

```ts
sandbox: {
  provider: kubernetesSandbox({ namespace: "dawn-sandboxes" });
}
```

## Values

| Key | Default | Description |
| --- | --- | --- |
| `image.repository` | `""` | **Required** at install time (see above). |
| `image.tag` | `""` | Falls back to `.Chart.AppVersion` when unset. |
| `image.digest` | `""` | If set, pins `repository@sha256:...` instead of `tag`. |
| `image.pullPolicy` | `IfNotPresent` | |
| `imagePullSecrets` | `[]` | |
| `replicaCount` | `1` | Ignored (omitted) when `autoscaling.enabled=true`. |
| `containerPort` | `8000` | The port your image's HTTP server listens on inside the container — matches `dawn build`'s node-target Dockerfile (`EXPOSE 8000`) by default; verify against your built image if it differs. |
| `healthPath` | `/healthz` | HTTP path used for liveness/readiness/startup probes; matches the node target's `/healthz` by default. |
| `probes.*` | see `values.yaml` | Per-probe timing (initialDelaySeconds/periodSeconds/timeoutSeconds/failureThreshold). |
| `service.type` | `ClusterIP` | |
| `service.port` | `80` | Maps to the named `http` container port. |
| `ingress.enabled` | `false` | Gate the Ingress. |
| `ingress.className` / `host` / `path` / `pathType` / `tls` / `annotations` | see `values.yaml` | Standard Helm ingress idiom. |
| `autoscaling.enabled` | `false` | Gate the HorizontalPodAutoscaler (`autoscaling/v2`). |
| `autoscaling.minReplicas` / `maxReplicas` / `targetCPUUtilizationPercentage` / `targetMemoryUtilizationPercentage` | see `values.yaml` | |
| `podDisruptionBudget.enabled` | `false` | Gate the PodDisruptionBudget (`policy/v1`). |
| `podDisruptionBudget.minAvailable` | `1` | |
| `serviceAccount.create` | `false` | See "Sandbox ServiceAccount wiring" above. |
| `serviceAccount.name` | `dawn-orchestrator` | |
| `automountServiceAccountToken` | `true` | The app needs the token to call the Kubernetes API. |
| `sandboxNamespace` | `dawn-sandboxes` | Informational; must match `dawn-sandbox-infra`'s `namespace.name` and the app's `kubernetesSandbox({ namespace })`. |
| `env` / `envFrom` | `[]` | Standard container env / envFrom. |
| `secretName` | `""` | Convenience `envFrom.secretRef` (e.g. `OPENAI_API_KEY`, `DATABASE_URL`). The chart does **not** template Secrets — supply them out-of-band. |
| `resources` | `{}` | |
| `securityContext.readOnlyRootFilesystem` | `false` | The app runtime likely writes temp state; a writable `/tmp` emptyDir is always mounted regardless. Set `true` if your image tolerates it. |
| `nodeSelector` / `tolerations` / `affinity` | `{}` / `[]` / `{}` | |

## Honest scope

- This chart runs a **user-built** image; it does not build the image or
  bake `dawn.config.ts`. The app image is the runtime contract — build it
  with `dawn build`'s `node` target (recommended, especially with
  `kubernetesSandbox` configured) or containerize the `langsmith` target's
  `langgraph.json` with `langgraphjs dockerfile` if you don't need the
  sandbox.
- It cannot validate a *real* Dawn app end-to-end in CI (that needs an app
  image + model credentials) — CI validates the chart's manifests with a
  placeholder image; real-app validation is the operator's responsibility.
- Cross-namespace ServiceAccount binding requires the operator to wire the
  `dawn-sandbox-infra` chart's `orchestrator.subjects` — this chart
  documents and prints the exact subject; it does not reach into the other
  chart's release.
- Deferred: a Dawn-owned base runtime image, GitOps/ArgoCD manifests,
  service mesh integration, multi-region, blue/green.
