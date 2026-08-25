# dawn-app

Runs a **user-built Dawn app image** on Kubernetes as a Deployment + Service
(+ optional Ingress, HorizontalPodAutoscaler, and PodDisruptionBudget).
The application runs under an application-owned ServiceAccount in the `dawn-app` management namespace.
That ServiceAccount is bound as a cross-namespace subject to the `dawn-sandbox-infra` orchestrator Role in `dawn-sandboxes`.

This chart does **not** build your image or bake `dawn.config.ts` — it wraps
a **user-built image** and owns only the *Kubernetes deployment* concerns.

**Recommended image source:** `dawn build`'s `node` target (the default —
see [Node and Docker](../../apps/web/content/docs/deployment/node.mdx)) emits
a `.dawn/build/server.mjs` that boots the Dawn HTTP runtime, plus a generated
`Dockerfile`. Build that image and point this chart at it. The chart's Service
and HTTP probes require this Node-target server contract. LangSmith graph
artifacts are platform deployment artifacts, not compatible chart images. See the
[Kubernetes app guide](../../apps/web/content/docs/deployment/kubernetes.mdx)
for the complete image, chart, ServiceAccount, probe, and scaling path.

## Install

Build and publish the Node-target image from the Dawn application root.
Create or merge a secret-safe `.dockerignore` before the first build:

```text
.env
.env.*
.git
.github
node_modules
**/node_modules
coverage
.next
*.log
.dawn/*
!.dawn/build
!.dawn/build/**
```

The `.dawn/*` rule excludes local Dawn runtime state while the two negations
explicitly preserve the generated `.dawn/build` artifacts required by the
image. Add any application-specific build output or credential files to the
exclusions as well.

The generated Dockerfile uses `COPY . .`, so every unignored file in the build
context can be baked into an image layer. Deleting a file in a later Dockerfile
instruction or injecting runtime secrets later does not remove it from that
earlier layer. Inspect the context before building and keep credentials outside
it.

Keep the immutable tag identical through build, push, and chart values:

```sh
dawn check
dawn build
docker build -t ghcr.io/you/your-app:2026-08-10 .
docker push ghcr.io/you/your-app:2026-08-10
```

For a local checkout of an app that configures `kubernetesSandbox`, keep the application,
credentials, and both Helm releases in the dawn-app management namespace
while sandbox resources live in `dawn-sandboxes`. Prepare
`dawn-sandbox-infra-values.yaml` with the planned app ServiceAccount as an
`orchestrator.subjects` entry, then install the sandbox infrastructure first:

```sh
helm upgrade --install dawn-sandbox-infra ./charts/dawn-sandbox-infra \
  --namespace dawn-app \
  --create-namespace \
  --values dawn-sandbox-infra-values.yaml
```

Then install the local application chart with an application-owned
ServiceAccount in the management namespace:

```sh
helm upgrade --install dawn-app ./charts/dawn-app \
  --namespace dawn-app \
  --set image.repository=ghcr.io/you/your-app \
  --set image.tag=2026-08-10 \
  --set serviceAccount.create=true \
  --set serviceAccount.name=dawn-app
```

Or, once published, from GHCR:

```sh
helm upgrade --install dawn-app oci://ghcr.io/cacheplane/charts/dawn-app \
  --namespace dawn-app \
  --set image.repository=ghcr.io/you/your-app \
  --set image.tag=2026-08-10 \
  --set serviceAccount.create=true \
  --set serviceAccount.name=dawn-app
```

`image.repository` is required — `helm install`/`helm upgrade` will fail
fast with a clear error if it is unset. The guard is template-level rather
than in the JSON Schema: bare `helm lint --strict` prints the missing-value
warning but returns zero with that warning, while `helm template` fails when `image.repository` is unset. Pass an image repository to every real render or install.

## Sandbox ServiceAccount wiring (read this)

The app process calls the Kubernetes API to create sandbox Pods, so its Pod
must run under a ServiceAccount bound to the `dawn-sandbox-infra` chart's
orchestrator Role:

- **`create: true` (recommended for sandbox apps)** — this chart creates the
  application ServiceAccount in the management namespace. Bind it as a
  cross-namespace `orchestrator.subjects` entry before installing the app.
