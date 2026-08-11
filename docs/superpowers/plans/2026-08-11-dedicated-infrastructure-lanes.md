# Dedicated Infrastructure Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development`. Use a fresh implementer for each
> task, then run spec-compliance review followed by code-quality review before
> starting the next task.

**Goal:** Fix the known Docker smoke ownership defect, then collect local,
secret-safe evidence for all six dedicated chart, Kubernetes, and Docker lanes
without adding a public runner or mutating hosted state.

**Architecture:** Task 1 makes the checked-in Docker assertion fail closed and
tests its process/resource lifecycle. Task 2 creates one ignored, run-local
TypeScript orchestrator under `artifacts/testing/dedicated-infrastructure/`.
That orchestrator owns all temporary state, bounded subprocesses, result
records, exact cleanup, and lane commands. Tasks 3-8 invoke one complete lane
each through the persisted orchestrator; they do not depend on inherited shell
functions or environment. Task 9 validates the evidence schema, runs the
repository Definition of Done, and removes the temporary tool directory.

**Canonical inputs:** `.github/kubernetes-compatibility.json`,
`.github/workflows/ci.yml`, `.github/workflows/kubernetes-compat.yml`,
`.github/kind/kind-calico.yaml`, `scripts/kubernetes-compat/**`, and
`test/k8s-smoke/**`.

**Runtime:** Node `v24.19.0` from
`/Users/blove/.nvm/versions/node/v24.19.0/bin`, pnpm `10.33.0`, temporary
Kind `v0.32.0`, temporary kubectl `v1.35.6`, and temporary Helm `v4.2.3`.

---

## Non-Negotiable Execution Contract

- Work from `/Users/blove/.codex/worktrees/b5f4/dawn` on
  `blove/kubernetes-compat-hardening`.
- Prepend the explicit Node 24 directory for every Node or pnpm command.
- Do not add a package script, checked-in infrastructure runner, workflow,
  workflow fixture, or public command.
- Do not push, open a pull request, dispatch a workflow, or mutate any hosted
  setting.
- Run the six first attempts sequentially in this order:

| Order | Lane ID | Hosted equivalent |
|---:|---|---|
| 1 | `chart-apply-1.35` | CI / `chart-apply-smoke` |
| 2 | `focused-1.35` | CI / `sandbox-k8s` |
| 3 | `focused-1.34` | Kubernetes Compatibility / `compat (1.34)` |
| 4 | `focused-1.36` | Kubernetes Compatibility / `compat (1.36)` |
| 5 | `kubernetes-e2e-1.35` | CI / `sandbox-k8s-e2e` |
| 6 | `docker-e2e` | CI / `sandbox-docker-e2e` |

- A Kubernetes-specific failure never blocks `docker-e2e`. A target-specific
  Kubernetes failure never blocks either endpoint target.
- One clean retry is allowed only for a demonstrated transient download,
  image-pull/load, Docker bootstrap, or cluster-setup failure. Never blindly
  retry a checksum, policy, chart, permission, provider, assertion, or cleanup
  failure.
- Every nonzero attempt captures bounded diagnostics before cleanup. Cleanup
  runs automatically on success, failure, SIGINT, and SIGTERM.
- First attempts never retain resources. A retained rerun is allowed only after
  first-pass evidence exists, only for a focused Kubernetes lane, and only with
  the exact `*-retain1` cluster recorded in state. Docker resources are never
  retained.
- Never delete by prefix. Prefix scans are read-only conflict/audit checks.
- On a Dawn behavior failure, stop the lane, use
  `superpowers:systematic-debugging`, add the narrowest TDD reproduction,
  commit only the proven fix, and rerun the affected/downstream lane.

