# Sandbox-Infra Helm Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship `charts/dawn-sandbox-infra/` — a Helm chart provisioning the namespace, RBAC, default-deny NetworkPolicy, ResourceQuota/LimitRange, Pod Security Standards, and a self-bookkeeping PVC reaper that the `kubernetesSandbox` provider (#317) requires — plus CI validation, a real-cluster install smoke, and OCI/GHCR publishing.

**Architecture:** A single Helm chart of templated Kubernetes manifests, all tunable via a schema-validated `values.yaml`. Verification is `helm lint` + `helm template | kubeconform` in CI, a `kubectl`-stub unit test for the reaper script, and a gated kind+Calico install smoke that reuses the existing `sandbox-k8s` lane (helm install → run the provider integration suite through the chart's ServiceAccount).

**Tech Stack:** Helm 3, Kubernetes manifests (YAML + Go templates), kubeconform, GHCR OCI registry, GitHub Actions, kind+Calico.

**Spec:** `docs/superpowers/specs/2026-07-07-sandbox-infra-helm-chart-design.md`

**Operating constraints:**
- Work only in the worktree at `/Users/blove/repos/dawn/.claude/worktrees/relaxed-booth-90fa1d` on branch `feat/sandbox-infra-chart`. **Verify `git branch --show-current` before every commit.** Do not push (controller pushes).
- This is a NEW chart, no npm package — **NO changeset needed** (charts version independently via `Chart.yaml`; `scripts/check-changesets.mjs` only requires changesets for `packages/**` source changes — confirm the `charts/**` + `.github/**` + `docs/**` changes here don't trip it; if the `changesets` CI lane fails demanding one, add an empty changeset via `pnpm changeset --empty`).
- Pin every GitHub Action + container image by SHA/digest per repo convention (OSSF Pinned-Dependencies). For actions, copy exact pins from sibling jobs in `.github/workflows/ci.yml`.
- `helm` and `kubeconform` may not be installed locally — the implementer should install them if missing (`brew install helm kubeconform` or the release tarballs) to run the local checks; if truly unavailable, note it and rely on the CI lane.

**Reference:** the provider it serves — `packages/sandbox/src/kubernetes/kube-sandbox.ts` (labels `app.kubernetes.io/managed-by=dawn` + `dawn.sh/thread`, namespace default `dawn-sandboxes`); the RBAC surface enumerated in the spec's Context section; the existing gated lane `sandbox-k8s` in `.github/workflows/ci.yml` (kind + Calico; currently does a manual `kubectl create namespace dawn-sandboxes`).

---

### Task 1: Chart scaffold (Chart.yaml, values, schema, helpers) + helm lint

**Files:** create `charts/dawn-sandbox-infra/{Chart.yaml,values.yaml,values.schema.json,README.md,templates/_helpers.tpl,templates/NOTES.txt,.helmignore}`

- [ ] **Step 1:** `charts/dawn-sandbox-infra/Chart.yaml`:

```yaml
apiVersion: v2
name: dawn-sandbox-infra
description: Cluster-side infrastructure for the Dawn kubernetesSandbox provider — namespace, least-privilege RBAC, default-deny egress, quotas/limits, Pod Security Standards, and a PVC reaper.
type: application
version: 0.1.0
appVersion: "0.8.9"
keywords: [dawn, sandbox, kubernetes, security]
home: https://dawnai.org
sources: [https://github.com/cacheplane/dawnai]
maintainers:
  - name: Dawn
```

- [ ] **Step 2:** `charts/dawn-sandbox-infra/values.yaml` — the full defaults from the spec's "Values surface" section (namespace, podSecurityStandard, orchestrator, networkPolicy, resourceQuota, limitRange, reaper). Copy verbatim from the spec, with the reaper image `docker.io/alpine/k8s:1.31.1`.

- [ ] **Step 3:** `charts/dawn-sandbox-infra/values.schema.json` — a JSON Schema (draft-07) that validates the values tree. Enforce: `podSecurityStandard.enforce`/`.warn`/`.audit` ∈ `["privileged","baseline","restricted"]`; `namespace.name` is a DNS-1123 label (`pattern`); `reaper.ttlHours` and `limitRange.defaultPids` are positive integers; `reaper.schedule` is a string; booleans for the `.enabled`/`.create` flags. `additionalProperties: false` at the top level and per section.

- [ ] **Step 4:** `templates/_helpers.tpl` — define:
  - `dawn-sandbox-infra.namespace` → `{{ .Values.namespace.name }}`
  - `dawn-sandbox-infra.labels` → standard Helm recommended labels (`app.kubernetes.io/name`, `/instance`, `/managed-by: Helm`, `helm.sh/chart`). **Do NOT** emit `app.kubernetes.io/managed-by: dawn` (that's the provider's per-thread marker; the chart's objects must not match the reaper's `-l app.kubernetes.io/managed-by=dawn` selector).
  - `dawn-sandbox-infra.orchestratorSAName` / `.reaperSAName` helpers.

- [ ] **Step 5:** `templates/NOTES.txt` — post-install guidance: the namespace created, and that `dawn.config.ts` `sandbox.provider: kubernetesSandbox({ namespace: "<ns>" })` must match, and the orchestrator SA name to bind an in-cluster Dawn app to.

- [ ] **Step 6:** `.helmignore` (standard) + a short `README.md` (chart purpose, `helm install` example, values table — can be brief; note it may be regenerated).

- [ ] **Step 7: Verify** `helm lint charts/dawn-sandbox-infra` passes (with default values), and `helm lint charts/dawn-sandbox-infra --strict`. Expected: 0 failures. (At this point there are no resource templates yet besides helpers — lint still passes on a chart with only helpers/NOTES.)

- [ ] **Step 8: Commit** `git add charts/dawn-sandbox-infra && git commit -m "feat(chart): scaffold dawn-sandbox-infra (Chart.yaml, values, schema, helpers)"`

---

### Task 2: Namespace + Pod Security Standards template

**Files:** create `templates/namespace.yaml`; test via `helm template`.

- [ ] **Step 1: Write the render check (failing).** Create a local check script `charts/dawn-sandbox-infra/test/render.sh` (used by later tasks too):

```sh
#!/usr/bin/env sh
# Renders the chart and greps assertions. Usage: test/render.sh
set -eu
CHART="$(dirname "$0")/.."
tmpl() { helm template test "$CHART" "$@"; }
assert() { if ! grep -qE "$2"; then echo "FAIL: $1"; exit 1; fi; echo "ok: $1"; }

# Namespace + PSS (default baseline enforce, restricted warn/audit)
tmpl --show-only templates/namespace.yaml | assert "ns name" 'name: dawn-sandboxes'
tmpl --show-only templates/namespace.yaml | assert "pss enforce baseline" 'pod-security.kubernetes.io/enforce: baseline'
tmpl --show-only templates/namespace.yaml | assert "pss warn restricted" 'pod-security.kubernetes.io/warn: restricted'
# Override: enforce restricted
tmpl --show-only templates/namespace.yaml --set podSecurityStandard.enforce=restricted | assert "pss enforce override" 'pod-security.kubernetes.io/enforce: restricted'
echo "render checks passed"
```
`chmod +x` it. Run it → FAILS (no namespace.yaml yet).

- [ ] **Step 2: Implement** `templates/namespace.yaml` (gated on `.Values.namespace.create`):

```yaml
{{- if .Values.namespace.create }}
apiVersion: v1
kind: Namespace
metadata:
  name: {{ include "dawn-sandbox-infra.namespace" . }}
  labels:
    {{- include "dawn-sandbox-infra.labels" . | nindent 4 }}
    pod-security.kubernetes.io/enforce: {{ .Values.podSecurityStandard.enforce }}
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/warn: {{ .Values.podSecurityStandard.warn }}
    pod-security.kubernetes.io/warn-version: latest
    pod-security.kubernetes.io/audit: {{ .Values.podSecurityStandard.audit }}
    pod-security.kubernetes.io/audit-version: latest
{{- end }}
```

- [ ] **Step 3: Verify** `test/render.sh` passes; `helm template test charts/dawn-sandbox-infra | kubeconform -strict -summary` passes (install kubeconform if needed).

- [ ] **Step 4: Commit** `feat(chart): namespace + configurable Pod Security Standards`

---

### Task 3: Orchestrator RBAC (ServiceAccount + Role + RoleBinding)

**Files:** create `templates/rbac-orchestrator.yaml`; extend `test/render.sh`.

- [ ] **Step 1: Extend `test/render.sh`** with assertions: a Role granting `pods`+`persistentvolumeclaims` `create/get/delete`, `pods/exec` `create`, `networkpolicies` `create/get/list/update/delete`; a ServiceAccount named `dawn-orchestrator`; a RoleBinding. Run → FAIL.

- [ ] **Step 2: Implement** `templates/rbac-orchestrator.yaml` — SA (gated on `.Values.orchestrator.serviceAccount.create`), Role with the exact rules from the spec, and a RoleBinding binding the Role to the SA (name from `.Values.orchestrator.serviceAccount.name`) plus any `.Values.orchestrator.subjects`. All in `include "dawn-sandbox-infra.namespace"`. Use the exact rule blocks:

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

- [ ] **Step 3: Verify** render.sh + `helm template | kubeconform -strict`.
- [ ] **Step 4: Commit** `feat(chart): least-privilege orchestrator RBAC matching the provider surface`

---

### Task 4: Default-deny egress NetworkPolicy backstop

**Files:** create `templates/networkpolicy-default-deny.yaml`; extend `test/render.sh`.

- [ ] **Step 1: Extend render.sh** — assert (default) a NetworkPolicy with `podSelector: {}`, `policyTypes: [Egress]`, and a DNS egress rule to kube-system on 53; assert `--set networkPolicy.defaultDenyEgress=false` renders NO such policy. Run → FAIL.

- [ ] **Step 2: Implement** `templates/networkpolicy-default-deny.yaml` (gated on `.Values.networkPolicy.defaultDenyEgress`):

```yaml
{{- if .Values.networkPolicy.defaultDenyEgress }}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: dawn-sandbox-default-deny-egress
  namespace: {{ include "dawn-sandbox-infra.namespace" . }}
  labels:
    {{- include "dawn-sandbox-infra.labels" . | nindent 4 }}
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
{{- end }}
```

- [ ] **Step 3: Verify** render.sh + kubeconform.
- [ ] **Step 4: Commit** `feat(chart): namespace-wide default-deny egress backstop (+DNS)`

---

### Task 5: ResourceQuota + LimitRange (with delegated pids)

**Files:** create `templates/resourcequota.yaml`, `templates/limitrange.yaml`; extend render.sh.

- [ ] **Step 1: Extend render.sh** — assert a ResourceQuota with the `hard` map, and a LimitRange whose `type: Container` `default` includes `pids: "512"` and cpu/memory defaults. Assert `--set resourceQuota.enabled=false` drops the quota. Run → FAIL.

- [ ] **Step 2: Implement** `templates/resourcequota.yaml` (gated) iterating `.Values.resourceQuota.hard`, and `templates/limitrange.yaml` (gated) with:

```yaml
{{- if .Values.limitRange.enabled }}
apiVersion: v1
kind: LimitRange
metadata:
  name: dawn-sandbox-limits
  namespace: {{ include "dawn-sandbox-infra.namespace" . }}
  labels:
    {{- include "dawn-sandbox-infra.labels" . | nindent 4 }}
spec:
  limits:
    - type: Container
      default:
        cpu: {{ .Values.limitRange.default.cpu | quote }}
        memory: {{ .Values.limitRange.default.memory | quote }}
        ephemeral-storage: {{ .Values.limitRange.maxEphemeralStorage | quote }}
        pids: {{ .Values.limitRange.defaultPids | quote }}
      defaultRequest:
        cpu: {{ .Values.limitRange.defaultRequest.cpu | quote }}
        memory: {{ .Values.limitRange.defaultRequest.memory | quote }}
{{- end }}
```
NOTE: `pids` as a LimitRange default is supported by the `SupportPodPidsLimit`/`LimitRange` machinery on modern clusters; if `kubeconform`'s schema rejects `pids` under LimitRange `default`, keep it (it's valid against the live API) but pass `kubeconform` a `-ignore-missing-schemas` or the appropriate k8s schema version — document the choice.

- [ ] **Step 3: Verify** render.sh + kubeconform (see the pids note).
- [ ] **Step 4: Commit** `feat(chart): ResourceQuota + LimitRange carrying the delegated pids cap`

---

### Task 6: PVC reaper — RBAC, script, CronJob + reaper unit test

**Files:** create `templates/reaper-rbac.yaml`, `templates/reaper-cronjob.yaml`, `charts/dawn-sandbox-infra/files/reaper.sh`, `charts/dawn-sandbox-infra/test/reaper.test.sh`.

- [ ] **Step 1: Write the reaper script** `files/reaper.sh` (epoch-seconds bookkeeping — portable integer math, no date parsing):

```sh
#!/usr/bin/env sh
set -eu
NS="${DAWN_SANDBOX_NS:?}"
TTL_SECONDS="${DAWN_REAPER_TTL_SECONDS:?}"
NOW="$(date -u +%s)"

# claimNames currently referenced by any pod in the namespace
BOUND="$(kubectl -n "$NS" get pods -o jsonpath='{range .items[*]}{range .spec.volumes[*]}{.persistentVolumeClaim.claimName}{"\n"}{end}{end}' | sort -u)"

# managed PVCs: "<name> <unbound-since-or-empty>"
kubectl -n "$NS" get pvc -l app.kubernetes.io/managed-by=dawn \
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.annotations.dawn\.sh/unbound-since}{"\n"}{end}' \
| while read -r NAME SINCE; do
    [ -z "$NAME" ] && continue
    if printf '%s\n' "$BOUND" | grep -qx "$NAME"; then
      # bound → clear any marker
      [ -n "${SINCE:-}" ] && kubectl -n "$NS" annotate pvc "$NAME" dawn.sh/unbound-since- >/dev/null 2>&1 || true
      continue
    fi
    if [ -z "${SINCE:-}" ]; then
      kubectl -n "$NS" annotate --overwrite pvc "$NAME" "dawn.sh/unbound-since=$NOW" >/dev/null
      echo "marked $NAME"
    else
      AGE=$(( NOW - SINCE ))
      if [ "$AGE" -gt "$TTL_SECONDS" ]; then
        kubectl -n "$NS" delete pvc "$NAME" >/dev/null
        echo "reaped $NAME (unbound ${AGE}s)"
      fi
    fi
  done
```

- [ ] **Step 2: Write the reaper unit test** `test/reaper.test.sh` — a self-contained test using a **stub `kubectl`** on PATH that serves canned responses from fixture files and records mutations, asserting: (a) an unbound PVC with no marker gets annotated; (b) an unbound PVC whose marker is older than TTL gets deleted; (c) a bound PVC gets its marker cleared; (d) an unbound PVC within TTL is left alone. Structure:

```sh
#!/usr/bin/env sh
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$(mktemp -d)"; export PATH="$BIN:$PATH"
CALLS="$BIN/calls.log"; : > "$CALLS"
# stub kubectl: dispatch on args, echo canned data, log mutations
cat > "$BIN/kubectl" <<'STUB'
#!/usr/bin/env sh
echo "kubectl $*" >> "$CALLS"
case "$*" in
  *"get pods"*) cat "$FIX/pods.jsonpath" ;;
  *"get pvc"*"jsonpath"*) cat "$FIX/pvc.jsonpath" ;;
  *"annotate"*|*"delete"*) : ;;  # mutation: just logged
esac
STUB
chmod +x "$BIN/kubectl"
export CALLS FIX="$DIR/fixtures"
# fixtures: pods.jsonpath lists bound claim "dawn-sbx-vol-bound";
# pvc.jsonpath lists: bound(marked), fresh-unbound(no marker), stale-unbound(old marker)
DAWN_SANDBOX_NS=ns DAWN_REAPER_TTL_SECONDS=3600 sh "$DIR/../files/reaper.sh"
grep -q "annotate.*dawn.sh/unbound-since=" "$CALLS" || { echo FAIL mark; exit 1; }   # fresh marked
grep -q "delete pvc dawn-sbx-vol-stale" "$CALLS" || { echo FAIL reap; exit 1; }       # stale reaped
grep -q "annotate pvc dawn-sbx-vol-bound dawn.sh/unbound-since-" "$CALLS" || { echo FAIL clear; exit 1; }
echo "reaper test passed"
```
Create the `test/fixtures/pods.jsonpath` and `test/fixtures/pvc.jsonpath` with the three PVCs described (use a stale `unbound-since` far in the past, e.g. `1000000000`). Run → the test must exercise real branch logic; fix the script/test until green.

- [ ] **Step 3: Implement `templates/reaper-rbac.yaml`** — reaper SA (`dawn-reaper`) + Role (`pvc` get/list/patch/delete, `pods` list) + RoleBinding. And `templates/reaper-cronjob.yaml` (gated on `.Values.reaper.enabled`): a CronJob at `.Values.reaper.schedule`, `serviceAccountName: dawn-reaper`, one container from `.Values.reaper.image` running the script (mount it via a ConfigMap generated with `.Files.Get "files/reaper.sh"`, or inline the script in the CronJob command), env `DAWN_SANDBOX_NS` = namespace and `DAWN_REAPER_TTL_SECONDS` = `{{ mul .Values.reaper.ttlHours 3600 }}`. The reaper pod's `securityContext` MUST be hardened (runAsNonRoot, runAsUser 65532, readOnlyRootFilesystem true, allowPrivilegeEscalation false, capabilities drop ALL, seccompProfile RuntimeDefault) so it passes the namespace PSS. Use a ConfigMap + projected volume for the script (read-only rootfs friendly).

- [ ] **Step 4: Extend `test/render.sh`** — assert the CronJob renders with the hardened securityContext + correct SA + TTL env; assert `--set reaper.enabled=false` drops it.

- [ ] **Step 5: Verify** `test/reaper.test.sh` green, `test/render.sh` green, `helm template | kubeconform -strict`.
- [ ] **Step 6: Commit** `feat(chart): self-bookkeeping PVC reaper (CronJob + least-priv RBAC + tested script)`

---

### Task 7: CI chart lint/validate + wire the sandbox-k8s lane through the chart

**Files:** modify `.github/workflows/ci.yml`.

- [ ] **Step 1:** Add a `chart-validate` job (mirror sibling job setup pins): install helm (`azure/setup-helm@<pin>`) + kubeconform, run `helm lint --strict charts/dawn-sandbox-infra`, `sh charts/dawn-sandbox-infra/test/reaper.test.sh`, `sh charts/dawn-sandbox-infra/test/render.sh`, and `helm template test charts/dawn-sandbox-infra | kubeconform -strict -summary -ignore-missing-schemas` for both default and an `enforce=restricted, reaper.enabled=false` override.

- [ ] **Step 2:** In the existing `sandbox-k8s` job, REPLACE the `Create sandbox namespace` step (`kubectl create namespace dawn-sandboxes`) with:
```yaml
      - name: Install sandbox-infra chart
        run: |
          helm install dawn-sandbox-infra charts/dawn-sandbox-infra --wait
          kubectl -n dawn-sandboxes get role,rolebinding,networkpolicy,resourcequota,limitrange,cronjob
```
(Add a helm setup step to that job.) This proves the chart stands up and the provider's integration suite then runs against the chart-created namespace. (Keep the provider suite running with the CI kubeconfig's default admin context for now — a full "run as the dawn-orchestrator SA token" switch is a nice-to-have; if quick, add it, else leave a comment noting the RBAC is validated by `helm template` + a `kubectl auth can-i --as=system:serviceaccount:dawn-sandboxes:dawn-orchestrator create pods -n dawn-sandboxes` assertion step.)

