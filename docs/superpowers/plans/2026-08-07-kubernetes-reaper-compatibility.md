# Kubernetes Reaper Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Helm chart's PVC reaper within Kubernetes' supported client skew, preserve default-deny behavior for Dawn sandbox pods, and prove both behaviors in CI.

**Architecture:** Pin the default reaper and Kind node images by multi-architecture digest, then parse those configuration surfaces in the existing sandbox workflow-policy test to enforce the one-minor skew contract. Scope the chart backstop to provider-managed pods so Helm control-plane jobs can reach the API, and extend the existing Calico-enabled lane with deterministic network-policy and reaper runtime checks.

**Tech Stack:** Helm 3, Kubernetes/Kind, Calico, POSIX shell, TypeScript, Vitest, `yaml`, pnpm.

---

### Task 1: Pin and enforce the Kubernetes version contract

**Files:**
- Modify: `packages/sandbox/test/ci-workflow-pins.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `charts/dawn-sandbox-infra/values.yaml`

- [ ] **Step 1: Write failing policy tests**

Extend `collectKubernetesPins` to collect each Kind step's `with.node_image`.
Load `charts/dawn-sandbox-infra/values.yaml` with `yaml.parse`, validate the
reaper image shape, and add tests requiring these exact references:

```ts
const approvedKindNodeImage =
  "kindest/node:v1.35.0@sha256:4613778f3cfcd10e615029370f5786704559103cf27bef934597ba562b269661"
const approvedReaperImage =
  "docker.io/alpine/k8s:1.35.6@sha256:b7a12c5ddf261994c33d2eaaa06fd69a0803ff6b38683bfa3d30a76dcdf92807"

function kubernetesMinor(image: string): number {
  const match = image.match(/:v?\d+\.(\d+)\.\d+@sha256:[a-f0-9]{64}$/)
  if (match?.[1] === undefined) throw new Error(`invalid pinned Kubernetes image: ${image}`)
  return Number.parseInt(match[1], 10)
}
```

Assertions:

```ts
expect(ciPins.kindNodeImages).toEqual(Array.from({ length: 3 }, () => approvedKindNodeImage))
expect(reaperImage).toBe(approvedReaperImage)
for (const nodeImage of ciPins.kindNodeImages) {
  expect(Math.abs(kubernetesMinor(nodeImage) - kubernetesMinor(reaperImage))).toBeLessThanOrEqual(1)
}
```

Preserve and extend the synthetic parser test so quoted `node_image` values are
collected. Add unit cases proving malformed or non-digest references throw.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
pnpm --filter @dawn-ai/sandbox test ci-workflow-pins
```

Expected: FAIL because active Kind steps have no explicit `node_image` and the
chart still defaults to reaper 1.31.1.

- [ ] **Step 3: Add the approved pins**

Add this input to all three active `helm/kind-action` steps:

```yaml
node_image: kindest/node:v1.35.0@sha256:4613778f3cfcd10e615029370f5786704559103cf27bef934597ba562b269661
```

Change `reaper.image` in `charts/dawn-sandbox-infra/values.yaml` to:

```yaml
image: docker.io/alpine/k8s:1.35.6@sha256:b7a12c5ddf261994c33d2eaaa06fd69a0803ff6b38683bfa3d30a76dcdf92807
```

Keep the inline digest-pinning explanation and update the command-dependency
comment to mention `sh`, `date`, `sort`, `grep`, and `kubectl`.

- [ ] **Step 4: Run focused verification**

```bash
pnpm --filter @dawn-ai/sandbox test ci-workflow-pins
sh charts/dawn-sandbox-infra/test/render.sh
helm lint --strict charts/dawn-sandbox-infra
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/test/ci-workflow-pins.test.ts .github/workflows/ci.yml charts/dawn-sandbox-infra/values.yaml
git commit -m "fix(charts): align reaper Kubernetes client"
```

### Task 2: Scope and prove the chart egress backstop

**Files:**
- Modify: `charts/dawn-sandbox-infra/test/render.sh`
- Modify: `charts/dawn-sandbox-infra/templates/networkpolicy-default-deny.yaml`
- Create: `test/k8s-smoke/setup-network-policy-control.sh`
- Modify: `packages/sandbox/test/kube-sandbox.integration.test.ts`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write failing render and integration tests**

Replace the render assertion for `podSelector: {}` with assertions for:

```yaml
podSelector:
  matchLabels:
    app.kubernetes.io/managed-by: dawn
```

In `kube-sandbox.integration.test.ts`, create a real `NetworkingV1Api` from the
ambient kubeconfig. Add a gated test that:

1. requires `DAWN_TEST_K8S_EGRESS_CONTROL_URL`;
2. acquires a fresh sandbox with `network: { mode: "allow" }`;
3. lists namespace NetworkPolicies and asserts none has the sandbox's
   `dawn.sh/thread` label;