Every Task 2-9 shell invocation begins with this state-recovery preamble. No
task may assume an exported variable or function survived a previous command:

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
export NODE24_BIN=/Users/blove/.nvm/versions/node/v24.19.0/bin
export PATH="$NODE24_BIN:$PATH"
RUN_ID="$(node -e 'const {readFileSync}=require("node:fs"); process.stdout.write(readFileSync("artifacts/testing/dedicated-infrastructure/active-run-id", "utf8").trim())')"
export RUN_ROOT="$PWD/artifacts/testing/dedicated-infrastructure/$RUN_ID"
test -f "$RUN_ROOT/state.json"
test -f "$RUN_ROOT/infra-runner.ts"
```

Task 2 Step 1 is the sole exception because it creates the active run. Task 2
Step 2 uses the same preamble but omits the final `infra-runner.ts` existence
check while creating that file. All later steps use it verbatim.

## Persisted Evidence Contract

Task 2 must define these narrow types in the ignored orchestrator:

```ts
type LaneId =
  | "chart-apply-1.35"
  | "focused-1.35"
  | "focused-1.34"
  | "focused-1.36"
  | "kubernetes-e2e-1.35"
  | "docker-e2e"

type LaneStatus = "passed" | "failed" | "blocked"
type FailureClass =
  | "none"
  | "bootstrap/environment"
  | "cluster-setup"
  | "dawn-behavior"
  | "cleanup"
type CleanupStatus = "passed" | "failed" | "not-run"
type AttemptId = "attempt0" | "retry1"

interface AttemptRecord {
  readonly id: AttemptId
  readonly resource: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly exitCode: number
  readonly classification: FailureClass
  readonly cleanup: Exclude<CleanupStatus, "not-run">
  readonly diagnostics: string | null
}

interface LaneResult {
  readonly lane: LaneId
  readonly status: LaneStatus
  readonly startedAt: string
  readonly finishedAt: string
  readonly exitCode: number | null
  readonly classification: FailureClass
  readonly resource: string
  readonly toolVersions: Readonly<Record<string, string>>
  readonly nativeArtifact: string | null
  readonly cleanup: CleanupStatus
  readonly retry: "none" | "retry1"
  readonly blockedBy?: string
  readonly hostedEquivalent?: string
  readonly attempts: readonly AttemptRecord[]
}
```

The orchestrator atomically rewrites `state.json`, `results.json`, and
`results.tsv` after every transition. It acquires
`$RUN_ROOT/orchestrator.lock` with exclusive creation and refuses concurrent
invocations. A top-level catch must always record a lane result before returning
nonzero.

Consistency rules:

- `passed`: exit `0`, class `none`, cleanup `passed`, one or two attempts.
- `failed`: nonzero exit or failed cleanup, non-`none` class, no blocked fields.
- `blocked`: null exit, `bootstrap/environment`, cleanup `not-run`, no
  attempts, and nonempty `blockedBy` plus `hostedEquivalent`.
- `retry1`: exactly two attempts named `attempt0` and `retry1`; the first
  classification is retry-eligible; the second resource uses the exact
  `-retry1` suffix.
- All timestamps are UTC ISO strings and `finishedAt >= startedAt`.
- Kubernetes resource names match the run token and lane; Docker uses
  `docker-daemon`.

---

### Task 1: Harden Docker Smoke Ownership Under Deterministic TDD

**Files:**
- Create: `test/k8s-compat/assert-docker-smoke.test.ts`
- Modify: `test/k8s-smoke/assert-docker.sh`

- [ ] **Step 1: Add the failing fake-daemon lifecycle tests**

Build one fake-command harness in the test file. It must run the real shell
script with fake `docker`, `curl`, `jq`, and `sleep` executables and a
JSON state file. Model containers and networks as `name -> object ID`; model
sandbox labels, container user/rootfs/hostname, and named volumes explicitly.
Record every fake command in a JSONL transcript.

Use asynchronous `spawn("sh", [script], { detached: true })`, not
`spawnSync`. Give every run a ten-second watchdog that sends `SIGKILL` to
the process group and fails the test if the script hangs. For the signal case,
the fake `curl` writes a `run-wait-entered` marker and remains alive. The
test waits for that marker, sends `SIGTERM` to the whole process group with
`process.kill(-child.pid!, "SIGTERM")`, and asserts:

- the top-level shell exits with code `143` and no Node-level signal;
- diagnostics include `signal=TERM`;
- the first diagnostic command precedes every destructive command; and
- only IDs/names owned by this run are removed.

Cover these scenarios:

1. occupied app, mock, network, sandbox-prefix container, and sandbox-prefix
   volume: fail before mutation and issue no destructive command;
2. success: derive `dawn-sbx-thread_123` and
   `dawn-sbx-vol-thread_123`, verify labels/identity, and remove fixed
   resources only after the Agent Protocol delete removes the sandbox pair;
3. run failure and SIGTERM: bounded diagnostics precede exact cleanup;
4. unexpected concurrent sandbox-prefix resource: fail without deleting it;
5. invalid thread label or identity label: adopt neither sandbox object;
6. volume not observed after the request began: never claim the volume;
7. same-name replacement for app, mock, network, and sandbox container:
   revalidation detects the changed object ID and never deletes the replacement;
8. post-adoption sandbox ID/label change: invalidate both sandbox claims and
   delete neither the container nor its unlabelled volume.

The fake must support these identity reads exactly:

```text
docker inspect --format {{.Id}} NAME
docker network inspect --format {{.Id}} NAME
docker inspect --format {{ index .Config.Labels "dawn.sandbox" }} NAME
docker inspect --format {{ index .Config.Labels "dawn.sandbox.identity" }} NAME
```

- [ ] **Step 2: Preserve RED evidence**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts \
  assert-docker-smoke
```

