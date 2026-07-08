# Dawn App-Deploy Helm Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** `charts/dawn-app/` — a Helm chart that runs a user-built Dawn app image (from `langgraphjs dockerfile`) on Kubernetes as Deployment + Service + optional Ingress/HPA/PDB, wired to the in-cluster `kubernetesSandbox` via the sandbox-infra chart's orchestrator ServiceAccount.

**Architecture:** Templated K8s manifests, schema-validated values. Verification = `helm lint --strict` + a `helm template` render harness + `kubeconform -strict`, and a gated **kind apply-smoke with a placeholder image** (proves Deployment/Service/Ingress/HPA/PDB apply + become Ready without needing a real Dawn app or model key). Publishes to GHCR OCI.

**Tech Stack:** Helm 3, Kubernetes manifests, kubeconform, kind, GHCR OCI.

**Spec:** `docs/superpowers/specs/2026-07-07-dawn-app-deploy-helm-chart-design.md` — READ IT (values surface, SA-wiring modes, honest scope, and the three build-time items to pin down).

**Sibling reference:** `charts/dawn-sandbox-infra/` (SP2, just merged) — mirror its conventions: `_helpers.tpl` labels, `values.schema.json` with `additionalProperties:false`, `test/render.sh` harness, chart layout. The CI `chart-validate` job and `.github/workflows/publish-chart.yml` already exist (from SP2) — EXTEND them, don't duplicate.

**Operating constraints:** work in the worktree on branch `feat/dawn-app-chart`; verify `git branch --show-current` before every commit; do not push (controller pushes). Pin actions/images by SHA/digest. No npm changeset (chart-only). Install `helm`+`kubeconform` locally if missing.