4. executes a Node `fetch` to the control URL with a five-second timeout;
5. first uses Node DNS APIs to resolve the control service hostname and
   requires success;
6. expects the HTTP fetch to return a nonzero exit and `BLOCKED` output;
7. destroys the sandbox in `finally`.

- [ ] **Step 2: Run tests and confirm the render failure**

```bash
sh charts/dawn-sandbox-infra/test/render.sh
pnpm --filter @dawn-ai/sandbox test kube-sandbox.integration
```

Expected: render FAILS because the policy still selects all pods. The gated
integration file remains skipped locally without `DAWN_TEST_K8S=1`.

- [ ] **Step 3: Scope the NetworkPolicy selector**

Change `templates/networkpolicy-default-deny.yaml` to:

```yaml
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/managed-by: dawn
  policyTypes: [Egress]
```

Do not change DNS egress rules or the `defaultDenyEgress` values API.

- [ ] **Step 4: Add the deterministic control service**

Create `test/k8s-smoke/setup-network-policy-control.sh` with `set -eu`. It must:

- use namespace `DAWN_TEST_K8S_NS` or `dawn-sandboxes`;
- delete stale `dawn-egress-control` client, service, and pod fixtures;
- create an unlabeled-by-Dawn `node:22-slim` pod running a Node HTTP server on
  port 8080 with an HTTP readiness probe;
- expose it as service `dawn-egress-control`;
- wait for the server pod to become Ready;
- wait for the readiness probe, then run a separate unlabeled `node:22-slim`
  client pod that fetches `http://dawn-egress-control:8080/` and requires
  status 200;
- print the fully qualified control URL for diagnostics.

The setup script is idempotent and leaves the server running for the Vitest
suite. Add a cleanup trap for the one-off client.

- [ ] **Step 5: Wire the control into the Calico lane**

After chart installation and before the package integration suite, add:

```yaml
- name: Prepare chart NetworkPolicy control
  run: sh test/k8s-smoke/setup-network-policy-control.sh

- name: Real-cluster sandbox conformance + e2e
  env:
    DAWN_TEST_K8S_EGRESS_CONTROL_URL: http://dawn-egress-control:8080/
  run: DAWN_TEST_K8S=1 pnpm --filter @dawn-ai/sandbox test kube-sandbox.integration
```

- [ ] **Step 6: Run focused verification**

```bash
sh charts/dawn-sandbox-infra/test/render.sh
pnpm --filter @dawn-ai/sandbox test
helm lint --strict charts/dawn-sandbox-infra
```

Expected: PASS. The real allow-mode assertion runs only in the hosted/local
Calico lane.

- [ ] **Step 7: Commit**

```bash
git add charts/dawn-sandbox-infra/test/render.sh charts/dawn-sandbox-infra/templates/networkpolicy-default-deny.yaml test/k8s-smoke/setup-network-policy-control.sh packages/sandbox/test/kube-sandbox.integration.test.ts .github/workflows/ci.yml
git commit -m "fix(charts): scope sandbox egress backstop"
```

### Task 3: Exercise the installed reaper against real PVCs

**Files:**
- Create: `test/k8s-smoke/assert-reaper.sh`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the failing CI smoke entrypoint**

Add a step after the real-cluster provider suite:

```yaml
- name: Exercise PVC reaper
  run: sh test/k8s-smoke/assert-reaper.sh
```

Create a disposable Kind cluster using the approved node image, install the
chart, then run `sh test/k8s-smoke/assert-reaper.sh` and confirm it fails because
the script does not exist. Download Kind v0.31.0 to `/tmp` when the binary is
not installed locally. Keep the cluster for the green run in Step 3.

- [ ] **Step 2: Implement the reaper smoke script**

Create `test/k8s-smoke/assert-reaper.sh` with `set -eu`. Use fixed fixture names
under `DAWN_TEST_K8S_NS` or `dawn-sandboxes` and a trap that deletes the smoke
Job, pod, and PVCs.

The script must first delete any stale smoke Job, pod, and PVCs so interrupted
or repeated runs start clean. It then must:

1. calculate a positive epoch marker older than the chart's 168-hour TTL;
2. create three `storageClassName: ""` PVCs labeled
   `app.kubernetes.io/managed-by: dawn`:
   `dawn-reaper-smoke-stale`, `dawn-reaper-smoke-new`, and
   `dawn-reaper-smoke-referenced`;
3. put the old marker on stale and referenced PVCs;
4. create a pod spec referencing the referenced PVC (it need not become
   Running; the reaper inspects pod volume references);
5. run `kubectl create job --from=cronjob/dawn-reaper dawn-reaper-smoke`;
6. wait up to 120 seconds for Job completion and print logs on failure;
7. require the stale PVC to be absent;
8. require the new PVC's marker to be a positive integer;
9. require the referenced PVC to remain and have no marker;
10. print the Job logs and a success message.