Expected RED: the current script performs prefix-wide cleanup, starts by
deleting occupied resources, and lacks diagnostics-first top-level signal
handling and object-ID ownership.

- [ ] **Step 3: Implement exact, identity-aware ownership**

In `assert-docker.sh`:

- require `docker`, `curl`, `jq`, `awk`, `grep`, `sed`, and `tr`;
- install separate `HUP`, `INT`, `TERM`, and `EXIT` traps;
- make signal traps set `SIGNAL_NAME` and exit `129`, `130`, or `143`;
- make the EXIT trap preserve the original status unless validation/cleanup
  itself fails;
- reject occupied exact app/mock/network names and any existing
  `dawn-sbx-*` container or `dawn-sbx-vol-*` volume before mutation;
- record the app, mock, and network object IDs immediately after successful
  creation;
- sanitize the returned thread ID with the provider-compatible expression
  `sed 's/[^a-zA-Z0-9_.-]/_/g'`;
- preflight the exact thread-derived sandbox container/volume before the run;
- after `/runs/wait`, record the sandbox container ID and require
  `dawn.sandbox=$SANITIZED_TID` plus a 64-lowercase-hex
  `dawn.sandbox.identity`;
- claim the unlabelled volume only when it was absent at preflight and observed
  after this run request began;
- before diagnostics/cleanup, re-read every owned object ID. A changed fixed
  object is a cleanup failure and is skipped. A changed sandbox ID or either
  changed label invalidates both sandbox claims;
- capture bounded app/mock logs, exact sandbox inspect data, and at most 50
  read-only prefix namespace entries on every nonzero exit;
- after diagnostics, delete containers and the network by their recorded
  object IDs, not by names. Delete the exact sandbox volume name only while its
  sandbox ownership claim remains valid;
- after `DELETE /threads/{id}`, poll only the exact sandbox names. Clear claims
  only after exact absence is observed; and
- retain all existing non-root, read-only-rootfs, hostname, and genuine
  `runBash` result assertions.

No destructive target may be derived from a prefix scan.

- [ ] **Step 4: Run GREEN and static verification**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts \
  assert-docker-smoke
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsc -p test/k8s-compat/tsconfig.json --noEmit
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec biome check --config-path packages/config-biome/biome.json \
  test/k8s-compat/assert-docker-smoke.test.ts
