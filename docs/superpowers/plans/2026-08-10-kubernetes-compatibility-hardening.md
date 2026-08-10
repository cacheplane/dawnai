# Kubernetes Compatibility and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a portable Kubernetes compatibility harness, require focused Kubernetes 1.34-1.36 evidence, and harden Dawn's Kubernetes provider and sandbox chart around complete RBAC, restricted admission, immutable fixtures, and safe cleanup.

**Architecture:** Provider correctness lands first: one narrow permission declaration drives preflight and chart-RBAC assertions, and existing NetworkPolicies are replaced only after a live ownership/resource-version read. A checked-in policy then feeds small TypeScript modules for immutable inputs, pull-request scope, command execution, reporting, cluster setup, and stable-ID live probes. GitHub Actions only provisions pinned Kind/Calico environments and invokes the same harness used manually; a stable aggregator gates relevant pull requests.

**Tech Stack:** TypeScript 7, NodeNext ESM, pnpm 10, Vitest 4, `yaml`, `@kubernetes/client-node`, Helm 4, Kubernetes/Kind, Calico, GitHub Actions, kubeconform, Biome

---

## File Structure

- `.github/kubernetes-compatibility.json` is the single source of truth for supported Kubernetes targets, tool versions, checksums, and digest-pinned images.
- `scripts/kubernetes-compat.ts` is the public `pnpm verify:k8s:compat` entrypoint.
- `scripts/kubernetes-compat/policy.ts` validates and exposes the checked-in compatibility policy.
- `scripts/kubernetes-compat/calico.ts` verifies the raw Calico checksum and structurally rewrites image fields.
- `scripts/kubernetes-compat/scope.ts` classifies NUL-delimited pull-request diffs against the exact relevant-path policy.
- `scripts/kubernetes-compat/workflow.ts` exposes the small scope, matrix, and Calico-preparation operations used by GitHub Actions.
- `scripts/kubernetes-compat/command.ts` owns bounded, shell-free subprocess execution and explicit-context kubectl/Helm wrappers.
- `scripts/kubernetes-compat/report.ts` owns stable step results, redaction, expected-ID accounting, and report persistence.
- `scripts/kubernetes-compat/permissions.ts` owns the exact administrative SelfSubjectAccessReview tuples and fail-closed preflight.
- `scripts/kubernetes-compat/cluster.ts` owns context/server/storage validation, run names, namespaces, ServiceAccount token kubeconfigs, ownership checks, and cleanup.
- `scripts/kubernetes-compat/probes.ts` owns JSON-manifest live probes for admission, RBAC, kernel state, networking, storage, charts, and upgrades.
- `scripts/kubernetes-compat/harness.ts` composes the lifecycle and is the only module that sequences setup, token phases, probes, diagnostics, and cleanup.
- `test/k8s-compat/*.test.ts` unit-tests every pure harness boundary with fake command runners; no unit test needs a cluster.
- `test/k8s-compat/expected-tests.json` lists every provider test and live probe ID required from a real run.
- `test/k8s-compat/vitest.config.ts` enrolls only unit tests in the root workspace; the real provider suite stays in `packages/sandbox/test/kube-sandbox.integration.test.ts`.
- `.github/workflows/kubernetes-compat.yml` provisions the 1.34/1.36 endpoint matrix and always reports `kubernetes-compat`.
- `.github/workflows/ci.yml` keeps canonical 1.35, full-application, and chart-apply evidence aligned with the policy.

## Execution Prerequisite

The interactive shell currently resolves Node 22, while Dawn requires Node 24.
Use the installed Node 24 runtime for every Node/pnpm command, including fresh
subagents:

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
node --version
corepack pnpm --version
```

Expected: Node prints `v24.19.0` and pnpm prints `10.33.0`. Run all commands
from the repository root. The compatibility policy pins CI itself to Node
`24.17.0`; a newer local Node 24 patch is acceptable for development.

### Task 1: Replace Positional Kubernetes Permission Probes

**Files:**
- Modify: `packages/sandbox/src/kubernetes/kube-client.ts`
- Modify: `packages/sandbox/src/kubernetes/default-kube-client.ts`
- Modify: `packages/sandbox/src/kubernetes/kube-sandbox.ts`
- Modify: `packages/sandbox/src/index.ts`
- Modify: `packages/sandbox/test/support/fake-kube-client.ts`
- Modify: `packages/sandbox/test/kube-sandbox.unit.test.ts`
- Create: `packages/sandbox/test/kube-permissions.test.ts`

- [ ] **Step 1: Write failing permission-contract tests**

Create `packages/sandbox/test/kube-permissions.test.ts` and extend the existing
preflight tests with the exact public and behavioral contract:

```ts
import { describe, expect, test } from "vitest"

import {
  REQUIRED_KUBE_PERMISSIONS,
  type KubePermission,
} from "../src/kubernetes/kube-client.ts"
import { kubernetesSandbox } from "../src/kubernetes/kube-sandbox.ts"
import { fakeKubeClient } from "./support/fake-kube-client.ts"

const expected = [
  { apiGroup: "", resource: "pods", verb: "create" },
  { apiGroup: "", resource: "pods", verb: "get" },
  { apiGroup: "", resource: "pods", verb: "delete" },
  { apiGroup: "", resource: "persistentvolumeclaims", verb: "create" },
  { apiGroup: "", resource: "persistentvolumeclaims", verb: "get" },
  { apiGroup: "", resource: "persistentvolumeclaims", verb: "delete" },
  { apiGroup: "", resource: "pods", subresource: "exec", verb: "create" },
  { apiGroup: "", resource: "pods", subresource: "exec", verb: "get" },
  { apiGroup: "networking.k8s.io", resource: "networkpolicies", verb: "create" },
  { apiGroup: "networking.k8s.io", resource: "networkpolicies", verb: "get" },
  { apiGroup: "networking.k8s.io", resource: "networkpolicies", verb: "list" },
  { apiGroup: "networking.k8s.io", resource: "networkpolicies", verb: "update" },
  { apiGroup: "networking.k8s.io", resource: "networkpolicies", verb: "delete" },
] as const satisfies readonly KubePermission[]

describe("Kubernetes permission contract", () => {
  test("contains only the provider's exact valid operations", () => {
    expect(REQUIRED_KUBE_PERMISSIONS).toEqual(expected)
  })

  test("preflight probes every permission and reports all denials deterministically", async () => {
    const denied = [expected[1], expected[9]]
    const client = fakeKubeClient({ deniedPermissions: denied })
    const result = await kubernetesSandbox({ image: "image", namespace: "ns", client }).preflight?.()

    expect(client.permissionChecks).toEqual(expected)
    expect(result).toEqual({
      ok: false,
      detail:
        'Missing Kubernetes permissions in namespace "ns": get core/pods, get networking.k8s.io/networkpolicies.',
    })
  })

  test("runs every review when one review fails", async () => {
    const client = fakeKubeClient({
      permissionErrors: new Map([[JSON.stringify(expected[0]), new Error("review unavailable")]]),
    })
    const result = await kubernetesSandbox({ image: "image", namespace: "ns", client }).preflight?.()

    expect(client.permissionChecks).toEqual(expected)
    expect(result?.ok).toBe(false)
    expect(result?.detail).toMatch(/authorization review failed.*create core\/pods/i)
  })
})
```

Add compile-time `@ts-expect-error` cases proving `delete pods/exec`, `list
pods`, and a core-group NetworkPolicy are unrepresentable. Add a fake option for
a transport-classified review error and require the preflight detail to say
`Kubernetes API not reachable`, distinct from an API authorization-review
failure.

- [ ] **Step 2: Run the focused tests and confirm failure**

```bash
pnpm --filter @dawn-ai/sandbox test kube-permissions kube-sandbox.unit
```

Expected: FAIL because `KubePermission`, `REQUIRED_KUBE_PERMISSIONS`, structured
fake controls, and complete preflight do not exist.

- [ ] **Step 3: Implement the narrow permission union and review errors**

In `kube-client.ts`, add the discriminated union from the approved spec, the
exact ordered constant above, and:

```ts
export class KubeAuthorizationReviewError extends Error {
  readonly kind: "api" | "transport"

