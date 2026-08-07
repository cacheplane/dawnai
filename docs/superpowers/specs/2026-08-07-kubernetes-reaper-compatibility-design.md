# Kubernetes Reaper Compatibility Design

## Summary

Align the `dawn-sandbox-infra` PVC reaper's bundled `kubectl` with Dawn's
tested Kubernetes release and make that compatibility relationship explicit,
testable, and exercised against a real cluster.

The chart currently defaults to `docker.io/alpine/k8s:1.31.1`, while the
active Kind lanes use Kubernetes 1.35 through `helm/kind-action` v1.14.0.
Kubernetes supports `kubectl` within one minor version of `kube-apiserver`, so
the existing four-minor skew is outside the supported contract even though the
current smoke tests pass.

## Goals

- Default the reaper to a digest-pinned image containing Kubernetes 1.35
  `kubectl`, a POSIX shell, and `date`.
- Make the Kubernetes version used by all active Kind lanes explicit and
  immutable.
- Fail fast when the tested Kubernetes minor and default reaper client drift
  outside Kubernetes' supported one-minor skew.
- Preserve default-deny egress for Dawn-managed sandbox pods while allowing
  the Helm-managed reaper to reach the Kubernetes API reliably.
- Exercise the installed reaper against real PVCs in Kind.
- Document the supported default cluster window and operator override.

## Non-goals

- Changing the `reaper.image` values API.
- Publishing a Dawn-owned reaper image.
- Supporting every historical Kubernetes release with one default image.
- Adding a multi-version Kubernetes CI matrix.
- Changing `node:22-slim` sandbox workload fixtures.
- Changing the reaper's TTL algorithm or RBAC permissions.

## Design

### Version contract

The default reaper image becomes:

```text
docker.io/alpine/k8s:1.35.6@sha256:b7a12c5ddf261994c33d2eaaa06fd69a0803ff6b38683bfa3d30a76dcdf92807
```

The digest is the multi-architecture manifest for linux/amd64 and linux/arm64.
Version 1.35 is the midpoint of the currently maintained Kubernetes 1.34,
1.35, and 1.36 releases, placing the client within one minor of all three.

All three `helm/kind-action` steps explicitly set:

```yaml
node_image: kindest/node:v1.35.0@sha256:4613778f3cfcd10e615029370f5786704559103cf27bef934597ba562b269661
```

This preserves the Kubernetes version already selected by the action while
preventing an action-default change from silently changing the tested cluster.
The digest is the multi-architecture Kind node manifest.

The existing `reaper.image` string remains the complete image reference. It
already supports arbitrary registries, tags, and digests and avoids a breaking,
more cumbersome repository/tag/digest split.

The image must provide `kubectl`, a POSIX shell, `date`, `sort`, and `grep`,
which are all invoked by `files/reaper.sh`.

### Network-policy scope

The existing namespace-wide default-deny policy also selects the reaper. It
allows DNS only, so a policy-enforcing production cluster can block the
reaper's Kubernetes API calls even though Kind may exempt node traffic.

Change the policy selector from all pods to:

```yaml
podSelector:
  matchLabels:
    app.kubernetes.io/managed-by: dawn
```

The Kubernetes sandbox provider applies this label to every sandbox pod. The
chart deliberately labels its own resources `app.kubernetes.io/managed-by:
Helm`, so the reaper Job is outside the policy and can use its in-cluster API
credentials. This preserves the fail-closed backstop for the workloads the
chart exists to constrain without relying on cluster-specific API-server
addresses, service translation behavior, or ports.

The README description changes from a namespace-wide backstop to a backstop
for Dawn-managed sandbox pods. Arbitrary pods manually placed in the dedicated
namespace are outside this policy and remain the operator's responsibility.

### Static policy test

Extend `packages/sandbox/test/ci-workflow-pins.test.ts`, which already parses
the CI workflow as YAML, to collect the `node_image` input from every active
`helm/kind-action` step. Parse the chart defaults with the same YAML library and
extract the Kubernetes minor from both image references.

The tests require:

- all three Kind steps use the approved digest-pinned Kubernetes 1.35 image;
- the chart's default reaper uses the approved digest-pinned 1.35.6 image;
- both image references include a `sha256` digest;
- the absolute minor-version difference is at most one.

Malformed or unversioned image references fail the test instead of being
ignored. Custom operator overrides are not constrained because compatibility
then belongs to the operator.

### Real-cluster smoke

Add a focused shell script under `test/k8s-smoke/` and call it from the existing
`sandbox-k8s` lane after chart installation. The script:

1. Creates a managed, unbound PVC with an old `dawn.sh/unbound-since` marker.
2. Creates a managed, unbound PVC without a marker.
3. Creates a managed PVC referenced by a pod and gives it a stale marker.
4. Creates a one-off Job from the installed `dawn-reaper` CronJob.
5. Waits for successful completion.
6. Verifies the stale unbound PVC was deleted, the newly unbound PVC was marked,
   and the bound PVC was retained with its stale marker removed.
7. Deletes smoke fixtures through a shell trap.

The test uses the chart's actual ConfigMap, ServiceAccount, image, security
context, RBAC, and network policy on a Calico-enabled cluster. It does not wait
for the hourly schedule or duplicate the CronJob manifest. The existing
provider integration suite gains a `network: "allow"` case that attempts
to reach a deterministic in-cluster HTTP control service. Before the suite,
the CI lane starts that service in an unlabeled pod and proves an unlabeled
client can reach it. The integration test then acquires a fresh allow-mode
sandbox, verifies that no per-thread NetworkPolicy exists for it, and verifies
that the same service is unreachable. Allow mode emits no per-thread policy,
the positive control proves the service is healthy, and in-cluster DNS remains
allowed, so the chart's label-scoped backstop is isolated as the blocker. The
existing `network: "deny"` test continues to cover the provider's per-thread
policy separately.

### Documentation and release metadata

Update the chart README to state that the default 1.35 client supports
Kubernetes 1.34 through 1.36 under the upstream version-skew policy. Operators
outside that window must override `reaper.image` with an image containing a
compatible `kubectl`, POSIX shell, `date`, `sort`, and `grep`. The values table
shows the complete default tag-plus-digest reference.

Bump `charts/dawn-sandbox-infra/Chart.yaml` from `0.1.1` to `0.1.2`. This chart
change does not alter an npm package and therefore does not require a
Changesets entry.

## Verification

- Run the static workflow/version policy tests.
- Run the reaper shell unit test and Helm render assertions.
- Run strict Helm lint and kubeconform against rendered defaults.
- Run `pnpm --filter @dawn-ai/sandbox test`.
- Run the gated Kubernetes integration suite and confirm both the label-scoped
  chart backstop and the one-off reaper Job pass under Calico.
- Run the full repository validation lane.
- Confirm the hosted `sandbox-k8s` job completes the real-cluster reaper smoke.

## Risks

`alpine/k8s` remains a third-party runtime image. Digest pinning prevents tag
mutation from changing deployed bytes, but it does not replace supply-chain
trust. A Dawn-owned minimal reaper image would require image build, publication,
security scanning, and release lifecycle work and is intentionally deferred.

One default client cannot support arbitrary old and future clusters. The
documented override preserves operator control, while the default covers the
maintained Kubernetes window at the time of this change.