sh -n test/k8s-smoke/assert-docker.sh
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add test/k8s-compat/assert-docker-smoke.test.ts test/k8s-smoke/assert-docker.sh
git commit -m "fix(testing): isolate Docker smoke cleanup"
```

Do not change the hosted workflow cleanup in this task. The local lane never
executes that broad hosted teardown block.

### Task 2: Bootstrap A Safe Run-Local Orchestrator

**Files:**
- Create ignored:
  `artifacts/testing/dedicated-infrastructure/$RUN_ID/infra-runner.ts`
- Create ignored:
  `artifacts/testing/dedicated-infrastructure/$RUN_ID/infra-runner.test.ts`
- Create ignored:
  `artifacts/testing/dedicated-infrastructure/$RUN_ID/state.json`
- Create outside repository: a private temporary
  `dawn-infra-tools-*` directory
- Read only: canonical policy/workflow/harness files listed above

- [ ] **Step 1: Create the run root before Kubernetes bootstrap**

Use Node 24 and a Node stdlib bootstrap (not `rm -rf` or a shell heredoc) to:

1. verify the branch and repository root;
2. generate `RUN_ID=<UTC basic timestamp>-<8 hex>` and `RUN_TOKEN=<8 hex>`;
3. create `RUN_ROOT` mode `0700`;
4. create `TOOL_ROOT` with
   `mkdtemp(join(tmpdir(), "dawn-infra-tools-"))`;
5. write a random ownership nonce and
   `$TOOL_ROOT/.dawn-infra-owner.json` containing the run ID, nonce, repo root,
   and canonical tool-root path;
6. atomically write the initial state; and
7. atomically write
   `artifacts/testing/dedicated-infrastructure/active-run-id`.

This minimal state creation must succeed before any Kubernetes download. Verify
both artifact paths are ignored with `git check-ignore`.

- [ ] **Step 2: Implement the ignored orchestrator and its local tests**

The CLI is:

```text
pnpm exec tsx infra-runner.ts bootstrap
pnpm exec tsx infra-runner.ts run <LaneId>
pnpm exec tsx infra-runner.ts status [LaneId]
pnpm exec tsx infra-runner.ts validate
pnpm exec tsx infra-runner.ts cleanup
pnpm exec tsx infra-runner.ts rerun-retained <focused LaneId>
```

Implement with Node stdlib plus repository-installed packages only. Do not
construct shell command strings. Spawn executable plus argv arrays from the
repo root with the explicit Node 24 and temporary tool directories in `PATH`.
Tee stdout/stderr into the lane's bounded `run.log`; never print environment
contents or credentials.

Required primitives:

- `runCommand`: process-group spawn, explicit timeout, graceful TERM then KILL,
  exit/signal capture, and optional stdout capture;
- `withLock`: exclusive `orchestrator.lock`, stale-lock refusal rather than
  deletion;
- `readState` / `writeState`: runtime validation and atomic temp-file rename;
- `listKindClusters`: requires `kind get clusters` exit zero. Query failure is
  not absence;
- `createOwnedCluster`: records successful preflight absence, invokes Kind,
  re-lists, and claims only the exact newly observed name, including a partial
  create failure;
- `cleanupOwnedCluster`: exact-name delete with a three-minute timeout and a
  successful post-delete listing proving absence;
- `captureKubernetesDiagnostics`: each command capped at 30 seconds; nodes,
  all-namespace Pods, 200 warning events, storage classes, Calico status,
  Helm releases, app/aimock/sandbox resources and logs, and 200 control-plane
  log lines. Include the default namespace deployment/service/logs for
  `chart-apply-1.35`;
- `runAttempt`: catches errors/signals, classifies, diagnoses, stops registry,
  removes workload resources, deletes the exact cluster, records the attempt,
  and returns only after state is persisted;
- `recordBlocked`: creates a valid blocked result without an attempt;
- `maybeRetry`: permits only one `retry1` for an explicitly
  retry-eligible first classification and uses a new `-retry1` resource; and
- `safeRemoveToolRoot`: requires canonical path equality with state, the
  expected temporary basename prefix, parent equal to `realpath(tmpdir())`,
  and an exact owner-marker match before `fs.rm({recursive:true})`.

SIGINT/SIGTERM handlers abort the active child process group and enter the same
diagnostics/cleanup/result path. Every registry wait is capped at 180 seconds;
registry shutdown is capped at ten seconds. Downloads are capped at two minutes,
Kind create at six minutes, image build/pull/load at twenty minutes,
kubectl/Helm at five minutes, and cluster cleanup at three minutes.

The ignored tests use fake executables and temporary state to prove:

- a failed Kind listing cannot establish absence or ownership;
- a partial create is cleaned only when exact post-create observation proves
  ownership;
- blocked results do not parse an attempts header;
- attempt variables survive because state, not a subshell, owns them;
- one eligible retry creates exactly two attempts with `-retry1`;
- ineligible classes never retry;
- diagnostics precede cleanup after nonzero exit and TERM;
- a Kubernetes bootstrap block still allows `docker-e2e`;
- foreign Docker prefix resources classify as
  `bootstrap/environment`, not `cleanup`; and
- tool-root cleanup rejects a forged path or owner marker.

Run:

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsx --test "$RUN_ROOT/infra-runner.test.ts"
```