  constructor(kind: "api" | "transport", message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "KubeAuthorizationReviewError"
    this.kind = kind
  }
}
```

Change `KubeClient.canI` to:

```ts
canI(namespace: string, permission: KubePermission): Promise<boolean>
```

In the default client, map `apiGroup`, `resource`, `subresource`, `verb`, and
namespace directly into `resourceAttributes`, omitting `subresource` when it is
undefined. Wrap `ApiException` failures as `kind: "api"` and non-API failures as
`kind: "transport"`.

In provider preflight, use `Promise.allSettled` over the complete constant,
sort all missing/failed labels, and return only after every review settles.
Preserve the existing best-effort CNI warning after authorization succeeds.

Export only `KubePermission` with `KubeClient` from `packages/sandbox/src/index.ts`;
the constant and error class stay internal to the package source.

- [ ] **Step 4: Update the fake and existing assertions**

Replace `canICreate` with `deniedPermissions`, `permissionErrors`, and a
`permissionChecks` array. Match permissions by a stable serialized key, not
object identity. Update existing preflight tests to assert the complete success
detail and warning behavior.

- [ ] **Step 5: Run package verification**

```bash
pnpm --filter @dawn-ai/sandbox build
pnpm --filter @dawn-ai/sandbox typecheck
pnpm --filter @dawn-ai/sandbox lint
pnpm --filter @dawn-ai/sandbox test
```

Expected: PASS. No positional `canI(namespace, verb, resource)` call remains.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/src packages/sandbox/test
git commit -m "feat(sandbox): validate Kubernetes RBAC contract"
```

### Task 2: Replace Existing NetworkPolicies Safely

**Files:**
- Modify: `packages/sandbox/src/kubernetes/default-kube-client.ts`
- Create: `packages/sandbox/test/default-kube-client.test.ts`

- [ ] **Step 1: Write failing replacement-body tests**

Create tests for an exported-internal `prepareNetworkPolicyReplacement`
function:

```ts
import { describe, expect, test } from "vitest"

import { prepareNetworkPolicyReplacement } from "../src/kubernetes/default-kube-client.ts"

const desired = {
  metadata: {
    name: "dawn-sbx-net-thread",
    labels: { "app.kubernetes.io/managed-by": "dawn", "dawn.sh/thread": "thread" },
  },
  spec: { podSelector: { matchLabels: { "dawn.sh/thread": "thread" } } },
}

test("copies the live resourceVersion into an owned replacement", () => {
  expect(
    prepareNetworkPolicyReplacement(
      {
        metadata: {
          name: "dawn-sbx-net-thread",
          resourceVersion: "42",
          labels: { "app.kubernetes.io/managed-by": "dawn", "dawn.sh/thread": "thread" },
        },
      },
      desired,
      "thread",
    ).metadata?.resourceVersion,
  ).toBe("42")
})

test.each([
  [{ metadata: { name: "other", resourceVersion: "42", labels: desired.metadata.labels } }, /name/i],
  [{ metadata: { name: desired.metadata.name, resourceVersion: "42", labels: {} } }, /owned/i],
  [{ metadata: { name: desired.metadata.name, labels: desired.metadata.labels } }, /resourceVersion/i],
])("rejects an unsafe existing policy", (existing, message) => {
  expect(() => prepareNetworkPolicyReplacement(existing, desired, "thread")).toThrow(message)
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @dawn-ai/sandbox test default-kube-client
```

Expected: FAIL because the helper is absent.

- [ ] **Step 3: Implement get-plus-replace**

On HTTP 409 from create:

```ts
const existing = await networking.readNamespacedNetworkPolicy({
  name: spec.name,
  namespace: ns,
})
const replacement = prepareNetworkPolicyReplacement(existing, body, spec.threadLabelValue)
await networking.replaceNamespacedNetworkPolicy({
  name: spec.name,
  namespace: ns,
  body: replacement,
})
```

The helper must require exact name, `app.kubernetes.io/managed-by=dawn`, exact
`dawn.sh/thread`, and a non-empty live `resourceVersion`. Do not retry a second
409 and do not add a patch fallback.

- [ ] **Step 4: Run package verification and commit**

```bash
pnpm --filter @dawn-ai/sandbox build
pnpm --filter @dawn-ai/sandbox typecheck
pnpm --filter @dawn-ai/sandbox test default-kube-client kube-sandbox
git add packages/sandbox/src/kubernetes/default-kube-client.ts packages/sandbox/test/default-kube-client.test.ts
git commit -m "fix(sandbox): replace existing network policies safely"
```

### Task 3: Make Restricted Admission The Chart Default

**Files:**
- Modify: `charts/dawn-sandbox-infra/values.yaml`
- Modify: `charts/dawn-sandbox-infra/templates/namespace.yaml`
- Modify: `charts/dawn-sandbox-infra/test/render.sh`
- Modify: `charts/dawn-sandbox-infra/Chart.yaml`

- [ ] **Step 1: Write failing render assertions**

Change the default assertion to require `restricted`, add an extra-label render,
and add reserved-label rejection:

```sh
tmpl --show-only templates/namespace.yaml \
  | assert "pss enforce restricted" 'pod-security.kubernetes.io/enforce: restricted'

tmpl --show-only templates/namespace.yaml \
  --set-string 'namespace.extraLabels.dawn\.sh/compat-run=run-123' \
  | assert "compat run label" 'dawn.sh/compat-run: run-123'

if tmpl --show-only templates/namespace.yaml \
  --set-string 'namespace.extraLabels.pod-security\.kubernetes\.io/enforce=privileged' \
  >/dev/null 2>&1; then
  echo "FAIL: namespace.extraLabels must not override Pod Security labels"
  exit 1
fi
```

- [ ] **Step 2: Run and confirm failure**

```bash
sh charts/dawn-sandbox-infra/test/render.sh
```

Expected: FAIL because the default is baseline and `namespace.extraLabels` is
not rendered or guarded.

- [ ] **Step 3: Implement the chart behavior**

Set all three Pod Security modes to `restricted`, add
`namespace.extraLabels: {}` to values, and render those labels. Before rendering,
fail when an extra label matches any Helm standard label emitted by the chart or
starts with `pod-security.kubernetes.io/`; fixed chart security/ownership labels
must remain authoritative.

Bump `charts/dawn-sandbox-infra/Chart.yaml` from `0.1.2` to `0.1.3` in the same
commit because both the default and values API changed.

- [ ] **Step 4: Verify charts**

