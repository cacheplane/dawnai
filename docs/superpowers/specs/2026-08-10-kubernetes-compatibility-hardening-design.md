# Kubernetes Compatibility and Hardening Design

**Date:** 2026-08-10
**Status:** approved
**Scope:** `@dawn-ai/sandbox`, `dawn-sandbox-infra`, Kubernetes verification, and contributor documentation

## Summary

Dawn currently proves its Kubernetes sandbox and Helm composition against one
Kind cluster running Kubernetes 1.35. The `dawn-sandbox-infra` chart documents a
1.34 through 1.36 compatibility window because its Kubernetes 1.35 reaper
client is within the upstream `kubectl` version-skew contract, but the lower and
upper server minors are not exercised.

This work adds a portable, kubecontext-agnostic compatibility harness and a
required endpoint matrix for Kubernetes 1.34 and 1.36. The existing full Dawn
application lane remains on canonical Kubernetes 1.35. The matrix runs on
relevant pull requests and nightly, while one stable aggregator check remains
present on every pull request.

The same project closes concrete hardening gaps. The sandbox infrastructure
chart enforces the Kubernetes `restricted` Pod Security profile by default,
the provider preflight checks its complete runtime RBAC contract, and the live
suite proves the generated security context at both the Kubernetes object and
kernel levels.

The harness deliberately does not provision managed cloud infrastructure. It
runs against an explicitly confirmed current kubecontext, so a later design can
reuse it for GKE, EKS, AKS, or another conformant cluster without moving test
logic into provider-specific automation.

## Context

The current repository already has strong Kubernetes coverage:

- `sandbox-k8s` installs Kind and Calico, installs `dawn-sandbox-infra`, checks
  representative RBAC permissions, runs real provider conformance, and
  exercises the PVC reaper.
- `sandbox-k8s-e2e` deploys a packaged Dawn application through `dawn-app`, runs
  that application under its real ServiceAccount, creates a sandbox Pod in a
  separate namespace, executes a tool there, and proves teardown.
- `chart-validate` runs strict Helm lint, render assertions, and kubeconform.
- `chart-apply-smoke` installs the application chart with a lightweight image
  and proves Service reachability.
- Static policy tests keep the Kind image, reaper image, and Calico version from
  silently drifting.

The remaining gaps are narrower:

1. Kubernetes 1.34 and 1.36 are documented but not executed.
2. The real-cluster security assertions cover non-root execution, read-only
   root, network denial, and PVC durability, but not capability state,
   `NoNewPrivs`, seccomp state, token absence, quota admission, or restricted
   Pod Security rejection.
3. `kubernetesSandbox().preflight()` checks only `create pods`, although a run
   also needs Pod reads/deletes, PVC lifecycle operations, WebSocket exec, and
   NetworkPolicy lifecycle operations.
4. The current NetworkPolicy update path performs a replace with a newly built
   object that has no `resourceVersion`; a live re-acquire over an existing
   deny policy can therefore fail instead of updating the policy.
5. The chart defaults to `baseline` Pod Security enforcement and only
   warns/audits at `restricted`.
6. Existing cluster setup and assertions are split between workflow YAML,
   shell scripts, and Vitest in a form that is not one documented command for
   an arbitrary kubecontext.

## Goals

- Execute the focused provider and chart contract on Kubernetes 1.34 and 1.36.
- Keep the expensive packaged-application end-to-end proof on Kubernetes 1.35.
- Run endpoint coverage on relevant pull requests, nightly, and manually.
- Make endpoint coverage required for relevant pull requests through one stable
  aggregator check.
- Provide one portable command that can later run against a managed cluster.
- Enforce the `restricted` Pod Security profile by default.
- Fail `dawn check` before a run when any required Kubernetes permission is
  missing.
- Prove live hardening through observable kernel and filesystem state.
- Keep every cluster, CNI, workload, probe, and tool input immutable or
  checksum-verified, including images referenced transitively by the Calico
  manifest.
- Emit actionable diagnostics without uploading credentials or tokens.

## Non-goals