- [ ] **Step 3: Bootstrap shared and Kubernetes-specific prerequisites**

`bootstrap` first records Node, pnpm, OS/architecture, Docker client/server,
`curl`, `jq`, and Git. It requires Node `v24.19.0`, pnpm `10.33.0`, a
reachable Docker daemon, `Darwin arm64` for Kubernetes lanes, and a frozen
workspace install.

Then download into `TOOL_ROOT`, with HTTPS-only redirects and upstream
checksums:

- Kind from
  `https://github.com/kubernetes-sigs/kind/releases/download/v0.32.0/kind-darwin-arm64`
  and its `.sha256sum`, expected SHA-256
  `dca67911095a110c2b5c36e26df6cac860c602033e456c0db47be498cdef1ebb`;
- kubectl from
  `https://dl.k8s.io/release/v1.35.6/bin/darwin/arm64/kubectl` and
  `kubectl.sha256`, expected SHA-256
  `1827b555615791c1c1065dd64870eb49a4e00e9dfd389a82a2ef1d31bb46d200`;
- Helm from `https://get.helm.sh/helm-v4.2.3-darwin-arm64.tar.gz`, verified
  against its adjacent official `.sha256sum`.

Require exact executable paths and versions after extraction. Use guarded
`fs.rm` only for the extracted Helm child directory.

Record baseline Kind clusters, exact fixed smoke containers/network, all
sandbox-prefix names, sandbox volumes, and these image tags:
`dawn-smoke-app:k8s`, `dawn-smoke-app:docker`,
`dawn-smoke-aimock:latest`. Bootstrap records but does not alter or globally
reject Docker smoke resources: chart/focused Kubernetes lanes do not own that
namespace. Each packaged E2E lane performs its own fail-closed image preflight;
the Docker E2E lane additionally requires the fixed app/mock/network and both
sandbox namespaces to be empty. Never overwrite a pre-existing fixed tag.

If Kubernetes bootstrap fails, persist the reason as a shared Kubernetes
prerequisite. The five Kubernetes `run` commands must still produce blocked
rows with their hosted equivalents. Docker preflight remains independently
usable.

- [ ] **Step 4: Encode the six canonical lane bodies**

Use this exact configuration table:

| Lane | Node image | Cluster suffix | Kind config |
|---|---|---|---|
| `chart-apply-1.35` | policy target 1.35 | `chart-135` | default |
| `focused-1.35` | policy target 1.35 | `focused-135` | `.github/kind/kind-calico.yaml` |
| `focused-1.34` | policy target 1.34 | `focused-134` | `.github/kind/kind-calico.yaml` |
| `focused-1.36` | policy target 1.36 | `focused-136` | `.github/kind/kind-calico.yaml` |
| `kubernetes-e2e-1.35` | policy target 1.35 | `e2e-135` | `.github/kind/kind-calico.yaml` |

First attempt cluster names are
`dawn-local-$RUN_TOKEN-<suffix>`; retry names append `-retry1`.

Canonical lane commands are fixed in Tasks 3-8 below. The runner may
parameterize only exact cluster/context names, temporary paths, and environment.
It may not change assertions, policy pins, manifests, timeouts, or provider
behavior.