- [ ] **Step 3:** Add a `kubectl auth can-i` RBAC assertion step to `sandbox-k8s` (after install): assert the orchestrator SA can create pods, pods/exec, pvcs, networkpolicies and CANNOT create e.g. secrets (negative check) — proving least-privilege. This is the real RBAC proof.

- [ ] **Step 4:** Validate YAML parses (`actionlint` if available). Commit `ci(chart): lint/kubeconform + install the chart in the sandbox-k8s lane + RBAC assertions`.

---

### Task 8: OCI publish workflow

**Files:** create `.github/workflows/publish-chart.yml`.

- [ ] **Step 1:** New workflow triggered `on: push: branches: [main], paths: ["charts/dawn-sandbox-infra/**"]`, `permissions: { contents: read, packages: write }`. Steps: checkout, `azure/setup-helm@<pin>`, `helm registry login ghcr.io -u ${{ github.actor }} -p ${{ secrets.GITHUB_TOKEN }}`, read the chart version from `Chart.yaml`, **guard**: `helm show chart oci://ghcr.io/cacheplane/charts/dawn-sandbox-infra --version <v>` — if it succeeds (already published) skip; else `helm package charts/dawn-sandbox-infra -d /tmp` + `helm push /tmp/dawn-sandbox-infra-<v>.tgz oci://ghcr.io/cacheplane/charts`.