- **`create: false` (chart default)** — reuse an existing ServiceAccount in
  the management namespace. That ServiceAccount still needs the same
  cross-namespace RoleBinding entry.

For an existing infrastructure release, export its effective values before an
RBAC update. The edited `orchestrator.subjects` must be the complete intended subject list:
preserve every existing item and append the app ServiceAccount.
Helm replaces arrays, so never use a guessed numeric subject index. The
[Kubernetes app guide](../../apps/web/content/docs/deployment/kubernetes.mdx)
and post-install NOTES provide the ordered commands.

Either way, keep `sandboxNamespace` (informational only) in sync with your
app's `dawn.config.ts`:

```ts
sandbox: {
  provider: kubernetesSandbox({ namespace: "dawn-sandboxes" })
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
| `replicaCount` | `1` | Ignored (omitted) when `autoscaling.enabled=true`. Keep the conservative default until the "Scaling requirements" below are satisfied. |
| `containerPort` | `8000` | The port your image's HTTP server listens on inside the container — matches `dawn build`'s node-target Dockerfile (`EXPOSE 8000`) by default; verify against your built image if it differs. |
| `healthPath` | `/healthz` | Common HTTP path used for liveness/readiness/startup probes; Dawn's default response is a process liveness check, not dependency readiness. |
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
| `automountServiceAccountToken` | `true` | Required when the app calls the Kubernetes API for `kubernetesSandbox`; disable it for apps without that provider where the setup allows. |
| `sandboxNamespace` | `dawn-sandboxes` | Informational; must match `dawn-sandbox-infra`'s `namespace.name` and the app's `kubernetesSandbox({ namespace })`. |
| `env` / `envFrom` | `[]` | Standard container env / envFrom. |
| `secretName` | `""` | Convenience `envFrom.secretRef` (e.g. `OPENAI_API_KEY`, `DATABASE_URL`). The chart does **not** template Secrets — supply them out-of-band. |
| `resources` | `{}` | |
| `securityContext.readOnlyRootFilesystem` | `false` | The app runtime likely writes temp state; a writable `/tmp` emptyDir is always mounted regardless. Set `true` if your image tolerates it. |
| `nodeSelector` / `tolerations` / `affinity` | `{}` / `[]` / `{}` | |

### Scaling requirements

Postgres can share Dawn checkpoints, thread metadata, and permission decisions
between replicas. Long-term memory is configured separately, and local
workspace or sandbox-volume durability remains a separate concern.

Shared stores are necessary but insufficient for horizontal scaling. The
active one-run-per-thread gate and `POST /threads/:id/cancel` registry remain
in-memory and process-local. Multiple replicas need guaranteed thread-aware
routing to one owning process, or distributed per-thread serialization plus
cancel routing. An HPA changes replica count and a PodDisruptionBudget limits
disruption; neither supplies that Dawn coordination.

`/healthz` is a process probe, not dependency readiness. It does not query the
configured Postgres database, model provider, or sandbox provider.

The chart keeps a conservative `replicaCount: 1` default and does not enforce
the coordination requirements. Autoscaling values can render more replicas,
so the operator must leave autoscaling disabled until routing, serialization,
cancel ownership, and every required shared store are in place.

## Honest scope

- **One replica by default** — see "Scaling requirements" above. The chart
  exposes replica and autoscaling controls but cannot validate Dawn's routing
  or distributed coordination.
- This chart runs a **user-built** image; it does not build the image or
  bake `dawn.config.ts`. The image contract is the Node target's Dawn HTTP
  server at `.dawn/build/server.mjs`; the chart's Service and probes do not
  turn graph-only platform artifacts into an HTTP application.
- It cannot validate a *real* Dawn app end-to-end in CI (that needs an app
  image + model credentials) — CI validates the chart's manifests with a
  placeholder image; real-app validation is the operator's responsibility.
- Cross-namespace ServiceAccount binding requires the operator to wire the
  `dawn-sandbox-infra` chart's `orchestrator.subjects` — this chart
  documents and prints the exact subject; it does not reach into the other
  chart's release.
- Deferred: a Dawn-owned base runtime image, GitOps/ArgoCD manifests,
  service mesh integration, multi-region, blue/green.