```bash
sh charts/dawn-sandbox-infra/test/render.sh
sh charts/dawn-sandbox-infra/test/reaper.test.sh
helm lint --strict charts/dawn-sandbox-infra
helm template test charts/dawn-sandbox-infra \
  | kubeconform -strict -summary -ignore-missing-schemas
```

Expected: all commands PASS and the default Namespace renders restricted labels.

- [ ] **Step 5: Commit**

```bash
git add charts/dawn-sandbox-infra
git commit -m "feat(charts): enforce restricted sandbox admission"
```

### Task 4: Define And Validate The Compatibility Policy

**Files:**
- Create: `.github/kubernetes-compatibility.json`
- Create: `scripts/kubernetes-compat/policy.ts`
- Create: `test/k8s-compat/policy.test.ts`
- Create: `test/k8s-compat/vitest.config.ts`
- Create: `test/k8s-compat/tsconfig.json`
- Modify: `vitest.workspace.ts`
- Modify: `package.json`

- [ ] **Step 1: Enroll the new unit-test and typecheck surface**

Create a named Vitest project that includes `test/k8s-compat/**/*.test.ts`, add
it to `vitest.workspace.ts`, and create a no-emit NodeNext tsconfig covering the
test directory plus `scripts/kubernetes-compat.ts` and
`scripts/kubernetes-compat/**/*.ts`.

Update root scripts:

```json
{
  "lint": "pnpm exec biome check --config-path packages/config-biome/biome.json package.json scripts test/k8s-compat && turbo run lint",
  "typecheck": "turbo run typecheck && tsc -p test/k8s-compat/tsconfig.json --noEmit",
  "verify:k8s:compat": "pnpm --filter @dawn-ai/sandbox... build && pnpm exec tsx scripts/kubernetes-compat.ts"
}
```

- [ ] **Step 2: Write failing policy tests**

Cover exact role order, version/minor consistency, 64-character lowercase
digests, positive Calico occurrence counts, raw SHA-256 shape, one-minor skew
for workflow/reaper kubectl, unique target minors, and lookup by `--target`.
Malformed policies must throw path-specific messages.

- [ ] **Step 3: Run and confirm failure**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts policy
```

Expected: FAIL because the policy and parser do not exist.

- [ ] **Step 4: Add the exact checked-in policy**

Use this top-level shape and the values approved in the spec:

```json
{
  "schemaVersion": 1,
  "toolchain": {
    "node": "24.17.0",
    "pnpm": "10.33.0",
    "helm": "v4.2.3",
    "kind": "v0.32.0",
    "kubectl": "v1.35.6"
  },
  "targets": [
    {
      "role": "lower",
      "minor": "1.34",
      "version": "1.34.8",
      "nodeImage": "kindest/node:v1.34.8@sha256:02722c2dedddcfc00febf5d27fbeb9b7b2c14294c82109ff4a85d89ac9ba3256"
    },
    {
      "role": "canonical",
      "minor": "1.35",
      "version": "1.35.5",
      "nodeImage": "kindest/node:v1.35.5@sha256:ce977ae6d65918d0b58a5f8b5e940429c2ce42fa3a5619ec2bbc60b949c0ac95"
    },
    {
      "role": "upper",
      "minor": "1.36",
      "version": "1.36.1",
      "nodeImage": "kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5"
    }
  ],
  "calico": {
    "manifestUrl": "https://raw.githubusercontent.com/projectcalico/calico/v3.32.1/manifests/calico.yaml",
    "sha256": "a1df919d9721cf667accdc3e72848911b0cb25cfab7d2478ad0c996302c95744",
    "images": [
      {
        "source": "quay.io/calico/cni:v3.32.1",
        "occurrences": 2,
        "target": "quay.io/calico/cni:v3.32.1@sha256:bb1567e3ed81e2e8414e9a68f186e1f7ffd4067a4871a9ae90896793af0190dd"
      },
      {
        "source": "quay.io/calico/kube-controllers:v3.32.1",
        "occurrences": 1,
        "target": "quay.io/calico/kube-controllers:v3.32.1@sha256:18008f781c869376dbbc4dfb1ffe3afb46f7897887d4f20e080c420ac44a6612"
      },
      {
        "source": "quay.io/calico/node:v3.32.1",
        "occurrences": 2,
        "target": "quay.io/calico/node:v3.32.1@sha256:7f874b3f0b540c2b523aea9961ef5e2f43b0af9056a47874c916d6cf348168d3"
      }
    ]
  },
  "images": {
    "sandboxWorkload": "docker.io/library/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436",
    "packagedAppBase": "docker.io/library/node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03",
    "placeholderApp": "nginxinc/nginx-unprivileged:stable-alpine@sha256:44e36330f74d4f3a1d4e222acca9e23b401fb87811a7597024502bb759c4dd49",
    "reachabilityProbe": "curlimages/curl:8.10.1@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b",
    "admissionProbe": "registry.k8s.io/pause:3.10@sha256:ee6521f290b2168b6e0935a181d4cff9be1ac3f505666ef0e3c98fae8199917a",
    "reaper": "docker.io/alpine/k8s:1.35.6@sha256:b7a12c5ddf261994c33d2eaaa06fd69a0803ff6b38683bfa3d30a76dcdf92807"
  }
}
```

Implement explicit runtime validation with narrow TypeScript types; do not cast
raw JSON directly to the policy interface.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts policy
pnpm exec tsc -p test/k8s-compat/tsconfig.json --noEmit
pnpm exec biome check --config-path packages/config-biome/biome.json \
  .github/kubernetes-compatibility.json scripts/kubernetes-compat test/k8s-compat package.json vitest.workspace.ts
git add .github/kubernetes-compatibility.json scripts/kubernetes-compat/policy.ts test/k8s-compat package.json vitest.workspace.ts
git commit -m "test(kubernetes): define compatibility policy"
```

### Task 5: Verify And Rewrite Calico Structurally

**Files:**
- Create: `scripts/kubernetes-compat/calico.ts`
- Create: `test/k8s-compat/calico.test.ts`

- [ ] **Step 1: Write failing checksum and rewrite tests**

Use a synthetic multi-document manifest with two CNI references, one
controller, two node references, plus an unrelated string containing an image
tag. Require only `containers` and `initContainers` image fields to change.
Test wrong checksum, too few/too many occurrences, malformed YAML, and a tag
remaining after rewrite.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts calico
```

- [ ] **Step 3: Implement raw checksum verification and YAML traversal**

Expose:

```ts
export function verifyAndRewriteCalico(
  raw: Uint8Array,
  policy: CompatibilityPolicy["calico"],
): string
```

Hash the untouched bytes first. Parse all YAML documents with `parseAllDocuments`,
reject document errors, recursively visit only array entries under keys named
`containers` and `initContainers`, and replace exact `image` values. Compare
observed counts to policy before serialization and assert no source reference
remains in an image field afterward.

Add `downloadAndPrepareCalico(outputPath, policy, fetchImpl = fetch)` with a
30-second abort timeout, `response.ok` validation, and atomic write through a
sibling temporary file. Never pipe network data to kubectl.

- [ ] **Step 4: Verify and commit**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts calico
pnpm exec tsc -p test/k8s-compat/tsconfig.json --noEmit
git add scripts/kubernetes-compat/calico.ts test/k8s-compat/calico.test.ts
git commit -m "test(kubernetes): verify Calico inputs"
```

### Task 6: Add Fail-Closed Pull-Request Scope Classification