- [ ] **Step 5: Verify bootstrap without starting a lane**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsx "$RUN_ROOT/infra-runner.ts" bootstrap
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsx "$RUN_ROOT/infra-runner.ts" status
git status --short
```

Expected: tool versions/checksums and baselines are persisted, no cluster exists,
no fixed image was overwritten, ignored files do not appear in Git status, and
the repository has no new tracked change. No commit.

### Task 3: Run Chart Apply Smoke On Kubernetes 1.35

- [ ] **Step 1: Invoke the complete lane**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsx "$RUN_ROOT/infra-runner.ts" run chart-apply-1.35
```

The encoded body must:

1. create the unique default-CNI Kind cluster with the policy 1.35 image;
2. split `images.placeholderApp` into repository and digest and validate both
   it and `images.reachabilityProbe` as digest-pinned;
3. run the CI `helm install dawn-app charts/dawn-app` values exactly:
   placeholder repository/digest, port `8080`, health path `/`, service
   account creation/name, `--wait --timeout 3m`;
4. wait for `deploy/dawn-app` for 120 seconds; and
5. run the pinned reachability image and curl
   `http://dawn-app.default.svc.cluster.local/`.

Diagnostics include the default namespace. Cleanup uninstalls the exact release
then deletes the exact cluster. Verify the result row and exact cluster absence.
No commit.

### Task 4: Run Focused Compatibility On Kubernetes 1.35