- [ ] **Step 3: Run the green Kind smoke and focused checks**

```bash
sh -n test/k8s-smoke/assert-reaper.sh
pnpm --filter @dawn-ai/sandbox test ci-workflow-pins
sh test/k8s-smoke/assert-reaper.sh
```

Expected: PASS against the disposable cluster from Step 1. Delete that cluster
in a trap or immediately after the smoke succeeds.

- [ ] **Step 4: Commit**

```bash
git add test/k8s-smoke/assert-reaper.sh .github/workflows/ci.yml
git commit -m "test(charts): exercise PVC reaper in Kind"
```

### Task 4: Document and release the chart hardening

**Files:**
- Modify: `charts/dawn-sandbox-infra/README.md`
- Modify: `charts/dawn-sandbox-infra/Chart.yaml`
- Modify: `charts/dawn-sandbox-infra/values.yaml`
- Modify: `charts/dawn-sandbox-infra/templates/NOTES.txt`
- Modify: `apps/web/content/docs/sandbox.mdx`
- Regenerate: `packages/cli/docs/sandbox.md`

- [ ] **Step 1: Update documentation assertions first**

Before editing the README, confirm these searches fail:

```bash
rg -n '1\.34.*1\.36|sort.*grep' charts/dawn-sandbox-infra/README.md
rg -n '^version: 0\.1\.2$' charts/dawn-sandbox-infra/Chart.yaml
```

- [ ] **Step 2: Update README and chart version**

Change the chart description from a namespace-wide egress backstop to a
Dawn-managed sandbox pod backstop. Document:

- the `app.kubernetes.io/managed-by=dawn` selector;
- the reaper's need for API egress and why Helm-managed pods are excluded;
- default reaper compatibility with Kubernetes 1.34 through 1.36;
- the one-minor upstream `kubectl` skew rule;
- the operator responsibility to override `reaper.image` outside that window;
- all required image tools: `sh`, `date`, `sort`, `grep`, and `kubectl`;
- the complete default 1.35.6 tag-plus-digest reference in the values table.

Apply the same narrow wording correction to `values.yaml`, Helm `NOTES.txt`, and
the website sandbox guide. Then regenerate bundled CLI docs with:

```bash
pnpm --filter @dawn-ai/cli build
```

Do not edit `packages/cli/docs/sandbox.md` independently from its website MDX
source.

Bump `Chart.yaml` from `0.1.1` to `0.1.2`. Do not add an npm changeset.

- [ ] **Step 3: Run chart and docs verification**

```bash
helm lint --strict charts/dawn-sandbox-infra
sh charts/dawn-sandbox-infra/test/render.sh
sh charts/dawn-sandbox-infra/test/reaper.test.sh
helm template test charts/dawn-sandbox-infra | kubeconform -strict -summary -ignore-missing-schemas
node scripts/check-docs.mjs
git diff --check
```

If `kubeconform` is unavailable locally, record that and rely on the hosted
`chart-validate` job after running every available command.

- [ ] **Step 4: Commit**

```bash
git add charts/dawn-sandbox-infra/README.md charts/dawn-sandbox-infra/Chart.yaml charts/dawn-sandbox-infra/values.yaml charts/dawn-sandbox-infra/templates/NOTES.txt apps/web/content/docs/sandbox.mdx packages/cli/docs/sandbox.md
git commit -m "docs(charts): document reaper compatibility"
```

### Task 5: Full verification and delivery

**Files:**
- Verify only; modify narrowly if a test exposes a defect.

- [ ] **Step 1: Run repository validation**

```bash
pnpm ci:validate
```

Expected: all local Definition of Done gates pass.

- [ ] **Step 2: Run focused chart checks again**

```bash
pnpm --filter @dawn-ai/sandbox build
pnpm --filter @dawn-ai/sandbox typecheck
pnpm --filter @dawn-ai/sandbox lint
pnpm --filter @dawn-ai/sandbox test
helm lint --strict charts/dawn-sandbox-infra
sh charts/dawn-sandbox-infra/test/render.sh
sh charts/dawn-sandbox-infra/test/reaper.test.sh
sh -n test/k8s-smoke/setup-network-policy-control.sh
sh -n test/k8s-smoke/assert-reaper.sh
git diff --check
```

Expected: PASS.

- [ ] **Step 3: Final review**

Review the complete branch diff against
`docs/superpowers/specs/2026-08-07-kubernetes-reaper-compatibility-design.md`.
Confirm no `node:22-slim` sandbox workload references were migrated and no npm
changeset was added.

- [ ] **Step 4: Publish and merge**

Push `blove/k8s-reaper-compat`, open a ready PR without references to coding
agents, and monitor required checks. The `sandbox-k8s` lane must prove the
deterministic policy control and real reaper Job. Merge only after all required
checks are green. Do not treat optional external review as blocking.