- Provisioning or continuously paying for GKE, EKS, or AKS CI clusters.
- Certifying a managed Kubernetes distribution in this iteration.
- Running the full packaged Dawn application on every Kubernetes minor.
- Testing upgrades from historical chart releases.
- Preserving the old `KubeClient.canI(ns, verb, resource)` test seam.
- Preserving `baseline` as the chart's default Pod Security enforcement.
- Testing multiple CNIs.
- Adding gVisor, Kata, or microVM runtime classes.
- Configuring node-level PID limits.
- Supporting Kubernetes versions outside 1.34 through 1.36.

## Chosen Architecture

### Harness-first boundary

The compatibility logic lives in a repository command, not in GitHub Actions.
The workflow is responsible only for selecting a version, creating a cluster,
installing its CNI, and invoking the command.

The root command is:

```text
pnpm verify:k8s:compat -- --target 1.34 --context kind-dawn-compat-134
```

The command:

- requires an exact `--context` value and refuses to continue when it differs
  from `kubectl config current-context`;
- passes that context explicitly to every `kubectl` operation and as
  `helm --kube-context`; no later ambient-context lookup is allowed;
- requires a declared compatibility target from the checked-in policy;
- verifies the server minor before creating resources;
- accepts an optional storage-class override for clusters without a suitable
  default class;
- creates unique release names and namespaces carrying a run label;
- runs the focused suite;
- writes a structured report under `artifacts/testing/kubernetes-compat/`;
- deletes only resources owned by that run; and
- supports an explicit keep-on-failure diagnostic flag.

The harness does not create a cluster, install a CNI, switch kubecontexts, or
infer permission to destroy an existing namespace. The caller supplies a ready
cluster with dynamic ReadWriteOnce storage, Pod Security Admission, and a
NetworkPolicy-enforcing CNI.

The root script builds the `@dawn-ai/sandbox` dependency closure before running
the harness, so the advertised command cannot consume stale `dist/` output. A
caller must already have run the repository's normal frozen dependency install;
the command does not mutate the lockfile or install dependencies implicitly.

### Component layout

The implementation should preserve the existing package boundaries:

- A small root harness coordinates `helm`, `kubectl`, and package test commands.
  Kubernetes JSON output is parsed structurally rather than scraped from human
  text.
- Real provider behavior remains in
  `packages/sandbox/test/kube-sandbox.integration.test.ts` and focused support
  modules under `packages/sandbox/test/`.
- Chart-level admission, reaper, placeholder application, and upgrade probes
  remain under `test/k8s-smoke/` or a focused `test/k8s-compat/` directory.
- The workflow consumes a checked-in compatibility policy and does not
  duplicate version literals across matrix entries.

The exact file split may follow the implementation plan, but no single shell
script should absorb policy parsing, lifecycle orchestration, and every test
assertion.

## Compatibility Policy

A checked-in JSON policy is the source of truth for the supported matrix and
immutable test inputs. It records:

- Kind `v0.32.0`;
- Node `24.17.0`;
- pnpm `10.33.0`;
- Helm `v4.2.3`;
- kubectl `v1.35.6`;
- canonical Kubernetes 1.35.5;
- endpoint Kubernetes 1.34.8 and 1.36.1;
- digest-pinned Kind node images;
- the Calico manifest URL, expected SHA-256, and exact image rewrites;
- the digest-pinned sandbox workload image; and
- every digest-pinned probe, placeholder, and smoke-build base image used by
  the focused and canonical suites.

The initial Kind images come from the official Kind v0.32.0 release:

| Role | Kubernetes | Image |
| --- | --- | --- |
| lower endpoint | 1.34.8 | `kindest/node:v1.34.8@sha256:02722c2dedddcfc00febf5d27fbeb9b7b2c14294c82109ff4a85d89ac9ba3256` |
| canonical | 1.35.5 | `kindest/node:v1.35.5@sha256:ce977ae6d65918d0b58a5f8b5e940429c2ce42fa3a5619ec2bbc60b949c0ac95` |
| upper endpoint | 1.36.1 | `kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5` |

The current `helm/kind-action` pin remains acceptable, but every active Kind
job sets its `version` input to `v0.32.0`; the action's current default is
v0.31.0 and cannot be allowed to select the runtime implicitly.

The workflow installs Helm `v4.2.3` and kubectl `v1.35.6` explicitly. It does
not consume an action, runner, or package-manager `latest` default. kubectl
1.35.6 matches the reaper's client minor and remains within one minor of every
supported API server.

Calico 3.32 is documented by Tigera as tested against Kubernetes 1.34, 1.35,
and 1.36. The existing 3.32.1 manifest remains the selected CNI input:

```text
https://raw.githubusercontent.com/projectcalico/calico/v3.32.1/manifests/calico.yaml
sha256:a1df919d9721cf667accdc3e72848911b0cb25cfab7d2478ad0c996302c95744
```

The workflow downloads the manifest, verifies the checksum, and applies the
verified local file. Before applying it, the workflow rewrites the manifest's
three selected image references to these multi-architecture digests:

| Calico component | Expected occurrences | Immutable image |
| --- | --- | --- |
| CNI | 2 | `quay.io/calico/cni:v3.32.1@sha256:bb1567e3ed81e2e8414e9a68f186e1f7ffd4067a4871a9ae90896793af0190dd` |
| controllers | 1 | `quay.io/calico/kube-controllers:v3.32.1@sha256:18008f781c869376dbbc4dfb1ffe3afb46f7897887d4f20e080c420ac44a6612` |
| node | 2 | `quay.io/calico/node:v3.32.1@sha256:7f874b3f0b540c2b523aea9961ef5e2f43b0af9056a47874c916d6cf348168d3` |

After verifying the raw-file checksum, a repository helper parses the
multi-document YAML and rewrites only container and init-container `image`
fields. The rewrite is fail-closed: each expected tag must occur exactly the
declared number of times, every occurrence must be replaced, and no selected
Calico workload may retain a tag-only image. The workflow never pipes an
unverified remote response into `kubectl`.

The sandbox workload fixture uses the multi-architecture digest current when
this design was approved:

```text
docker.io/library/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
```

Other external focused-suite fixtures are likewise pinned:

| Purpose | Immutable image |
| --- | --- |
| placeholder application | `nginxinc/nginx-unprivileged:stable-alpine@sha256:44e36330f74d4f3a1d4e222acca9e23b401fb87811a7597024502bb759c4dd49` |
| reachability probe | `curlimages/curl:8.10.1@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b` |
| inert admission probe | `registry.k8s.io/pause:3.10@sha256:ee6521f290b2168b6e0935a181d4cff9be1ac3f505666ef0e3c98fae8199917a` |
| packaged-app build base | `docker.io/library/node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03` |

The reaper image remains digest-pinned in the chart and is audited against the
policy. The smoke-only Dockerfile augmentation replaces the generated
`FROM node:24-slim` exactly once with the policy's packaged-app base, without
changing Dawn's production Dockerfile generator. The AI-mock Dockerfile uses
the policy's digest-pinned Node 22 base directly. Locally built
packaged-application and AI-mock images are then loaded directly into Kind;
their source and base-image inputs are no longer mutable remote tags.

Static tests require the exact set of canonical and endpoint roles, valid
minor/version relationships, digest-qualified image references, a valid
manifest checksum, exact Calico rewrite cardinality, explicit tool versions,
and one-minor skew between both kubectl clients and every supported API server.
Tag-only remote fixture references are rejected. The canonical jobs in
`ci.yml`, smoke Dockerfiles/build helpers, chart defaults, and documentation
are checked against the policy so the JSON does not become an unused
declaration.

Sources:

- [Kind releases](https://github.com/kubernetes-sigs/kind/releases/tag/v0.32.0)
- [Helm v4.2.3 release](https://github.com/helm/helm/releases/tag/v4.2.3)
- [Kubernetes v1.35.6 release](https://github.com/kubernetes/kubernetes/releases/tag/v1.35.6)
- [Calico Kubernetes requirements](https://docs.tigera.io/calico/latest/getting-started/kubernetes/requirements)
- [Kubernetes Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [Kubernetes ServiceAccount token requests](https://kubernetes.io/docs/reference/kubernetes-api/authentication-resources/token-request-v1/)
- [Kubernetes version-skew policy](https://kubernetes.io/releases/version-skew-policy/)

## CI Topology

### Dedicated workflow

A dedicated Kubernetes compatibility workflow has these triggers:

- `pull_request`;
- nightly `schedule`; and
- `workflow_dispatch`.

The pull-request trigger has no workflow-level path filter, because the stable
aggregator must report on every pull request. It does not add a schedule to
`ci.yml`, because that would run every unrelated repository job nightly.

The workflow has three logical stages:

1. `scope` checks whether the event is nightly/manual or whether a pull request
   changed a relevant path. It reads the endpoint matrix from the compatibility
   policy. Pull-request checkout uses `fetch-depth: 0`, verifies both event SHAs
   exist, and classifies the NUL-delimited output of
   `git diff --name-only -z "$BASE_SHA" "$HEAD_SHA"`; it does not depend on a
   paginated or truncated hosting API file list.
2. `compat` runs the 1.34 and 1.36 entries when scope requires it.
3. `kubernetes-compat` always reports. It succeeds immediately for an unrelated
   pull request and otherwise succeeds only when every matrix entry succeeds.

The endpoint matrix uses `fail-fast: false`, so one version failure does not
hide evidence from the other endpoint.

The stable `kubernetes-compat` context is added to `main` branch protection next
to `validate`. Individual matrix job names are not required contexts, so a
minor-version refresh does not require branch-protection churn.

The checked-in classifier treats these paths as relevant:

- `.npmrc`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
  `tsconfig.json`, and `turbo.json`;
- `.github/workflows/ci.yml`,
  `.github/workflows/kubernetes-compat.yml`, and `.github/kind/**`;
- `.github/kubernetes-compatibility.json`;
- `scripts/kubernetes-compat.ts` and `scripts/kubernetes-compat/**`;
- `test/k8s-compat/**` and `test/k8s-smoke/**`;
- `packages/sandbox/**`;
- `packages/workspace/src/sandbox-types.ts`;
- `charts/dawn-app/**`; and
- `charts/dawn-sandbox-infra/**`.

These paths fix the policy at `.github/kubernetes-compatibility.json`, the
workflow at `.github/workflows/kubernetes-compat.yml`, and the harness
entrypoint at `scripts/kubernetes-compat.ts`. A static test compares the
classifier with this ownership list. Scope parsing, missing SHAs, malformed
policy, unknown target roles, and matrix-result parsing all fail closed: they
make `kubernetes-compat` fail rather than silently skip required coverage.

Nightly and manual events force the matrix regardless of paths. Concurrency
cancels superseded runs for the same pull request or branch without combining
distinct nightly/manual invocations.

### Endpoint job flow

Each endpoint matrix entry:

1. Checks out the repository, performs the repository's frozen pnpm install,
   and installs Node `24.17.0`, pnpm `10.33.0`, Helm `v4.2.3`, Kind `v0.32.0`,
   and kubectl `v1.35.6` explicitly.
2. Creates a uniquely named Kind cluster from the target's digest-pinned node
   image with the default CNI disabled.
3. Downloads the pinned Calico manifest, verifies its checksum, applies the
   exact digest rewrites, and installs the resulting local file. Every setup
   `kubectl` call names the generated Kind context explicitly.
4. Waits for Calico and the target node to become ready.
5. Invokes the portable harness with the exact generated context and target.
6. Uploads the credential-free structured report and bounded cluster
   diagnostics on failure.
7. Lets the pinned Kind action remove the cluster in its post step.

The existing Kubernetes 1.35 provider lane invokes the same portable focused
harness with the canonical target. The full packaged-application and
chart-apply jobs remain required evidence in `ci.yml`; the packaged application
is still intentionally exercised only on 1.35. All canonical jobs move to the
Kind version, Kubernetes image, tool versions, Calico verification, and fixture
digests declared by the policy.

## Provider Preflight Contract

### Structured permission probe

The narrow `KubeClient` seam replaces positional `canI` parameters with an
exported, discriminated resource permission:

```ts
export type KubePermission =
  | {
      readonly apiGroup: ""
      readonly resource: "pods"
      readonly subresource?: never
      readonly verb: "create" | "get" | "delete"
    }
  | {
      readonly apiGroup: ""
      readonly resource: "pods"
      readonly subresource: "exec"
      readonly verb: "create" | "get"
    }
  | {
      readonly apiGroup: ""
      readonly resource: "persistentvolumeclaims"
      readonly subresource?: never
      readonly verb: "create" | "get" | "delete"
    }
  | {
      readonly apiGroup: "networking.k8s.io"
      readonly resource: "networkpolicies"
      readonly subresource?: never
      readonly verb: "create" | "get" | "list" | "update" | "delete"
    }

canI(namespace: string, permission: KubePermission): Promise<boolean>
```

These literal unions intentionally describe Dawn's actual Kubernetes API
surface rather than becoming a generic Kubernetes authorization wrapper. They
also make invalid combinations such as `delete pods/exec` or `list pods`
unrepresentable. The SelfSubjectAccessReview maps `apiGroup`, `resource`,
`subresource`, `verb`, and namespace without string-concatenating `pods/exec`.

### Required permissions

Preflight checks the operations used by the provider and its preflight:

| API group | Resource | Verbs |
| --- | --- | --- |
| core | pods | create, get, delete |
| core | persistentvolumeclaims | create, get, delete |
| core | pods/exec | create, get |
| networking.k8s.io | networkpolicies | create, get, list, update, delete |

All authorization reviews run before preflight returns, using settled results
so one failed review does not hide later denials. Missing permissions produce
one deterministic failure listing every missing `verb group/resource` entry.
Transport failures produce a Kubernetes-unreachable result, while an API
authorization/status failure to perform a review produces a distinct
authorization-review failure. Neither is mislabeled as a denied target
permission.

The NetworkPolicy-enforcement probe remains a warning. Listing NetworkPolicy
objects cannot prove that the CNI enforces them, and provider preflight must not
create disposable workloads merely to answer `dawn check`. The compatibility
harness performs the active network proof instead.

The chart's orchestrator Role is tested against the same permission declaration
to prevent implementation, preflight, and Helm RBAC from drifting apart.

### Existing NetworkPolicy update

NetworkPolicy acquisition keeps create-first behavior. When create returns
HTTP 409, the client gets the existing policy, confirms it is the expected
Dawn-owned object by exact name plus `app.kubernetes.io/managed-by=dawn` and
the expected `dawn.sh/thread` label, copies its live
`metadata.resourceVersion` into the desired body, and uses replace. A missing
resource version, ownership mismatch, or a second conflict is surfaced as an
error; the provider does not patch an unidentified object or retry
indefinitely.

This path is covered by both a client unit test and a live conformance case:
the suite creates a Dawn-owned per-thread policy with stale desired fields,
re-acquires that thread, and proves the same object is updated successfully.
The `get` and `update` verbs are therefore part of both preflight and chart
RBAC, not test-only privileges.

## Restricted Pod Security Default

`charts/dawn-sandbox-infra/values.yaml` changes:

```yaml
podSecurityStandard:
  enforce: restricted
  warn: restricted
  audit: restricted
  version: latest
```

Using `latest` intentionally applies the selected API server's restricted
policy. The endpoint matrix proves the candidate chart and generated workloads
against each supported server's policy before merge.

Dawn's default sandbox Pod and reaper already declare the restricted controls:

- non-root execution;
- `allowPrivilegeEscalation: false`;
- `capabilities.drop: ["ALL"]`;
- `seccompProfile.type: RuntimeDefault`; and
- only allowed PVC, ConfigMap, and `emptyDir` volume types.

The suite submits a deliberately noncompliant root-running Pod through the
orchestrator identity and requires admission rejection. This proves defense in
depth: RBAC permits Pod creation, but namespace admission rejects a workload
that bypasses Dawn's hardened manifest.

An operator who intentionally configures `runAsNonRoot: false` or another
incompatible image setting must explicitly set
`podSecurityStandard.enforce=baseline` (or another operator-selected policy).
There is no automatic downgrade or compatibility fallback.

## Focused Conformance Suite

### Setup and identity

The harness derives unique sandbox and application/management namespaces. It
creates the management namespace with the run label, then installs both Helm
releases into it. The infrastructure chart still creates the sandbox namespace,
so the suite exercises its default restricted labels; a new
`namespace.extraLabels` map carries the harness run label onto that namespace.
Helm release Secrets remain in the management namespace rather than the
sandbox namespace.

Immediately before each provider or RBAC phase, the harness obtains a fresh
short-lived token for the chart's orchestrator ServiceAccount and constructs a
temporary kubeconfig that contains only the selected cluster, one context, and
that token. Each token lifetime is approximately 15 minutes, and the
TokenRequest intentionally omits a custom audience so it uses the API server's
default audience. No token is reused across a long chart-upgrade phase.
Each token-backed phase has a 12-minute harness timeout, so it cannot continue
past the validity window of its 15-minute credential.

Provider integration tests run through this kubeconfig. Administrative probes
that require chart installation, quota setup, or reaper fixtures continue
through the caller's explicitly named kubecontext. RBAC negative probes do not
use admin impersonation: they execute with the same token-only kubeconfig as
the provider. The temporary directory is mode `0700`, the kubeconfig is mode
`0600`, and both are deleted before reports are written and are never printed
or uploaded.

After the infrastructure install and before issuing the orchestrator token, an
administrative probe requires the new sandbox namespace to contain zero Secret
objects. This confirms the harness is exercising the documented dedicated-
namespace boundary; Helm release state is in the management namespace.

The checked-in `test/k8s-compat/expected-tests.json` manifest names every
required Vitest test and harness probe by stable ID. Vitest emits JSON, and the
harness requires the observed IDs to match the expected set, every result to
pass, and skipped, pending, and todo counts all to be zero. A setup error,
filter mistake, empty suite, or renamed test therefore fails the compatibility
run.

### Live hardening assertions

The suite proves the generated Pod object and in-container behavior:

- Pod `runAsNonRoot`, non-zero UID/GID, `fsGroup`, and
  `fsGroupChangePolicy` are present;
- the container drops `ALL`, disallows privilege escalation, uses a read-only
  root filesystem, and declares RuntimeDefault seccomp;
- `/proc/self/status` reports an empty effective capability set,
  `NoNewPrivs: 1`, and seccomp filter mode;
- `/etc` is not writable;
- `/workspace`, `/tmp`, and `/run` are writable;
- the conventional Kubernetes service-account token path does not exist; and
- the Pod spec disables service-account token automount.

The suite also proves:

- deny-mode egress is blocked while DNS behaves as declared;
- the chart backstop selects Dawn-managed sandbox Pods;
- a workload that otherwise satisfies restricted Pod Security is rejected for
  exceeding the declared ResourceQuota, with a Kubernetes `Forbidden` status
  and quota-specific status details;
- LimitRange defaults are applied to a workload that omits resources;
- the real orchestrator token receives API authorization denials when directly
  reading Secrets, mutating RBAC, or operating outside the sandbox namespace;
  and
- a probe that satisfies every other restricted control but explicitly sets
  `runAsNonRoot: false` is rejected with a `Forbidden` Pod Security admission
  response that identifies the restricted `runAsNonRoot` violation.

Each RBAC-negative assertion requires HTTP 403 with Kubernetes status reason
`Forbidden`; 404, transport failure, or an admission rejection is not accepted
as evidence of authorization denial.

Every positive fixture Pod, including the network-control server/client,
LimitRange probe, reaper reference Pod, and Service reachability probe, uses a
digest-pinned compatible image and an explicit restricted-compliant security
context. The quota-negative Pod differs from a positive fixture only in its
quota request, and the Pod-Security-negative Pod differs only in
`runAsNonRoot`. This prevents either rejection test from passing because an
unrelated fixture defect reached admission first.

The Secrets assertion is deliberately narrow. Denying direct Secrets API reads
does not stop an identity with Pod-create permission from asking Kubernetes to
mount a known Secret into a Pod. The sandbox namespace must therefore be
dedicated to disposable sandbox infrastructure and contain no application
credentials. Documentation must state this boundary instead of claiming that
the orchestrator has categorically "no access" to namespace Secrets.

### Lifecycle and chart behavior

The focused lifecycle proof covers:

- create, exec, filesystem read/write, release, reattach, and destroy;
- PVC persistence across release and reattach;
- external keeper-Pod deletion followed by recreation over the same PVC;
- per-thread NetworkPolicy creation and cleanup;
- the one-off reaper fixture for stale, new, and referenced PVCs;
- installation of `dawn-app` with the existing lightweight placeholder image;
- Service reachability; and
- same-candidate upgrades of both charts, followed by critical health,
  security, reaper, and sandbox assertions.

The infrastructure chart is first installed with the default reaper schedule
`17 * * * *`, then upgraded from the same candidate chart with
`reaper.schedule=23 * * * *`. The suite requires Helm revision 2, verifies the
live CronJob schedule, and reruns the NetworkPolicy update, restricted
admission, provider lifecycle, and one-off reaper proofs.

The application chart is first installed with one replica, then upgraded from
the same candidate chart with `replicaCount=2`. The suite requires Helm
revision 2, Deployment desired and available replicas both equal to two, and
continued Service reachability through the digest-pinned probe image.

These upgrades prove repeatability and Kubernetes patch behavior for the
current candidate charts. They do not install or migrate from an older chart
version.

## Safety and Diagnostics

The harness fails before mutation when:

- a required executable is absent;
- the supplied context does not exactly match the current context;
- the API server minor does not match the declared target;
- the generated run namespace already exists;
- neither the requested storage class nor an annotated default storage class
  exists; or
- the caller lacks administrative setup permissions.

The administrative preflight is a checked-in structured declaration, not a
single representative `can-i`. It covers:

| Scope | Resources | Required operations |
| --- | --- | --- |
| cluster | Namespaces | create, get, list, update, patch, delete |
| cluster | StorageClasses | get, list |
| cluster | SelfSubjectAccessReviews | create |
| management namespace | Helm release Secrets | create, get, list, update, patch, delete |
| both namespaces | ServiceAccounts | create, get, list, update, patch, delete |
| sandbox namespace | `serviceaccounts/token` | create |
| sandbox namespace | Roles and RoleBindings | create, get, list, update, patch, delete |
| sandbox namespace | ConfigMaps, ResourceQuotas, LimitRanges, and PVCs | create, get, list, update, patch, delete |
| both namespaces | Services | create, get, list, update, patch, delete |
| both namespaces | Pods | create, get, list, watch, delete |
| management namespace | Deployments | create, get, list, watch, update, patch, delete |
| management namespace | ReplicaSets | get, list |
| sandbox namespace | CronJobs, Jobs, and NetworkPolicies | create, get, list, watch, update, patch, delete |
| management namespace | NetworkPolicies | get, list, watch, delete |
| sandbox namespace | `pods/exec` | create, get |
| both namespaces | `pods/log` | get |
| both namespaces | Events | get, list, watch |

The implementation records these as exact
apiGroup/resource/subresource/verb tuples and unit-tests the declaration against
the resources rendered by both charts and invoked by the harness. Permission
checks always name the generated namespace even before it exists. A failure
prints the complete sorted missing tuple set and does not install either chart.

All administrative `kubectl` calls include `--context`, and all Helm calls
include `--kube-context`. Child scripts receive the context as a required
argument and are statically audited against ambient invocations. The provider
uses the temporary token kubeconfig, whose only context points at the same API
server and CA data captured from the confirmed administrative context.

The harness verifies storage-class existence before mutation, then proves the
real provisioner after mutation by waiting for its lifecycle PVC to become
`Bound`. An existing class name alone is not accepted as dynamic-provisioning
evidence.

Both namespaces and every standalone probe resource carry the generated run
label. Chart resources remain confined to those owned namespaces and carry
their standard Helm release labels; Helm release records are additionally
bounded by exact generated release names. After each namespace is created, the
harness captures its Kubernetes UID. Before either Helm uninstall, cleanup gets
both namespaces and requires their original UID and run label. It then removes
the exact releases, re-reads each surviving Namespace, and issues a raw
Kubernetes DELETE with a v1 `DeleteOptions.preconditions.uid` equal to the
captured ownership UID. A mismatch or UID-precondition conflict stops
destructive cleanup and is reported rather than allowing Helm or kubectl to
delete a reused name.

Cleanup is registered for normal exit, test failure, `SIGINT`, `SIGTERM`, and
`SIGHUP`. It targets only internally generated namespace and release names and
refuses arbitrary caller-supplied cleanup targets. Explicit keep-on-failure is
honored only after ownership verification and never retains the token or its
temporary kubeconfig.

Failure artifacts include:

- target policy and observed server version;
- harness step results and durations;
- bounded Events, Pod descriptions, workload logs, and relevant object JSON;
- Helm status; and
- cleanup status.

Artifacts exclude Secrets, ServiceAccount tokens, temporary kubeconfigs, and
environment dumps. Human-readable output identifies the failed assertion and
the report path; the JSON report preserves stable step IDs for CI diagnosis.

## Documentation

Update:

- `charts/dawn-sandbox-infra/README.md`;
- `packages/sandbox/README.md`;
- `apps/web/content/docs/sandbox.mdx`;
- the contributor verification documentation; and
- generated CLI documentation derived from the website source.

The documentation states:

- Dawn runs the focused Kind/Calico suite against the policy-pinned patch
  release for each of Kubernetes 1.34, 1.35, and 1.36;
- this is not managed-cloud certification;
- `restricted` is the chart default;
- intentionally weaker workload settings require an explicit chart override;
- direct Secrets API reads are denied, but Pod-create permission means the
  dedicated sandbox namespace must not contain application credentials;
- custom `KubeClient` implementations must adopt
  `canI(namespace, permission)` and can import the exported `KubePermission`
  type;
- `pnpm verify:k8s:compat` requires an exact context and listed cluster
  prerequisites; and
- managed-cluster automation is a separate future design.

No documentation should imply that Kind proves every CNI, storage driver,
admission stack, or cloud distribution.

## Release Metadata

- Bump `dawn-sandbox-infra` from `0.1.2` to `0.1.3`.
- Add a patch changeset for `@dawn-ai/sandbox` describing complete preflight
  RBAC validation and the intentional public type break: positional
  `KubeClient.canI(namespace, verb, resource)` is replaced by
  `canI(namespace, permission)`, and `KubePermission` is exported for custom
  client implementations.
- Do not bump `dawn-app`; this project changes its test coverage, not its chart
  behavior.
- Do not add positional `canI` overloads, deprecation shims, or a baseline
  default compatibility path.

The repository's fixed package group remains patch-on-0.x. The chart version is
managed independently from Changesets, while chart `appVersion` continues to
follow the package release process.

## Verification

The implementation is complete when:

- unit tests cover compatibility policy parsing, path classification, harness
  context safety, exact admin and provider permission declarations, complete
  permission probing, deterministic errors, expected-test accounting, and
  report redaction;
- client unit and live tests prove the existing-NetworkPolicy get-plus-replace
  path carries the live resource version and rejects ownership mismatch;
- static tests prove every remote image and downloaded manifest input is
  immutable, Calico rewrites have exact cardinality, and workflow tool versions
  do not fall back to defaults;
- sandbox package build, typecheck, lint, and tests pass;
- both chart render suites, strict lint, and kubeconform pass with restricted
  defaults;
- the same portable focused suite passes on canonical Kubernetes 1.35;
- the canonical Kubernetes 1.35 full-application lane passes;
- the endpoint Kubernetes 1.34 and 1.36 focused lanes pass;
- every focused run reports the exact expected test/probe IDs with zero skips,
  pending tests, or todos;
- an unrelated pull-request fixture proves the aggregator no-op path;
- malformed diff, policy, and matrix-result fixtures prove the aggregator
  fails closed;
- nightly/manual workflow contracts are statically audited;
- the release workflow entrypoint and safe-executable inventories are updated;
- `pnpm ci:validate` passes; and
- `main` branch protection requires both `validate` and
  `kubernetes-compat` after the new context has reported successfully.

## Risks and Mitigations

### Required CI cost and flakiness

Two extra clusters make relevant pull requests slower. The matrix is limited to
Kubernetes-facing paths, uses immutable inputs, has bounded waits, uploads
focused diagnostics, and exposes one stable required check. Nightly execution
catches ecosystem drift even without a relevant pull request.

### Restricted-default compatibility

Images or explicit security opt-outs that relied on baseline admission can be
rejected. This is intentional. The chart is infrastructure for lower-trust
sandbox workloads, its generated workloads satisfy restricted admission, and
the operator retains an explicit baseline override.

### Kind is not a managed cluster

Kind with Calico does not exercise cloud IAM, managed CNIs, CSI drivers,
load-balancer controllers, or vendor admission policy. The harness boundary is
portable so those environments can be designed and tested later without
rewriting the conformance suite.

### External fixture drift

Tags, tool defaults, and remote files can change. Kind nodes, Calico
components, the reaper, workloads, and external probes use digests; the Calico
manifest is checksum-verified and rewritten before application; Kind, Helm,
and kubectl versions are explicit; and static tests keep all active lanes
aligned with the policy.

## Deferred Follow-up

After this work is stable, separately brainstorm managed-cluster execution:

- which of GKE, EKS, and AKS should be first;
- ephemeral versus persistent test clusters;
- identity and secret handling;
- cloud-specific CNI and storage assertions;
- cost and cleanup controls; and
- whether managed-cluster evidence should gate releases or remain scheduled.

That follow-up consumes the portable command defined here and does not change
its provider conformance contract.