- [ ] **Step 1: Invoke the complete lane**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsx "$RUN_ROOT/infra-runner.ts" run focused-1.35
```

The encoded body must run, in order:

1. `DAWN_REQUIRE_HELM=1 pnpm exec vitest --run --config
   test/k8s-compat/vitest.config.ts chart-rbac`;
2. unique no-CNI Kind creation with the policy 1.35 image;
3. `pnpm exec tsx scripts/kubernetes-compat/workflow.ts prepare-calico
   --output <tool-root exact file>`;
4. Calico apply, daemonset rollout, and all-node readiness with the checked-in
   180-second timeouts; and
5. `pnpm verify:k8s:compat -- --target 1.35 --context <exact context>`.

Record the native report path under
`artifacts/testing/kubernetes-compat/**`, then clean the exact cluster. No
commit.

### Task 5: Run Focused Compatibility On Kubernetes 1.34

- [ ] **Step 1: Invoke the complete lane**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsx "$RUN_ROOT/infra-runner.ts" run focused-1.34
```

Use the policy 1.34 image and target `1.34`; otherwise execute the same
chart-RBAC, verified Calico, readiness, harness, diagnostics, and exact cleanup
sequence as Task 4. This lane runs even if 1.35 failed unless a separately
confirmed shared prerequisite blocks both. No commit.

### Task 6: Run Focused Compatibility On Kubernetes 1.36

- [ ] **Step 1: Invoke the complete lane**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsx "$RUN_ROOT/infra-runner.ts" run focused-1.36
```

Use the policy 1.36 image and target `1.36`; otherwise execute the same
sequence as Task 4. This lane runs independently of target-specific 1.34/1.35
failures. No commit.

### Task 7: Run Packaged Kubernetes E2E On Kubernetes 1.35

- [ ] **Step 1: Invoke the complete lane**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsx "$RUN_ROOT/infra-runner.ts" run kubernetes-e2e-1.35
```

The encoded body must:

1. refuse existing `dawn-smoke-app:k8s` or
   `dawn-smoke-aimock:latest` tags;
2. run `pnpm build` and the exact chart-RBAC test;
3. create the unique policy 1.35 no-CNI cluster and install verified Calico;
4. pull the policy `sandboxWorkload` digest and load it into the exact cluster;
5. start `test/k8s-smoke/serve-registry.ts` with a tool-root URL file, wait at
   most 180 seconds, and guarantee bounded process shutdown;
6. run `sh test/k8s-smoke/build-image.sh k8s <registry-url>`, stop the
   registry, and load `dawn-smoke-app:k8s`;
7. build/load `dawn-smoke-aimock:latest`;
8. create `dawn-app`, install `dawn-sandbox-infra` with
   `values-sandbox-infra.yaml`, deploy/wait for aimock, and install
   `dawn-app` with `values-dawn-app.yaml`;
9. run `DAWN_TEST_SMOKE_E2E=1 DAWN_TEST_K8S_CONTEXT=<context>
   sh test/k8s-smoke/assert-k8s.sh`; and
10. diagnose before uninstalling exact releases/namespaces and deleting the
    exact cluster.

Track the two image IDs immediately after build. At cleanup, require each fixed
tag still resolve to the recorded ID before removing that tag. A changed tag is
a cleanup failure and is not removed. Verify both tags are absent afterward.
No commit.

### Task 8: Run Packaged Docker E2E Independently

- [ ] **Step 1: Invoke the complete lane even after Kubernetes-only failures**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsx "$RUN_ROOT/infra-runner.ts" run docker-e2e
```

The encoded body must:

1. independently verify Node, pnpm, Docker, `curl`, and `jq`;
2. refuse existing fixed app/mock/network names, any sandbox-prefix container
   or volume, and existing `dawn-smoke-app:docker` /
   `dawn-smoke-aimock:latest` image tags;
3. run `pnpm build` and pull the policy sandbox workload image;
4. start the bounded registry, run
   `sh test/k8s-smoke/build-image.sh docker <registry-url>`, build aimock, and
   stop the registry;
5. run only the hardened `sh test/k8s-smoke/assert-docker.sh`; and
6. perform read-only absence audits for exact fixed resources and both sandbox
   namespaces.

The outer runner owns only registry/image lifecycle. The hardened assertion
owns app/mock/network/sandbox lifecycle. A foreign or concurrent prefix object
is `bootstrap/environment`, never `cleanup`, and is never removed.

Track/revalidate image IDs exactly as in Task 7. Do not execute or copy the
hosted workflow's broad `Diagnostics + cleanup` loops. No commit.

### Task 9: Validate Evidence, Verify The Repository, And Clean Tools

- [ ] **Step 1: Re-run focused checks**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts \
  assert-docker-smoke
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsc -p test/k8s-compat/tsconfig.json --noEmit
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec biome check --config-path packages/config-biome/biome.json \
  test/k8s-compat/assert-docker-smoke.test.ts
sh -n test/k8s-smoke/assert-docker.sh
```

Also rerun every RED/GREEN command added for an evidence-proven live defect and
its affected live lane.

- [ ] **Step 2: Validate the complete evidence schema**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsx "$RUN_ROOT/infra-runner.ts" validate
```

`validate` must require:

- exactly six distinct rows in the fixed order;
- only the declared enum values;
- all status/classification/cleanup/blocked-field invariants in the Persisted
  Evidence Contract;
- parseable ordered timestamps and nonempty tool versions/resources;
- attempt count, IDs, retry eligibility, and retry resource naming;
- an existing native artifact for each attempted focused lane;
- a named prerequisite and exact hosted equivalent for every blocked row;
- exact absence of every run-owned cluster, fixed smoke object, registry
  process, and fixed image tag;
- sandbox container/volume namespace sets equal to the captured baseline (and
  empty for any successfully attempted Docker lane);
- unchanged baseline Kind clusters; and
- no unrecorded retained cluster.

Local ARM64 failures must explicitly state the hosted Ubuntu AMD64 equivalent
still required. Local success never substitutes for hosted evidence.

- [ ] **Step 3: Run the repository Definition of Done**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm ci:validate
git diff --check
git status --short
```

- [ ] **Step 4: Perform guarded final cleanup**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsx "$RUN_ROOT/infra-runner.ts" cleanup
```

`cleanup` re-runs the exact absence/baseline audit, validates canonical
`TOOL_ROOT` plus its owner marker, and removes only that tool root through
`fs.rm`. It leaves ignored evidence under `RUN_ROOT`. It refuses to finish
while an owned or retained cluster/resource remains.

- [ ] **Step 5: Final review**

Run a fresh final code reviewer across every tracked commit since
`267766b8`, inspect `results.json`, and report:

- each lane status and hosted equivalent;
- retries and classifications;
- local platform limitations;
- exact cleanup result;
- commits created for proven defects; and
- full verification result.

Do not push or open a pull request.