**Files:**
- Create: `scripts/kubernetes-compat/scope.ts`
- Create: `scripts/kubernetes-compat/workflow.ts`
- Create: `test/k8s-compat/scope.test.ts`

- [ ] **Step 1: Write failing classifier tests**

Require every exact/prefix path from the spec, including `.npmrc`, root package
and lock/config files, both workflows, `.github/kind/**`, the policy, harness,
both Kubernetes test directories, sandbox package, workspace sandbox type,
and both charts. Include spaces/newlines in synthetic filenames to prove
NUL-delimited parsing. Require unrelated docs to return false.

Add aggregate-result tests:

```ts
expect(aggregateCompatibility({ required: false, scope: "success", compat: "skipped" })).toBe(true)
expect(aggregateCompatibility({ required: true, scope: "success", compat: "success" })).toBe(true)
for (const result of ["failure", "cancelled", "skipped", undefined]) {
  expect(aggregateCompatibility({ required: true, scope: "success", compat: result })).toBe(false)
}
expect(aggregateCompatibility({ required: false, scope: "failure", compat: "skipped" })).toBe(false)
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts scope
```

- [ ] **Step 3: Implement exact path ownership and Git diff execution**

Use exact matches plus directory prefixes; do not use substring matching. For
pull requests, validate 40-character lowercase SHAs, verify each with
`git cat-file -e <sha>^{commit}`, then execute:

```text
git diff --name-only -z <baseSHA> <headSHA>
```

Parse the returned Buffer on NUL bytes. Any invalid SHA, missing object, process
failure, malformed policy, or unknown event mode must throw so CI fails closed.

`workflow.ts` provides three CLI operations with stdout-only machine values:

- `scope --event pull_request --base <sha> --head <sha>` -> `true|false`;
- `matrix` -> compact JSON for lower/upper targets;
- `prepare-calico --output <path>` -> writes the verified local manifest.

Nightly and manual scope return `true` without a diff. Keep GitHub output-file
formatting in workflow YAML; this CLI must not trust or write an arbitrary
`GITHUB_OUTPUT` path.

- [ ] **Step 4: Verify and commit**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts scope
pnpm exec tsc -p test/k8s-compat/tsconfig.json --noEmit
git add scripts/kubernetes-compat/scope.ts scripts/kubernetes-compat/workflow.ts test/k8s-compat/scope.test.ts
git commit -m "ci: classify Kubernetes compatibility changes"
```

### Task 7: Add Safe Command Execution And Structured Reports

**Files:**
- Create: `scripts/kubernetes-compat/command.ts`
- Create: `scripts/kubernetes-compat/report.ts`
- Create: `test/k8s-compat/command.test.ts`
- Create: `test/k8s-compat/report.test.ts`

- [ ] **Step 1: Write failing command-wrapper tests**

Use an injected executor to prove:

```ts
expect(kubectl.command(context, ["get", "pods"])).toEqual({
  file: "kubectl",
  args: ["--context", context, "get", "pods"],
})
expect(helm.command(context, ["status", "release"])).toEqual({
  file: "helm",
  args: ["--kube-context", context, "status", "release"],
})
```

Cover token kubeconfig commands (`--kubeconfig`, then `--context`), timeout
termination, maximum stdout/stderr bytes, nonzero results, signal abort, and a
`sensitiveOutput` option that never exposes captured text in errors/reports.
Only `kubectl config current-context` may omit a supplied target context.

- [ ] **Step 2: Write failing report tests**

Require stable step IDs, duration/status, exact expected-vs-observed accounting,
zero skipped/pending/todo provider tests, deterministic sorted mismatch errors,
and recursive redaction of keys/values containing token, authorization, Secret,
kubeconfig, Bearer credentials, or JWT-like strings. Verify writes stay beneath
`artifacts/testing/kubernetes-compat/` and reject path traversal.

- [ ] **Step 3: Run and confirm failure**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts command report
```

- [ ] **Step 4: Implement the primitives**

Use `spawn`/`execFile`, never `shell: true`. Bound each output stream before
concatenation, include executable/argument metadata but not sensitive stdin or
output, and accept an `AbortSignal`. Implement `runStep(id, fn)` so failures are
recorded and rethrown. Persist reports atomically with schema version, target,
observed server, run ID, timestamps, steps, and cleanup status.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts command report
pnpm exec tsc -p test/k8s-compat/tsconfig.json --noEmit
pnpm exec biome check --config-path packages/config-biome/biome.json scripts/kubernetes-compat test/k8s-compat
git add scripts/kubernetes-compat/command.ts scripts/kubernetes-compat/report.ts test/k8s-compat
git commit -m "test(kubernetes): add safe harness primitives"
```

### Task 8: Preflight The Administrative Cluster Contract

**Files:**
- Create: `scripts/kubernetes-compat/permissions.ts`
- Create: `scripts/kubernetes-compat/cluster.ts`
- Create: `test/k8s-compat/permissions.test.ts`
- Create: `test/k8s-compat/cluster.test.ts`
- Create: `test/k8s-compat/chart-rbac.test.ts`

- [ ] **Step 1: Write failing administrative-permission tests**

Represent permissions as exact apiGroup/resource/subresource/verb/scope tuples.
Build the declaration from these groups, then expand and sort it in one place:

```ts
const lifecycle = ["create", "get", "list", "update", "patch", "delete"] as const

export const ADMIN_PERMISSION_GROUPS = [
  { scope: "cluster", apiGroup: "", resources: ["namespaces"], verbs: lifecycle },
  { scope: "cluster", apiGroup: "storage.k8s.io", resources: ["storageclasses"], verbs: ["get", "list"] },
  { scope: "cluster", apiGroup: "authorization.k8s.io", resources: ["selfsubjectaccessreviews"], verbs: ["create"] },
  { scope: "management", apiGroup: "", resources: ["secrets"], verbs: lifecycle },
  { scope: "both", apiGroup: "", resources: ["serviceaccounts"], verbs: lifecycle },
  { scope: "sandbox", apiGroup: "", resources: ["serviceaccounts"], subresource: "token", verbs: ["create"] },
  { scope: "sandbox", apiGroup: "rbac.authorization.k8s.io", resources: ["roles", "rolebindings"], verbs: lifecycle },
  { scope: "sandbox", apiGroup: "", resources: ["configmaps", "resourcequotas", "limitranges", "persistentvolumeclaims"], verbs: lifecycle },
  { scope: "both", apiGroup: "", resources: ["services"], verbs: lifecycle },
  { scope: "both", apiGroup: "", resources: ["pods"], verbs: ["create", "get", "list", "watch", "delete"] },
  { scope: "management", apiGroup: "apps", resources: ["deployments"], verbs: ["create", "get", "list", "watch", "update", "patch", "delete"] },
  { scope: "sandbox", apiGroup: "batch", resources: ["cronjobs", "jobs"], verbs: ["create", "get", "list", "watch", "update", "patch", "delete"] },
  { scope: "sandbox", apiGroup: "networking.k8s.io", resources: ["networkpolicies"], verbs: ["create", "get", "list", "watch", "update", "patch", "delete"] },
  { scope: "sandbox", apiGroup: "", resources: ["pods"], subresource: "exec", verbs: ["create", "get"] },
  { scope: "both", apiGroup: "", resources: ["pods"], subresource: "log", verbs: ["get"] },
  { scope: "both", apiGroup: "", resources: ["events"], verbs: ["get", "list", "watch"] },
] as const
```

Tests must lock the fully expanded tuple set, scope expansion into the two
generated namespace names, and sorted diagnostics. A fake runner must prove all
SelfSubjectAccessReviews execute even when one returns denied and another
returns an API error.

Render `charts/dawn-sandbox-infra` with Helm, parse the `dawn-orchestrator`
Role using `yaml`, expand every `apiGroups` x `resources` x `verbs` rule (split
`pods/exec` into resource plus subresource), and compare the sorted result to
`REQUIRED_KUBE_PERMISSIONS`. This assertion must cover API groups, resources,
subresources, and verbs rather than checking representative strings. Skip only
when Helm is absent and `DAWN_REQUIRE_HELM` is unset; setting
`DAWN_REQUIRE_HELM=1` must turn an absent Helm executable into a failure so the
hosted Kubernetes lane cannot silently lose the parity check.

- [ ] **Step 2: Write failing cluster-safety tests**

Cover:

- supplied context differs from `kubectl config current-context`;
- server minor differs from the selected policy target;
- override/default StorageClass is absent;
- either generated namespace already exists;
- temporary directory is `0700` and token kubeconfig is `0600`;
- TokenRequest has `expirationSeconds: 900` and no `audiences` field;
- token kubeconfig contains one cluster, user, and context only;
- cleanup refuses a changed Namespace UID or missing run label;
- `SIGINT`, `SIGTERM`, and `SIGHUP` all enter the cleanup path; and
- keep-on-failure never retains token files.

- [ ] **Step 3: Run and confirm failure**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts permissions cluster chart-rbac
```

