# Dedicated Infrastructure Lanes: Local Evidence Design

**Date:** 2026-08-11

## Summary

Run Dawn's complete gated infrastructure ladder locally before requesting the
hosted Linux evidence required for merge. The checked-in workflows and
Kubernetes compatibility policy remain canonical. This phase does not add a
second public runner or duplicate the workflow lifecycle in product code.

The local pass uses an isolated, temporary tool directory, disposable Kind
clusters, exact policy-pinned images, bounded diagnostics, and automatic
cleanup. Source changes are made only when a lane exposes a reproducible Dawn
defect. The static review performed for this design has already established one
such defect in the Docker E2E cleanup path, described below. Platform or
registry limitations are reported separately and never worked around by
weakening assertions or replacing pins without evidence.

## Goals

- Exercise every dedicated chart, Kubernetes, and Docker infrastructure lane.
- Match the repository's pinned cluster versions, images, and workflow commands.
- Distinguish environment failures from product failures before changing code.
- Capture enough secret-safe evidence to debug a failed lane after cleanup.
- Leave no cluster, container, volume, network, or temporary credential behind.
- Preserve the existing workflow and harness as the canonical API surface.

## Non-goals

- Adding a new public `verify:infra` command during the initial evidence pass.
- Replacing GitHub Actions as the required hosted Linux evidence source.
- Certifying Docker Desktop, macOS, ARM64, managed Kubernetes, or another CNI.
- Changing compatibility pins merely to make a local machine pass.
- Running unrelated gated Postgres, pgvector, or inspector lanes.
- Pushing a branch, opening a pull request, or changing branch protection.

## Existing Authority

The execution must derive its values and commands from these checked-in
sources:

- `.github/kubernetes-compatibility.json` for Kind, Kubernetes, Calico, and
  workload image pins;
- `.github/workflows/kubernetes-compat.yml` for the 1.34 and 1.36 endpoint
  matrix;
- `.github/workflows/ci.yml` for canonical 1.35, full-application Kubernetes,
  Docker, and chart-apply lanes;
- `scripts/kubernetes-compat/**` for the portable focused harness; and
- `test/k8s-smoke/**` for packaged-application E2E behavior.

Commands copied from workflows may be parameterized only for unique local
resource names and temporary paths. Assertions, manifests, image digests,
timeouts, and provider behavior remain unchanged.

Run each workflow prerequisite in its corresponding lane. This includes the
Helm-backed `chart-rbac` parity test, sandbox-workload image preloading for the
Kubernetes E2E lane, and host checks for `curl` and `jq` where the checked-in
scripts require them.

## Toolchain Isolation

Docker Desktop is the local container runtime. No global Homebrew installation
or upgrade is required.

Create a temporary tool directory outside the repository and prepend it to
`PATH`. Download the Darwin ARM64 builds of `kind v0.32.0` and `kubectl
v1.35.6` from their official release locations. Verify each download against
its upstream-published checksum before execution. Reject redirects or checksum
mismatches that do not resolve to the expected release artifact.

Use the installed Node 24 runtime through the existing explicit Node 24 path,
pnpm 10.33.0, and Helm 4.2.3-compatible behavior. Preflight reports the actual
Docker, operating-system architecture, Node, pnpm, Helm, Kind, and kubectl
versions, plus `curl` and `jq` availability. A missing or incompatible
prerequisite stops before cluster mutation.

The temporary binaries are removed after the run. They are not committed,
added to package scripts, or installed over the user's existing kubectl.

## Local Safety Contract

Each Kind cluster has a run-specific `dawn-local-*` name and is deleted by
exact name. Cleanup tracks only clusters created during this run. It must never
delete a pre-existing cluster whose creation was not observed.

The Docker E2E lane uses fixed app, mock, and network names, while the provider
creates sandbox containers and volumes from the returned thread ID. Static
review found that `test/k8s-smoke/assert-docker.sh` currently deletes every
container named `dawn-sbx-*` and every volume named `dawn-sbx-vol-*` both before
the test and from its exit trap. That behavior cannot satisfy local ownership
or diagnostics-first cleanup on a shared Docker daemon.

Before executing the Docker E2E lane, harden this test script under regression
coverage so it:

- refuses to start when its exact app, mock, network, sandbox-container, or
  sandbox-volume namespace is already occupied;
- never performs prefix-wide clean-slate deletion;
- derives and records the expected sandbox container and volume from the
  thread created by this run and the provider's identity labels;
- captures bounded diagnostics on every nonzero exit and handled signal before
  cleanup; and
- removes only the exact app, mock, network, sandbox container, and volume
  created by this run.

The Docker smoke lane must run without concurrent Dawn sandbox activity on the
same daemon. If the exclusive preflight cannot be established or the resource
set changes unexpectedly, stop and report the conflict instead of deleting or
adopting it.

Run clusters sequentially because Docker Desktop has finite memory and the
matrix does not need concurrency for local evidence. Capture diagnostics before
cleanup. Signal interruption enters the same diagnostics and exact-resource
cleanup path.

## Lane Order

Run the full ladder in this order:

1. **Chart apply smoke, Kubernetes 1.35.** Create a default-CNI Kind cluster,
   install `dawn-app` with the policy-pinned non-root placeholder image, wait
   for rollout, and prove Service reachability with the pinned curl image.