- [ ] **Step 2:** Commit `ci(chart): publish dawn-sandbox-infra to GHCR OCI on chart changes`.

Note to controller: the OCI push only runs post-merge on main; its real validation is the first merge. The GHCR package may need to be made public in repo settings (flag for the user).

---

### Task 9: Docs + PR

**Files:** modify `apps/web/content/docs/sandbox.mdx` (or a new page); `charts/dawn-sandbox-infra/README.md`.

- [ ] **Step 1:** Add a "Deploying the sandbox infrastructure (Helm)" section to `sandbox.mdx`: `helm install` from OCI (`oci://ghcr.io/cacheplane/charts/dawn-sandbox-infra`) or local; what it provisions; the key values (namespace must match the provider's `namespace`; PSS default + how to tighten to restricted; reaper TTL; default-deny-egress caveat that it makes `network:allow` still-denied unless disabled); and that it's sub-project 2 of the K8s arc (app-deploy chart follows). No banned phrases (`check-docs.mjs`); any model id gpt-5 family. Run `node scripts/check-docs.mjs`.

- [ ] **Step 2:** Full local validation: `helm lint --strict`, both `test/*.sh`, `helm template | kubeconform`, `node scripts/check-docs.mjs`, and `pnpm build && pnpm typecheck` (confirm the non-chart repo still builds — the chart changes shouldn't affect it, but the docs page does). Rebase on origin/main.

- [ ] **Step 3:** Push, open PR titled `feat(chart): dawn-sandbox-infra Helm chart (sub-project 2)`, body summarizing what it provisions, the security posture (least-priv RBAC, default-deny backstop, PSS baseline/restricted, delegated pids), the reaper design, the chart wired into the sandbox-k8s lane as an install smoke, and OCI publishing. End body with the Claude Code footer. Watch CI (`chart-validate`, `sandbox-k8s`, `validate`, `review`); address findings; confirm no accidental 1.0.0 (N/A — no npm changeset).

---

## Self-review notes (author)
- **Spec coverage:** namespace+PSS (T2) ✓; orchestrator RBAC exact surface (T3) ✓; default-deny backstop (T4) ✓; quota+LimitRange+pids (T5) ✓; self-bookkeeping reaper w/ epoch math + hardened pod + least-priv SA + unit test (T6) ✓; CI lint/kubeconform + install smoke + RBAC can-i proof (T7) ✓; OCI publish (T8) ✓; docs (T9) ✓.
- **Consistency:** namespace via the `dawn-sandbox-infra.namespace` helper everywhere; the chart's own labels deliberately exclude `managed-by: dawn` so they don't match the reaper selector; reaper TTL threaded as `ttlHours*3600` seconds into the script env.
- **Known risks flagged in-plan:** kubeconform schema for LimitRange `pids` (T5 note); running the provider suite as the SA token vs admin (T7 — RBAC proven via `auth can-i` regardless); GHCR package visibility (T8 note).