- [ ] **Step 4: Implement fail-closed administrative preflight**

Create SelfSubjectAccessReview JSON and submit it with the explicit-context
kubectl wrapper through:

```text
kubectl --context <context> create --raw /apis/authorization.k8s.io/v1/selfsubjectaccessreviews -f -
```

Parse `status.allowed === true`; distinguish a denied review from command/API
failure. Run every review with settled results and print the complete sorted
missing/failing tuple set. No Namespace or Helm mutation may occur before this
function succeeds.

- [ ] **Step 5: Implement context, storage, token, and ownership helpers**

`cluster.ts` must:

1. validate required executables;
2. compare the supplied and current context once, then pass the supplied value
   explicitly everywhere;
3. parse `kubectl version -o json` and require the declared server minor;
4. parse StorageClass JSON and select an exact override or one annotated as
   default;
5. derive DNS-safe run/release/namespace names internally;
6. confirm both Namespace names are absent;
7. capture server/CA data from `kubectl config view --raw --minify -o json`;
8. request a fresh token through the ServiceAccount `token` subresource with a
   JSON TokenRequest and sensitive-output handling;
9. write a one-context kubeconfig under a secure temporary directory; and
10. capture and later require exact Namespace UID plus
    `dawn.sh/compat-run=<runId>` before Helm uninstall or Namespace deletion.

Do not put a custom audience in the TokenRequest. Register signal cleanup only
after the first owned resource exists.

- [ ] **Step 6: Verify and commit**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts permissions cluster chart-rbac
pnpm exec tsc -p test/k8s-compat/tsconfig.json --noEmit
git add scripts/kubernetes-compat/permissions.ts scripts/kubernetes-compat/cluster.ts test/k8s-compat
git commit -m "test(kubernetes): preflight compatibility clusters"
```

### Task 9: Harden Real Provider Conformance And Exact Test Accounting

**Files:**
- Modify: `packages/sandbox/test/kube-sandbox.integration.test.ts`
- Create: `test/k8s-compat/expected-tests.json`
- Modify: `scripts/kubernetes-compat/report.ts`
- Modify: `test/k8s-compat/report.test.ts`

- [ ] **Step 1: Write the expected provider-test manifest first**

List these exact full Vitest names under both `provider-before-upgrade` and
`provider-after-upgrade` keys. Keep the phases explicit in the manifest so one
successful provider run cannot satisfy both lifecycle checkpoints:

```json
{
  "providerPhases": {
    "provider-before-upgrade": [
      "kubernetesSandbox (real cluster) SandboxProvider conformance: kubernetesSandbox acquire is idempotent per thread and reattaches the workspace",
      "kubernetesSandbox (real cluster) SandboxProvider conformance: kubernetesSandbox threads are isolated",
      "kubernetesSandbox (real cluster) SandboxProvider conformance: kubernetesSandbox release keeps the volume, destroy clears it",
      "kubernetesSandbox (real cluster) SandboxProvider conformance: kubernetesSandbox exec returns a numeric exit code",
      "kubernetesSandbox (real cluster) runs with the restricted object and kernel security contract",
      "kubernetesSandbox (real cluster) network deny blocks egress while DNS remains available",
      "kubernetesSandbox (real cluster) chart backstop blocks allow-mode sandbox egress without a per-thread policy",
      "kubernetesSandbox (real cluster) workspace persists across release and reattach",
      "kubernetesSandbox (real cluster) recreates an externally deleted keeper over the same PVC",
      "kubernetesSandbox (real cluster) updates an existing owned NetworkPolicy on reacquire"
    ],
    "provider-after-upgrade": [
      "kubernetesSandbox (real cluster) SandboxProvider conformance: kubernetesSandbox acquire is idempotent per thread and reattaches the workspace",
      "kubernetesSandbox (real cluster) SandboxProvider conformance: kubernetesSandbox threads are isolated",
      "kubernetesSandbox (real cluster) SandboxProvider conformance: kubernetesSandbox release keeps the volume, destroy clears it",
      "kubernetesSandbox (real cluster) SandboxProvider conformance: kubernetesSandbox exec returns a numeric exit code",
      "kubernetesSandbox (real cluster) runs with the restricted object and kernel security contract",
      "kubernetesSandbox (real cluster) network deny blocks egress while DNS remains available",
      "kubernetesSandbox (real cluster) chart backstop blocks allow-mode sandbox egress without a per-thread policy",
      "kubernetesSandbox (real cluster) workspace persists across release and reattach",
      "kubernetesSandbox (real cluster) recreates an externally deleted keeper over the same PVC",
      "kubernetesSandbox (real cluster) updates an existing owned NetworkPolicy on reacquire"
    ]
  },
  "probeIds": []
}
```

Update report tests to feed Vitest JSON with missing, renamed, failed, skipped,
pending, and todo assertions. Every case except the exact all-passed set must
fail accounting.

- [ ] **Step 2: Write/extend the gated integration tests**

Use `DAWN_TEST_K8S_IMAGE`, `DAWN_TEST_K8S_NS`, and
`DAWN_TEST_K8S_EGRESS_CONTROL_URL` as required inputs when
`DAWN_TEST_K8S=1`; do not retain a tag-only fallback in the live lane.

The restricted contract test should acquire one sandbox, read its Pod/PVC with
the token kubeconfig, and assert:

```ts
expect(pod.spec?.automountServiceAccountToken).toBe(false)
expect(pod.spec?.securityContext).toMatchObject({
  runAsNonRoot: true,
  runAsUser: 1000,
  runAsGroup: 1000,
  fsGroup: 1000,
  fsGroupChangePolicy: "OnRootMismatch",
  seccompProfile: { type: "RuntimeDefault" },
})
expect(pod.spec?.containers[0]?.securityContext).toMatchObject({
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] },
})
expect(pvc.status?.phase).toBe("Bound")
```

Execute one command that returns `/proc/self/status`, write results for `/etc`,
`/workspace`, `/tmp`, `/run`, and the conventional token path, then require
`CapEff` all zero, `NoNewPrivs: 1`, `Seccomp: 2`, read-only `/etc`, writable
declared mounts, and no token file.

For the NetworkPolicy update test, acquire deny mode, modify only policy spec
fields while preserving ownership labels/resourceVersion, then reacquire and
assert the same policy has the desired DNS/egress spec. Add an ownership-mismatch
case to the unit test from Task 2, not the shared live namespace.

- [ ] **Step 3: Run local package tests**

```bash
pnpm --filter @dawn-ai/sandbox test kube-sandbox.integration kube-sandbox.unit default-kube-client
```

Expected: PASS with the real-cluster file skipped locally because
`DAWN_TEST_K8S` is unset.

- [ ] **Step 4: Implement exact Vitest JSON accounting**

Parse `assertionResults[].fullName` and status from the JSON reporter. Require
the observed name set to equal the manifest, every status to be passed, and
suite counters for skipped/pending/todo to be zero. A missing output file or
empty assertion list is an error.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @dawn-ai/sandbox build
pnpm --filter @dawn-ai/sandbox typecheck
pnpm --filter @dawn-ai/sandbox test
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts report
git add packages/sandbox/test/kube-sandbox.integration.test.ts test/k8s-compat/expected-tests.json scripts/kubernetes-compat/report.ts test/k8s-compat/report.test.ts
git commit -m "test(sandbox): harden Kubernetes conformance"
```