2. **Canonical focused compatibility, Kubernetes 1.35.** Create a no-CNI Kind
   cluster, install the verified Calico manifest, and run
   `pnpm verify:k8s:compat` for target `1.35`.
3. **Lower endpoint focused compatibility, Kubernetes 1.34.** Repeat the
   portable harness with the lower policy node image and target `1.34`.
4. **Upper endpoint focused compatibility, Kubernetes 1.36.** Repeat with the
   upper policy node image and target `1.36`.
5. **Packaged Dawn application Kubernetes E2E, Kubernetes 1.35.** Build the
   workspace, publish packages to the temporary Verdaccio registry, build and
   load the user-facing app and mock-model images, install both charts, execute
   the Agent Protocol flow, assert real sandbox output, and verify deletion.
6. **Packaged Dawn application Docker E2E.** Build the Docker variant, run the
   app with Docker socket access, execute the same deterministic agent flow,
   assert execution in a sibling sandbox container, and verify container and
   volume deletion.

A failed lane blocks only lanes that depend on the confirmed failed
prerequisite. A version-specific canonical 1.35 failure does not block the
independent 1.34 or 1.36 clusters. A confirmed shared failure such as an invalid
Calico manifest checksum may block all Calico-backed lanes. The Kubernetes E2E
lane may remain blocked by a confirmed shared 1.35 or Calico prerequisite
failure, while the Docker E2E lane remains independent. Independent lanes
continue so one pass produces the broadest useful evidence.

## Evidence And Diagnostics

Maintain a per-lane result with:

- lane name and status;
- exact tool and policy versions;
- cluster or Docker resource identity;
- start and finish timestamps;
- command exit status;
- native harness artifact path, when applicable;
- failure classification; and
- cleanup status.

Before deleting a failed Kubernetes cluster, capture bounded output for nodes,
all-namespace Pods, warning Events, storage classes, Calico workloads, Helm
releases, relevant workload descriptions, and relevant container logs. Preserve
the compatibility harness JSON and its stable step IDs. Before Docker cleanup,
capture bounded container state and logs.

Artifacts belong under the existing ignored `artifacts/testing/` hierarchy.
Never collect Secrets, ServiceAccount tokens, temporary kubeconfigs, complete
environment dumps, registry credentials, or unbounded logs.

## Failure Classification

Classify every failure before changing source:

1. **Bootstrap/environment:** tool download or checksum failure, Docker daemon
   failure, unsupported host architecture, insufficient resources, or external
   registry/network failure.
2. **Cluster setup:** Kind control plane, node readiness, Calico, default
   storage class, or other pre-harness infrastructure failure.
3. **Dawn behavior:** compatibility assertion, provider, chart lifecycle,
   permission, packaged application, or E2E contract failure.
4. **Cleanup:** an owned cluster or observed disposable resource could not be
   removed or its removal could not be confirmed.

One clean retry is allowed only for a transient bootstrap, image-pull, or
cluster-setup failure. A Kubernetes retry uses a newly created cluster. A
Docker retry begins only after the exact resource namespace has again been
verified empty. Dawn assertion failures are not retried before root-cause
analysis.

An ARM64-only failure is evidence about the local environment, not evidence
against the policy's Ubuntu AMD64 contract. Report it explicitly and retain the
equivalent hosted lane as required evidence.

## Targeted Retention

Automatic cleanup is the default for the full ladder. If first-pass diagnostics
are insufficient, a targeted Kubernetes rerun may retain its disposable
cluster for interactive inspection. For a focused compatibility rerun, pass
`--keep-on-failure` so the harness retains only ownership-verified cluster
resources, and suppress outer Kind deletion only after the failed result has
been recorded. For chart or Kubernetes E2E reruns, retain the whole uniquely
named disposable cluster rather than bypassing chart ownership checks.

Retention is never automatic and never applies to the Docker E2E lane. Record
the retained cluster name and reason, perform no unrelated work in it, and
delete it by exact name before declaring the local phase complete. A signal
during an ordinary first-pass run still performs diagnostics followed by
cleanup; it does not convert the run into retained mode.

## Defect Workflow

When a Dawn failure is reproducible:

1. reduce it to the narrowest stable failing test;
2. add the regression test and confirm the red state;
3. implement the smallest fix within existing ownership boundaries;
4. run focused unit, type, and lint checks;
5. rerun the failed live lane from a clean environment; and
6. rerun downstream lanes that exercise the changed behavior.

Do not weaken assertions, add a local-only behavior branch, or silently skip a
gated test. A pin change requires proof that the checked-in artifact is invalid
and must update policy validation, workflow contract tests, affected docs, and
the live lane together.

## Completion Criteria

The local phase is complete when:

- every one of the six lanes has a recorded result;
- every feasible lane passes on a clean attempt;
- any host-specific limitation has bounded diagnostics and a named hosted
  equivalent;
- all created clusters and observed Docker resources are confirmed removed;
- any code fix has passed focused tests and the affected live reruns;
- the worktree is clean apart from intentional committed fixes; and
- no Git push, workflow dispatch, pull request, branch-protection change, or
  other hosted-state mutation has occurred. Tool downloads and image pulls are
  expected network reads and are not prohibited by this condition.

Local success does not replace hosted evidence. Before merge, the reviewed head
must still pass the repository's required GitHub Actions jobs, including the
canonical Kubernetes lane, chart-apply smoke, Kubernetes E2E, Docker E2E, and
the 1.34 and 1.36 compatibility matrix.