**Build-time items to resolve (from the spec's "Open items"):**
- Container port: default `containerPort: 8000`, but **check `@langchain/langgraph-cli` docs / a generated `langgraphjs dockerfile`** for the real listen port; if it differs, change the default. It's a value regardless, so a mismatch is one line.
- Health path: default `/healthz` (docs say the runtime serves it); verify; expose as `values.healthPath`.
- Writable rootfs: default `readOnlyRootFilesystem: false` for the app container (the langgraph runtime likely writes temp state) with a writable `/tmp` emptyDir — the app pod is least-privilege but not as locked-down as a sandbox pod; document.

---

### Task 1: Scaffold `charts/dawn-app/`
Create Chart.yaml (name `dawn-app`, version `0.1.0`, appVersion `"0.8.9"`), values.yaml (full surface from the spec), values.schema.json (require `image.repository` non-empty; enums/types; `additionalProperties:false`), templates/_helpers.tpl (names + standard Helm labels), README.md, templates/NOTES.txt (print the Service URL + the exact ServiceAccount/namespace wiring instructions incl. the cross-namespace subject to add to the sandbox-infra chart if applicable), .helmignore. Verify `helm lint --strict` (note: with `image.repository` required by schema, lint/template must be run with `--set image.repository=example/app` or a values default that passes schema — set the schema to require it but let `helm lint` pass by providing a lint-values or making repository default `""` with a template-level `required` guard instead of schema-required; choose whichever keeps `helm lint` green while still failing a real install without an image). Commit `feat(chart): scaffold dawn-app (Chart.yaml, values, schema, helpers)`.

### Task 2: Deployment + render harness
`templates/deployment.yaml`: image (repository+tag OR digest; `required` guard on repository), `containerPort` (named `http`), liveness+readiness+startup probes on `healthPath`, env + envFrom (+ `secretName` convenience), resources, hardened-but-app-appropriate securityContext (runAsNonRoot, drop ALL caps, seccomp RuntimeDefault, allowPrivilegeEscalation false; `readOnlyRootFilesystem` from a value defaulting false + a `/tmp` emptyDir), `serviceAccountName` from values, `automountServiceAccountToken: true`, nodeSelector/tolerations/affinity, imagePullSecrets. Omit static `replicas` when `autoscaling.enabled`. Create `test/render.sh` (mirror SP2's harness) asserting the deployment shape (image, probes on `/healthz`, SA name, securityContext, and that `replicas` is absent when autoscaling on). Verify render.sh + `helm template --set image.repository=x/y | kubeconform -strict -ignore-missing-schemas`. Commit `feat(chart): app Deployment + probes + sandbox SA wiring`.

### Task 3: Service
`templates/service.yaml` (type from values default ClusterIP, `port` → `http`). Extend render.sh. Verify. Commit `feat(chart): app Service`.

### Task 4: Ingress (gated)
`templates/ingress.yaml` gated on `ingress.enabled` (className, host, path/pathType, TLS, annotations; `networking.k8s.io/v1`). Extend render.sh (present when enabled, absent by default). Verify kubeconform. Commit `feat(chart): optional Ingress`.

### Task 5: HPA + PDB (gated)
`templates/hpa.yaml` (`autoscaling/v2`, gated `autoscaling.enabled`, targets the Deployment, min/max/targetCPU + optional memory) and `templates/pdb.yaml` (`policy/v1`, gated `podDisruptionBudget.enabled`, minAvailable, selector matches app pods). Extend render.sh (both absent by default; present + valid when enabled; Deployment omits `replicas` when HPA on). Verify. Commit `feat(chart): optional HorizontalPodAutoscaler + PodDisruptionBudget`.

### Task 6: CI — extend chart-validate + gated kind apply-smoke
In `.github/workflows/ci.yml`: (a) extend the existing `chart-validate` job to ALSO lint/render/kubeconform `charts/dawn-app` (default + a full override `--set ingress.enabled=true --set autoscaling.enabled=true --set podDisruptionBudget.enabled=true --set image.repository=traefik/whoami`). (b) Add a gated **`chart-apply-smoke`** job (or a step): spin up a plain kind cluster (no Calico needed — no NetworkPolicy here), `helm install dawn-app charts/dawn-app --set image.repository=traefik/whoami --set image.tag=latest --set containerPort=80 --set healthPath=/ --set serviceAccount.create=true --wait`, then `kubectl rollout status deploy` + `kubectl run` a curl against the Service to get an HTTP 200 — proving the manifests apply and the pod serves. Pin kind-action + images. Validate YAML (`actionlint`). Commit `ci(chart): validate dawn-app + gated kind apply-smoke with placeholder image`.

### Task 7: OCI publish
Extend `.github/workflows/publish-chart.yml` to also publish `charts/dawn-app` when `charts/dawn-app/**` changes (add to `paths` + a matrix/second step over both charts; same version-guard + `helm push oci://ghcr.io/cacheplane/charts`). Commit `ci(chart): publish dawn-app to GHCR OCI`.

### Task 8: Docs + PR
Add a "Deploying a Dawn app (Helm)" section to `apps/web/content/docs/deployment.mdx` (or sandbox.mdx): build the image via `langgraphjs dockerfile`, `helm install dawn-app oci://ghcr.io/cacheplane/charts/dawn-app --set image.repository=...`, the ServiceAccount/namespace wiring (must run under the sandbox-infra orchestrator SA; cross-namespace subject instructions), env/secrets, and the honest note that the chart runs a user-built image + owns only K8s deploy concerns. No banned phrases; gpt-5 model ids only. Run `node scripts/check-docs.mjs`. Full local verify (`helm lint --strict`, `test/render.sh`, `kubeconform`, `check-docs`, `pnpm build && pnpm typecheck`). Rebase on origin/main. Push, open PR `feat(chart): dawn-app deploy Helm chart (Kubernetes arc, sub-project 3)` (body: what it deploys, the langgraph-image model, sandbox-SA wiring, ingress/hpa/pdb, kind apply-smoke, OCI publish; Claude Code footer). Watch CI; address findings.

---

## Self-review (author)
- Spec coverage: image-wrap Deployment (T2) ✓, Service (T3) ✓, Ingress (T4) ✓, HPA+PDB (T5) ✓, sandbox SA wiring (T2/T6/NOTES) ✓, kind apply-smoke (T6) ✓, OCI publish (T7) ✓, docs (T8) ✓. The three open items are resolved as configurable values (T2) so a wrong default is a one-line fix, and the kind smoke uses a placeholder image so it doesn't depend on the real langgraph port.
- Consistency: mirrors `charts/dawn-sandbox-infra` conventions; extends (not duplicates) the shared `chart-validate` job + `publish-chart.yml`.
- Risk: the real langgraph server port/health — mitigated by making them values + smoke-testing with a placeholder; a follow-up can tighten defaults once a real image is validated by an operator.