### Task 10: Add Admission, RBAC, And Network Probes

**Files:**
- Create: `scripts/kubernetes-compat/probes.ts`
- Create: `test/k8s-compat/probes.test.ts`
- Modify: `test/k8s-compat/expected-tests.json`

- [ ] **Step 1: Write failing manifest and rejection tests**

With a fake command runner, inspect every positive Pod manifest and require:

- `runAsNonRoot: true` plus an explicit nonzero UID;
- RuntimeDefault seccomp;
- `allowPrivilegeEscalation: false`;
- drop `ALL` capabilities;
- read-only root where compatible; and
- digest-pinned image from policy.

Require the quota-negative Pod to differ from a positive admission fixture only
by `resources.requests/limits.cpu=9`, and the Pod-Security-negative Pod to differ
only by `runAsNonRoot: false`.

Feed structured Kubernetes Status responses and prove:

- quota accepts only HTTP 403/`Forbidden` with the chart quota name and
  `exceeded quota` detail;
- Pod Security accepts only HTTP 403/`Forbidden` identifying restricted
  `runAsNonRoot`; and
- RBAC negatives accept only HTTP 403/`Forbidden`, never 404, transport error,
  or admission rejection.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts probes
```

- [ ] **Step 3: Implement stable-ID probes**

Add these IDs to the manifest and implement each function with JSON input/output:

```json
[
  "namespace.sandbox-secrets-empty",
  "network.control-ready",
  "admission.resource-quota",
  "admission.limit-range",
  "admission.restricted.before-upgrade",
  "rbac.secret-read-denied",
  "rbac.role-mutation-denied",
  "rbac.outside-namespace-denied"
]
```

The network control creates a restricted Node server Pod and Service without
the Dawn-managed selector label, plus a restricted client proving the Service
is reachable before provider backstop tests run. The Secret probe runs through
the admin context and requires an empty `.items` array before issuing a token.
All three RBAC probes run through the token kubeconfig, not admin impersonation.

The LimitRange probe omits `resources`, reads the admitted Pod back, and requires
the exact configured default/defaultRequest CPU and memory values. Delete all
probe objects by exact run label in `finally`.

- [ ] **Step 4: Verify and commit**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts probes
pnpm exec tsc -p test/k8s-compat/tsconfig.json --noEmit
git add scripts/kubernetes-compat/probes.ts test/k8s-compat
git commit -m "test(kubernetes): prove admission and RBAC controls"
```

### Task 11: Add Reaper, Application, And Upgrade Probes

**Files:**
- Modify: `scripts/kubernetes-compat/probes.ts`
- Modify: `test/k8s-compat/probes.test.ts`
- Modify: `test/k8s-compat/expected-tests.json`

- [ ] **Step 1: Write failing reaper and upgrade tests**

Using fake kubectl/Helm JSON, require:

- stale PVC deleted, new PVC marked, referenced PVC retained/unmarked;
- reference Pod uses the digest-pinned pause image, UID 65532, and complete
  restricted context;
- initial infrastructure schedule `17 * * * *`;
- infrastructure Helm revision exactly 2 after changing schedule to
  `23 * * * *`;
- initial application replicas exactly 1;
- application Helm revision exactly 2 after `replicaCount=2`;
- Deployment desired/available replicas both 2; and
- Service probe exits zero against the chart Service.

Reject a green result based only on `helm upgrade` exit status; live object and
revision assertions are mandatory.

- [ ] **Step 2: Add expected IDs and run the red test**

Append the phase-qualified IDs below. Repeated checks deliberately have
different IDs so exact accounting detects a skipped post-upgrade rerun:

```json
[
  "reaper.lifecycle.before-upgrade",
  "app.service-ready.before-upgrade",
  "upgrade.infrastructure",
  "admission.restricted.after-infra-upgrade",
  "reaper.lifecycle.after-infra-upgrade",
  "upgrade.application",
  "app.service-ready.after-application-upgrade"
]
```

Run:

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts probes
```

- [ ] **Step 3: Implement same-candidate chart operations**

Implement chart operations for the Task 12 harness to sequence; `probes.ts`
must not own the overall lifecycle. Install both chart releases into the
management namespace. The infrastructure chart receives the generated sandbox
namespace and run label but retains all other defaults. The application chart
uses the policy's placeholder digest, port 8080, health path `/`, one replica,
and a created ServiceAccount.

Use `helm status --output json` and Kubernetes object JSON for assertions. The
infrastructure upgrade must rerun restricted admission, provider conformance
with a fresh token, and the reaper probe. The application upgrade must rerun
Service reachability with the digest-pinned curl Pod.

- [ ] **Step 4: Verify and commit**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts probes report
pnpm exec tsc -p test/k8s-compat/tsconfig.json --noEmit
git add scripts/kubernetes-compat/probes.ts test/k8s-compat
git commit -m "test(kubernetes): exercise chart upgrades"
```

### Task 12: Compose The Portable Compatibility Command

**Files:**
- Create: `scripts/kubernetes-compat/harness.ts`
- Create: `scripts/kubernetes-compat.ts`
- Create: `test/k8s-compat/harness.test.ts`

- [ ] **Step 1: Write failing lifecycle-order and cleanup tests**

With injected policy/command/probe dependencies, lock this order:

1. local prerequisite/context/server/storage/namespace/admin preflight;
2. create and capture management Namespace;
3. install infrastructure chart and capture sandbox Namespace;
4. assert zero sandbox Secrets and prepare network control;
5. fresh token -> provider-before-upgrade JSON suite (12-minute timeout) ->
   delete token files;
6. fresh token -> admission/RBAC probes -> delete token files;
7. reaper and application install/service probes;
8. infrastructure upgrade -> fresh provider-after-upgrade phase -> restricted
   admission and reaper probes;
