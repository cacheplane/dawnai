# Dawn App-Deploy Helm Chart — Design

**Date:** 2026-07-07
**Status:** Approved (brainstorm — foundational decisions locked by the user; execution delegated).
**Sub-project:** 3 of 3 in the "run Dawn on Kubernetes" arc (provider #317 → sandbox-infra chart #321 → **this chart**).

## Goal

A Helm chart, `charts/dawn-app/`, that runs a **built Dawn app** on Kubernetes as a Deployment + Service (+ optional Ingress, HorizontalPodAutoscaler, PodDisruptionBudget), wired to use the in-cluster `kubernetesSandbox` provider via the ServiceAccount + namespace provisioned by the sandbox-infra chart (#321). It completes the "run Dawn on Kubernetes" story: sandbox-infra makes the cluster sandbox-ready; this chart runs your app on it.

## Context & the production-server reality

Dawn has **no bespoke production server**: `dawn dev` is a localhost-only reference runtime, and `dawn build` emits `.dawn/build/langgraph.json` + per-route entry files — the canonical deploy interface. The documented containerization path (docs/deployment.mdx; [[project_dawn_self_host_docker]], PR #278) is to build an image with `@langchain/langgraph-cli` (`langgraphjs dockerfile`) against a root-level `langgraph.json`. The resulting image runs the **LangGraph API server** exposing the Agent-Protocol surface (`/threads/:id/runs/wait`, `/threads/:id/runs/stream`) and a **`/healthz`** health endpoint.

**Decision (user):** the chart **wraps a user-provided image** (built via that path) — it does NOT invent a Dawn base image or a new server. The chart owns the *Kubernetes deployment* concerns; the image owns the *runtime*.

## Decisions (from the brainstorm)

- **App-deploy model:** wrap the `langgraphjs dockerfile` image (`image` value; the user builds + pushes it). Most honest — leans on Dawn's real container story.
- **Scope:** Deployment + Service + Ingress + **sandbox wiring** + **HorizontalPodAutoscaler + PodDisruptionBudget**.

## Architecture

### Chart layout

```
charts/dawn-app/
  Chart.yaml            # name, version (independent SemVer), appVersion 0.8.9
  values.yaml
  values.schema.json
  README.md
  templates/
    _helpers.tpl        # names/labels
    serviceaccount.yaml # optional: bind an existing SA, or reference the sandbox-infra orchestrator SA
    deployment.yaml     # the app pod(s)
    service.yaml
    ingress.yaml        # gated
    hpa.yaml            # gated
    pdb.yaml            # gated
    NOTES.txt
```

### Deployment

- **Image:** `values.image.repository` + `values.image.tag` (or `values.image.digest`) — the user's `langgraphjs dockerfile`-built app image. `imagePullSecrets` supported.
- **Port:** `values.service.port` → container port `values.containerPort` (default `8000` — **the plan must verify the exact port the `langgraphjs dockerfile` image listens on**; expose it as a value so a mismatch is a one-line fix). Named port `http`.
- **Probes:** liveness + readiness HTTP GET on `values.healthPath` (default `/healthz`) at the container port; timings configurable. A startup probe (generous) covers slow cold starts.
- **Env / secrets:** `values.env` (list) + `values.envFrom` (secretRef/configMapRef). Convenience: `values.secretName` mounted via `envFrom` for `OPENAI_API_KEY`, `DATABASE_URL`, etc. — the chart does **not** template secrets (operator supplies them). The app's `dawn.config.ts` (baked into the image) references `kubernetesSandbox`; the chart ensures the **namespace + ServiceAccount align** (below).
- **Resources:** `values.resources` (requests/limits).
- **SecurityContext:** hardened by default (runAsNonRoot, readOnlyRootFilesystem where the runtime allows, drop ALL caps, seccomp RuntimeDefault, allowPrivilegeEscalation false) — the app pod is not a sandbox but should still be least-privilege. Documented opt-out if the langgraph runtime needs write access (a writable `/tmp` emptyDir is provided).
- **ServiceAccount (the sandbox wiring — the crux):** the app process calls the Kubernetes API to create sandbox pods, so its pod must run under a ServiceAccount bound to the sandbox-infra orchestrator Role. Two modes via `values.serviceAccount`:
  - `name: dawn-orchestrator`, `create: false` (default) — reuse the SA the sandbox-infra chart created. **Requires the app to run in the sandbox namespace** (default `dawn-sandboxes`), OR the operator to have added this app's SA as a cross-namespace subject in the sandbox-infra chart's `orchestrator.subjects`. Documented clearly in NOTES.txt + README.
  - `create: true` — the chart creates a SA in the app's namespace; the operator must bind it to the sandbox-infra Role (via that chart's `orchestrator.subjects`) — the chart prints the exact subject to add.
  - `automountServiceAccountToken: true` (the app needs the token to call the API — unlike sandbox pods).

### Service / Ingress / HPA / PDB

- **Service:** ClusterIP, `values.service.port` → `http`. Type configurable (ClusterIP default; LoadBalancer/NodePort allowed).
- **Ingress** (`values.ingress.enabled`, default `false`): `className`, `host`, `path`/`pathType`, TLS (`secretName`), annotations — standard Helm ingress idiom.
- **HPA** (`values.autoscaling.enabled`, default `false`): `autoscaling/v2` HorizontalPodAutoscaler targeting the Deployment; `minReplicas`/`maxReplicas`/`targetCPUUtilizationPercentage` (+ optional memory). When enabled, the Deployment omits a static `replicas` so the HPA owns it.
- **PDB** (`values.podDisruptionBudget.enabled`, default `false`): `policy/v1` PodDisruptionBudget with `minAvailable` (default `1`) selecting the app pods — protects availability during node drains.

### Values surface (defaults, abridged)

```yaml
image:
  repository: ""          # REQUIRED — the user's built app image
  tag: ""                 # or digest:
  pullPolicy: IfNotPresent
imagePullSecrets: []
replicaCount: 1
containerPort: 8000
healthPath: /healthz
service:
  type: ClusterIP
  port: 80
ingress:
  enabled: false
  className: ""
  host: ""
  path: /
  pathType: Prefix
  tls: { enabled: false, secretName: "" }
  annotations: {}
autoscaling:
  enabled: false
  minReplicas: 1
  maxReplicas: 5
  targetCPUUtilizationPercentage: 80
podDisruptionBudget:
  enabled: false
  minAvailable: 1
serviceAccount:
  create: false
  name: dawn-orchestrator      # the sandbox-infra chart's orchestrator SA
sandboxNamespace: dawn-sandboxes   # informational; must match the app's kubernetesSandbox({ namespace })
env: []
envFrom: []
secretName: ""                 # convenience envFrom secretRef
resources: {}
securityContext:               # hardened defaults; see template
  runAsNonRoot: true
podSecurityContext: {}
nodeSelector: {}
tolerations: []
affinity: {}
```

`values.schema.json` requires `image.repository` (fail fast if unset) and validates enums/types.

## Testing

1. **`helm lint --strict`** + a `helm template` render harness (`charts/dawn-app/test/render.sh`) asserting: Deployment with the image + probes + SA + hardened securityContext; Service; Ingress only when enabled; HPA only when enabled (and that `replicas` is omitted from the Deployment then); PDB only when enabled. Both default and a "full" override (ingress+hpa+pdb+custom SA) fixture.
2. **`helm template | kubeconform -strict`** on default + override (autoscaling/v2, policy/v1, networking/v1 Ingress schemas).
3. **Gated kind apply-smoke** — a new gated CI step (reuse or mirror the chart-validate job): `helm install dawn-app` with a **placeholder image** (`values.image.repository=traefik/whoami` or similar, `healthPath=/`) into a kind cluster, `kubectl rollout status` the Deployment, curl the Service — proving the Deployment/Service/Ingress/HPA/PDB actually apply and the pod becomes Ready. This validates the manifests end-to-end **without** needing a real Dawn app image or a model key (which CI can't provide). Document that this proves the *chart*, not a real Dawn app.

## Packaging / release

Extend the chart-publishing story from #321: `publish-chart.yml` gains `charts/dawn-app/**` to its `paths` (or a matrix over both charts), publishing `oci://ghcr.io/cacheplane/charts/dawn-app` on chart changes, version from its own `Chart.yaml`. Independent SemVer.

## Honest scope / out of scope

- The chart runs a **user-built** image; it does not build the image, own a Dawn server, or bake `dawn.config.ts`. The app image is the runtime contract.
- The chart cannot validate a *real* Dawn app end-to-end in CI (needs an app image + model creds) — the kind smoke proves the manifests with a placeholder image; real-app validation is the operator's responsibility, documented.
- Cross-namespace SA binding (app in a different namespace than the sandbox) requires the operator to wire the sandbox-infra chart's `orchestrator.subjects` — the chart documents + prints the exact subject; it does not reach into the other chart's release.
- Deferred: a Dawn-owned base runtime image, GitOps/ArgoCD manifests, service mesh integration, multi-region, blue/green.

## Open items for the plan/build to pin down

1. **The exact port** the `langgraphjs dockerfile` image listens on (inspect the generated Dockerfile's `EXPOSE`/`CMD`, or langgraph-cli docs) — set the `containerPort` default accordingly.
2. **The health endpoint** — confirm `/healthz` is served by the built image (docs say the dev runtime serves it; verify the langgraph-cli production image does too, else use the langgraph server's actual health path).
3. Whether the langgraph server needs a writable filesystem (affects the `readOnlyRootFilesystem` default) — verify against the built image.