9. application upgrade -> replica and Service probes;
10. exact provider/probe ID accounting and report write; and
11. ownership recheck -> uninstall exact releases -> delete surviving namespaces.

Add failure tests at every mutation boundary. Require cleanup on success,
failure, `SIGINT`, `SIGTERM`, and `SIGHUP`; keep-on-failure retains cluster
resources only after ownership validation but always removes token material.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts harness
```

- [ ] **Step 3: Implement the harness composition**

The public parser accepts only:

```text
--target <1.34|1.35|1.36>
--context <exact-context>
[--storage-class <name>]
[--keep-on-failure]
[--help]
```

Unknown/duplicate flags, missing values, and positional arguments exit 2 before
cluster access. `--help` prints usage and exits zero without loading cluster
state. Load the policy relative to the repository, not process CWD.

Run the provider phase with a fresh token kubeconfig:

```text
pnpm --filter @dawn-ai/sandbox exec vitest --run --config vitest.config.ts \
  test/kube-sandbox.integration.test.ts --reporter=json --outputFile=<secure path>
```

Set `DAWN_TEST_K8S=1`, namespace, policy image, network control URL, and
`KUBECONFIG`; never pass the token itself in argv/environment. Bound each phase
to 12 minutes and validate JSON against `expected-tests.json` before deleting
the secure directory.

On failure, collect bounded Events, object JSON, descriptions, logs, Helm
status, and cleanup result. Never collect Secrets, environment dumps, token
files, or unredacted command output.

- [ ] **Step 4: Prove the structured probes supersede the shell behavior**

Map every assertion in `setup-network-policy-control.sh` and `assert-reaper.sh`
to a stable structured probe ID and lock that mapping in the harness test. Keep
the shell files until Task 13 migrates their workflow/release-inventory
references; no compatibility wrapper will remain after that atomic CI commit.

- [ ] **Step 5: Verify the local command surface and commit**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts
pnpm exec tsc -p test/k8s-compat/tsconfig.json --noEmit
pnpm verify:k8s:compat -- --help
pnpm verify:k8s:compat -- --target 1.35 --context definitely-not-current
```

Expected: unit tests and help pass; the mismatch invocation fails before
mutation with an explicit-context diagnostic.

```bash
git add scripts/kubernetes-compat.ts scripts/kubernetes-compat test/k8s-compat package.json vitest.workspace.ts
git commit -m "feat(testing): add Kubernetes compatibility command"
```

### Task 13: Add The Endpoint Matrix And Align Canonical CI

**Files:**
- Create: `.github/workflows/kubernetes-compat.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `packages/sandbox/test/ci-workflow-pins.test.ts`
- Create: `test/k8s-compat/workflow.test.ts`
- Modify: `test/k8s-smoke/aimock/Dockerfile`
- Modify: `test/k8s-smoke/app/dawn.config.ts`
- Modify: `test/k8s-smoke/build-image.sh`
- Modify: `test/k8s-smoke/assert-k8s.sh`
- Delete: `test/k8s-smoke/setup-network-policy-control.sh`
- Delete: `test/k8s-smoke/assert-reaper.sh`
- Modify: `packages/sandbox/test/docker-sandbox.integration.test.ts`
- Modify: `scripts/release/test/fixtures/workflow-entrypoints.json`
- Modify: `scripts/release/test/fixtures/workflow-safe-executables.json`

- [ ] **Step 1: Write failing workflow-contract tests**

Parse both workflow files with `yaml`. For the dedicated
`kubernetes-compat.yml` workflow, require:

- `pull_request`, nightly `schedule`, and `workflow_dispatch`, with no
  workflow-level path filter;
- read-only contents permission;
- `scope`, `compat`, and `kubernetes-compat` jobs only;
- scope checkout `fetch-depth: 0`;
- matrix `fail-fast: false` and lower/upper data from policy output;
- aggregator `if: always()`, dependencies on both earlier jobs, no-op success
  only for unrelated PRs, and fail-closed handling of failed/missing results;
- concurrency that cancels superseded runs for the same pull request, while
  schedule and manual events use invocation-unique groups and are never
  coalesced;
- action references pinned by 40-character SHA;
- Node/pnpm/Helm/Kind/kubectl versions and node images equal policy;
- Calico applied only from the verified local output;
- every setup kubectl/Helm invocation names context explicitly.

For `ci.yml`, inspect only the canonical Kubernetes 1.35 sandbox,
full-application, and chart-apply jobs and require their relevant setup values
to use policy pins; do not constrain the unrelated CI job inventory.

Add static scans rejecting remote tag-only fixture images in active workflow,
smoke Dockerfile, smoke Dawn config, and build helper. Parse
`charts/dawn-sandbox-infra/values.yaml` and require its reaper
repository/tag/digest to reconstruct `policy.images.reaper` exactly.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts workflow
pnpm --filter @dawn-ai/sandbox test ci-workflow-pins
```

- [ ] **Step 3: Create the dedicated workflow**

The `scope` job performs checkout/setup/frozen install, then writes trusted
`required` and compact `matrix` outputs from `workflow.ts`. `compat` runs only
when required, creates a unique Kind cluster with:

```yaml
uses: helm/kind-action@ef37e7f390d99f746eb8b610417061a60e82a6cc # v1.14.0
with:
  version: v0.32.0
  kubectl_version: v1.35.6
  node_image: ${{ matrix.nodeImage }}
  config: .github/kind/kind-calico.yaml
  cluster_name: ${{ matrix.clusterName }}
```

Set Helm explicitly through the existing pinned setup action with
`version: v4.2.3`. Prepare Calico to a runner-temp file, apply it with the exact
Kind context, wait for readiness, invoke `pnpm verify:k8s:compat`, and upload
only `artifacts/testing/kubernetes-compat/**` with the pinned upload-artifact
action on failure/always as appropriate.

Set workflow concurrency so pull-request runs share a PR-specific group and
cancel in progress, while `schedule` and `workflow_dispatch` include
`github.run_id` in the group and set `cancel-in-progress: false`. Do not use a
branch-only fallback that could combine separate nightly or manual
invocations.

The aggregator must first require `needs.scope.result == success`; if
`required == false`, exit zero; otherwise require `needs.compat.result == success`.

- [ ] **Step 4: Align canonical jobs and immutable smoke inputs**

Replace the canonical `sandbox-k8s` body with verified Calico setup plus the
same harness for target 1.35. Keep `sandbox-k8s-e2e` as the packaged-app proof,
but give every Kind/Helm/kubectl setup an explicit policy version/context.
After Helm setup, run the chart/provider permission parity test with
`DAWN_REQUIRE_HELM=1` so it cannot skip in hosted Kubernetes evidence.

Use these immutable updates:

- all live sandbox integration constants and smoke app config use
  `policy.images.sandboxWorkload` (literal digest where runtime config cannot
  import the policy);
- `aimock/Dockerfile` uses the same Node 22 digest in `FROM`;
- `build-image.sh` reads `images.packagedAppBase` from the policy, requires
  exactly one generated `FROM node:24-slim`, and replaces it only in the
  smoke-only augmented Dockerfile;
- chart apply uses `image.digest` for nginx and the full curl digest;
- `assert-k8s.sh` requires `DAWN_TEST_K8S_CONTEXT` and routes every kubectl call
  through a wrapper that injects `--context`; and
- Docker-gated sandbox lanes pull/use the same digest rather than a mutable
  Node 22 tag.

Do not change the production node-target Dockerfile generator.

After the canonical jobs invoke the structured harness, delete
`setup-network-policy-control.sh` and `assert-reaper.sh` and remove their
workflow and release-inventory references in this same commit. No compatibility
wrappers are required.

- [ ] **Step 5: Update workflow security inventories**

Add `kubernetes-compat.yml` and changed `ci.yml` descriptors to both readable
fixtures. Every action and run block must match byte-for-byte and be classified
`safe`; no publication classification belongs in either workflow.

- [ ] **Step 6: Run static CI verification**

```bash
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts workflow policy calico scope
pnpm --filter @dawn-ai/sandbox test ci-workflow-pins
pnpm test:release-controller
node scripts/release/check-inventory.mjs
git diff --check
```

Expected: PASS, including the complete workflow entrypoint/safe-executable
audit.

- [ ] **Step 7: Commit**

```bash
git add .github packages/sandbox/test test/k8s-smoke test/k8s-compat scripts/release/test/fixtures
git commit -m "ci: add Kubernetes compatibility matrix"
```

### Task 14: Document And Release The Breaking Hardening Change

**Files:**
- Modify: `charts/dawn-sandbox-infra/README.md`
- Modify: `charts/dawn-sandbox-infra/values.yaml`
- Modify: `charts/dawn-sandbox-infra/templates/NOTES.txt`
- Modify: `packages/sandbox/README.md`
- Modify: `apps/web/content/docs/sandbox.mdx`
- Modify: `CONTRIBUTORS.md`
- Regenerate: `packages/cli/docs/sandbox.md`
- Create: `test/k8s-compat/docs-policy.test.ts`
- Create: `.changeset/kubernetes-compat-hardening.md`

- [ ] **Step 1: Add documentation assertions/searches before prose edits**

Confirm current docs still contain the overstated Secret claim and baseline
default. First add a failing `docs-policy.test.ts` that loads the compatibility
policy and requires each documented supported minor/tool version to come from
that policy, checks the portable command's exact flag surface, and rejects
managed-cloud/CNI/storage certification wording. Then use the existing docs
completeness check after replacement:

```bash
rg -n 'No access to Secrets|enforce.*baseline|baseline.*default' \
  charts/dawn-sandbox-infra/README.md apps/web/content/docs/sandbox.mdx
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts docs-policy
```

- [ ] **Step 2: Update operator and package documentation**

Document:

- policy-pinned Kind/Calico patch coverage for Kubernetes 1.34, 1.35, 1.36;
- no managed-cloud/CNI/storage certification claim;
- restricted as the chart default and explicit baseline override for opt-out
  workloads;
- `namespace.extraLabels` and its reserved-label guard;
- the portable command, exact context requirement, dynamic RWO storage, PSA,
  and policy-enforcing CNI prerequisites;
- direct Secret API reads are denied, but Pod-create can mount a known Secret,
  so the sandbox namespace must contain no application credentials;
- complete preflight permission behavior; and
- custom client migration from positional `canI` to
  `canI(namespace, permission)` with exported `KubePermission`.

Update CONTRIBUTORS with the ordinary local command and explain that endpoint
Kind lanes are scoped/nightly while the full packaged-app lane remains 1.35.

- [ ] **Step 3: Add the patch changeset**

```md
---
"@dawn-ai/sandbox": patch
---

Validate the complete Kubernetes runtime permission contract during preflight,
replace existing owned NetworkPolicies with their live resource version, and
export the structured `KubePermission` type. Custom `KubeClient`
implementations must replace positional `canI(namespace, verb, resource)` with
`canI(namespace, permission)`; no compatibility overload is provided.
```

Do not add a `dawn-app` chart bump. `dawn-sandbox-infra` is already `0.1.3` from
Task 3. Keep the package changeset at patch because the repository is a fixed
0.x release group.

- [ ] **Step 4: Regenerate bundled CLI docs and verify**

```bash
pnpm --filter @dawn-ai/cli build
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts docs-policy policy workflow
node scripts/check-docs.mjs
node scripts/check-changesets.mjs
git diff --check
```

Expected: PASS; generated `packages/cli/docs/sandbox.md` matches website source.

- [ ] **Step 5: Commit**

```bash
git add charts/dawn-sandbox-infra packages/sandbox/README.md apps/web/content/docs/sandbox.mdx CONTRIBUTORS.md packages/cli/docs/sandbox.md test/k8s-compat/docs-policy.test.ts .changeset/kubernetes-compat-hardening.md
git commit -m "docs: document Kubernetes compatibility hardening"
```

### Task 15: Run Complete Verification And Hosted Compatibility

**Files:**
- Verify: all changed files
- Operational: GitHub branch protection after the new check has reported

- [ ] **Step 1: Run focused package and harness verification**

```bash
pnpm --filter @dawn-ai/sandbox build
pnpm --filter @dawn-ai/sandbox typecheck
pnpm --filter @dawn-ai/sandbox lint
pnpm --filter @dawn-ai/sandbox test
pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts
pnpm exec tsc -p test/k8s-compat/tsconfig.json --noEmit
```

- [ ] **Step 2: Run chart verification**

```bash
sh charts/dawn-sandbox-infra/test/render.sh
sh charts/dawn-sandbox-infra/test/reaper.test.sh
helm lint --strict charts/dawn-sandbox-infra
helm template test charts/dawn-sandbox-infra \
  | kubeconform -strict -summary -ignore-missing-schemas
sh charts/dawn-app/test/render.sh
helm lint --strict charts/dawn-app
helm template test charts/dawn-app --set image.repository=example/app \
  | kubeconform -strict -summary -ignore-missing-schemas
```

- [ ] **Step 3: Run the repository Definition of Done**

```bash
pnpm ci:validate
git diff --check
git status --short
```

Expected: all required local lanes pass and only intentional plan/spec commits
plus implementation commits are present.

- [ ] **Step 4: Perform two-stage review**

Dispatch fresh spec-compliance and code-quality reviewers over the approved
spec, this plan, and the complete branch diff. Resolve findings with focused
tests and rerun affected verification. Use `superpowers:systematic-debugging`
for any unexpected failure.

- [ ] **Step 5: Push and open a pull request only when explicitly requested**

The PR summary must call out the public `KubeClient.canI` break, restricted
chart default, portable command, endpoint matrix, immutable fixtures, and
Secret boundary. Do not mention implementation agents or tools.

- [ ] **Step 6: Require hosted evidence before merge**

Require the complete CI workflow plus the dedicated compatibility workflow.
Confirm at minimum:

- `validate`;
- `chart-validate`;
- `chart-apply-smoke`;
- canonical `sandbox-k8s`;
- canonical `sandbox-k8s-e2e`;
- endpoint Kubernetes 1.34;
- endpoint Kubernetes 1.36; and
- stable `kubernetes-compat` aggregator.

Inspect each compatibility report for exact expected IDs and zero skips. Do not
accept a retry that changes policy inputs or weakens an assertion.

- [ ] **Step 7: Add the stable required context and merge on green**

After `kubernetes-compat` has reported successfully at least once, update main
branch protection without removing existing requirements so both `validate`
and `kubernetes-compat` are required. Re-read protection to verify the write,
then merge only the reviewed head SHA after every hosted lane is green.
