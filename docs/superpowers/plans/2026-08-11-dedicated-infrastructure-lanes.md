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
export RUN_ROOT="$(node -e 'const {readFileSync}=require("node:fs"); const active=JSON.parse(readFileSync("artifacts/testing/dedicated-infrastructure/active-run.json", "utf8")); process.stdout.write(active.runRoot)')"
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

interface CommandRecord {
  readonly stage: string
  readonly executable: string
  readonly args: readonly string[]
  readonly startedAt: string
  readonly finishedAt: string
  readonly exitCode: number
  readonly timedOut: boolean
}

interface AttemptRecord {
  readonly id: AttemptId
  readonly resource: string
  readonly context: string | null
  readonly startedAt: string
  readonly finishedAt: string
  readonly exitCode: number
  readonly classification: FailureClass
  readonly cleanup: Exclude<CleanupStatus, "not-run">
  readonly diagnostics: string | null
  readonly diagnosticsSha256: string | null
  readonly nativeArtifact: string | null
  readonly nativeArtifactSha256: string | null
  readonly retryEligible: boolean
  readonly retryReason: string | null
  readonly commands: readonly CommandRecord[]
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

interface RetainedRecord {
  readonly lane: "focused-1.35" | "focused-1.34" | "focused-1.36"
  readonly resource: string
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly status: "running" | "failed" | "cleaned"
  readonly diagnostics: string | null
  readonly cleanup: CleanupStatus
}

interface RunState {
  readonly schemaVersion: 1
  readonly runId: string
  readonly runToken: string
  readonly ownerNonce: string
  readonly repoRoot: string
  readonly runRoot: string
  readonly toolRoot: string
  readonly kubeconfig: string
  readonly createdAt: string
  readonly finalizedAt: string | null
  readonly policySha256: string
  readonly tools: Readonly<Record<string, {
    readonly version: string
    readonly path: string
    readonly sha256: string | null
  }>>
  readonly kubernetesBootstrap: {
    readonly status: "pending" | "ready" | "failed"
    readonly reason: string | null
  }
  readonly baseline: {
    readonly kindClusters: readonly string[]
    readonly fixedContainers: Readonly<Record<string, string>>
    readonly fixedNetworks: Readonly<Record<string, string>>
    readonly sandboxContainers: Readonly<Record<string, string>>
    readonly sandboxVolumes: readonly string[]
    readonly fixedImages: Readonly<Record<string, string>>
  }
  readonly ownedClusters: readonly string[]
  readonly ownedImages: Readonly<Record<string, string>>
  readonly activeRegistryPid: number | null
  readonly results: readonly LaneResult[]
  readonly retained: readonly RetainedRecord[]
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
  attempt records `retryEligible=true` and a nonempty reason. Kubernetes's
  second resource uses the exact `-retry1` suffix. Docker remains
  `docker-daemon` because it has no disposable resource name.
- All timestamps are UTC ISO strings and `finishedAt >= startedAt`.
- Kubernetes resource names match the run token and lane; Docker uses
  `docker-daemon`.

`results.tsv` has this exact header and one escaped, single-line field per
column (tabs/newlines in free text become spaces):

```text
lane\tstatus\tstarted_at\tfinished_at\texit_code\tclassification\tresource\ttool_versions\tnative_artifact\tcleanup\tretry\tblocked_by\thosted_equivalent
```

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
   delete neither the container nor its unlabelled volume; and
9. a hanging diagnostic command and a hanging cleanup command: the watchdog
   terminates each bounded command, the script itself exits within ten seconds,
   diagnostic timeout still precedes cleanup, and cleanup timeout is reported
   as failure rather than hanging.

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
- add `run_bounded`, implemented with POSIX background processes: start the
  requested command, start a watchdog that sleeps
  `SMOKE_COMMAND_TIMEOUT_SECONDS` (default `30`), sends TERM, waits
  `SMOKE_COMMAND_KILL_GRACE_SECONDS` (default `2`), then sends KILL; wait for
  the command while capturing its status; stop/reap the watchdog; and return
  the command status. Do not depend on GNU `timeout`;
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
- route every Docker inspect/log/removal used by ownership validation,
  diagnostics, or cleanup through `run_bounded`. A timeout skips that target,
  marks cleanup failed when applicable, and cannot suppress the original
  diagnostic output;
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

1. verify the branch and canonical repository root;
2. acquire the repository-global ignored
   `artifacts/testing/dedicated-infrastructure/active-run.json` lease with
   `open(path, "wx", 0o600)`. If it already exists, refuse to overwrite it.
   A new run is allowed only after the referenced prior state says
   `finalizedAt != null`, its tool root is absent, its baseline/resource audit
   passes, and the prior lease has been explicitly removed by that run's
   `cleanup` command;
3. generate `RUN_ID=<UTC basic timestamp>-<8 hex>` and `RUN_TOKEN=<8 hex>`;
4. create `RUN_ROOT` mode `0700`;
5. create `TOOL_ROOT` with
   `mkdtemp(join(tmpdir(), "dawn-infra-tools-"))`;
6. reserve `KUBECONFIG=$TOOL_ROOT/kubeconfig`, create it mode `0600`, and put
   this exact path in the environment of every Kind, kubectl, Helm, and focused
   harness child. Never inherit or merge the user's kubeconfig;
7. write a random ownership nonce and
   `$TOOL_ROOT/.dawn-infra-owner.json` containing the run ID, nonce, repo root,
   canonical tool-root path, and kubeconfig path;
8. atomically write the initial `RunState`; and
9. finish the active lease document with run ID, nonce, run root, tool root,
   state path, and creation time. A failure between lease creation and state
   initialization leaves a fail-closed lease for manual inspection; it is never
   silently replaced.

This minimal state creation must succeed before any Kubernetes download. Verify
the lease, run root, state, and runner paths are ignored with
`git check-ignore`.

- [ ] **Step 2: Implement the ignored orchestrator and its local tests**

The CLI is:

```text
pnpm exec tsx infra-runner.ts bootstrap
pnpm exec tsx infra-runner.ts run <LaneId>
pnpm exec tsx infra-runner.ts status [LaneId]
pnpm exec tsx infra-runner.ts validate
pnpm exec tsx infra-runner.ts cleanup
pnpm exec tsx infra-runner.ts rerun-retained <focused LaneId>
pnpm exec tsx infra-runner.ts cleanup-retained <focused LaneId>
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

`rerun-retained` is legal only after that focused lane has a first-pass failed
result. It creates one new exact `*-retain1` cluster, stores a `RetainedRecord`,
and passes `--keep-on-failure` to the focused harness. It never changes the six
first-pass result rows. `cleanup-retained` diagnoses and deletes that exact
cluster, proves absence with a successful Kind listing, and changes the record
to `cleaned`. Final validation rejects `running` or uncleaned retained records.

SIGINT/SIGTERM handlers abort the active child process group and enter the same
diagnostics/cleanup/result path. Every registry wait is capped at 180 seconds;
registry shutdown is capped at ten seconds. Downloads are capped at two minutes,
Kind create at six minutes, image build/pull/load at twenty minutes,
kubectl/Helm at five minutes, and cluster cleanup at three minutes.

Use this command policy exactly. `args` are argv elements, not a shell string;
`<...>` values come only from validated policy/state fields. `eligible` means a
retry is allowed only when the captured stderr/exit proves the named transient
condition, never merely because the row says `yes`.

| Stage | executable and args | outer timeout | failure class | retry eligible |
|---|---|---:|---|---|
| frozen install | `pnpm install --frozen-lockfile` | 20m | `bootstrap/environment` | no |
| tool download | `curl --fail --show-error --silent --location --max-redirs 5 --proto =https --proto-redir =https <url> --output <owned-path>` | 2m | `bootstrap/environment` | transport/5xx only |
| chart RBAC | `pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts chart-rbac` | 5m | `dawn-behavior` | no |
| Kind create | `kind create cluster --name <cluster> --image <digest-image> [--config .github/kind/kind-calico.yaml] --wait 180s` | 6m | `cluster-setup` | transient create/pull only |
| Calico prepare | `pnpm exec tsx scripts/kubernetes-compat/workflow.ts prepare-calico --output <owned-manifest>` | 2m | checksum=`bootstrap/environment`; transport=`cluster-setup` | transport only |
| Calico apply | `kubectl --context <context> apply --filename <owned-manifest>` | 5m | `cluster-setup` | transient API only |
| Calico ready | `kubectl --context <context> -n kube-system rollout status daemonset/calico-node --timeout=180s`, then `kubectl --context <context> wait --for=condition=Ready nodes --all --timeout=180s` | 5m each | `cluster-setup` | transient readiness only |
| focused harness | `pnpm verify:k8s:compat -- --target <minor> --context <context>` | 35m | `dawn-behavior` | no |
| workspace build | `pnpm build` | 20m | `bootstrap/environment` | no |
| image pull | `docker pull <digest-image>` | 20m | `bootstrap/environment` | registry transport only |
| Kind image load | `kind load docker-image <image> --name <cluster>` | 20m | `cluster-setup` | transient load only |
| registry | `pnpm exec tsx test/k8s-smoke/serve-registry.ts <owned-url-file>` | ready 3m; stop 10s | `bootstrap/environment` | startup transport only |
| app image build | `sh test/k8s-smoke/build-image.sh <k8s-or-docker> <registry-url>` | 25m | `bootstrap/environment` | external pull/download only |
| aimock build | `docker build --tag dawn-smoke-aimock:latest --file test/k8s-smoke/aimock/Dockerfile test/k8s-smoke` | 20m | `bootstrap/environment` | external pull only |
| Helm install/uninstall | exact argv in Tasks 3 and 7 | 6m install; 3m uninstall | install=`dawn-behavior`; uninstall=`cleanup` | no |
| Kubernetes assertion | `sh test/k8s-smoke/assert-k8s.sh` | 10m | `dawn-behavior` | no |
| Docker assertion | `sh test/k8s-smoke/assert-docker.sh` | 10m | `dawn-behavior` | no |
| diagnostic command | exact read-only command | 30s each | preserve primary class | no |
| Kind delete | `kind delete cluster --name <owned-cluster>` | 3m | `cleanup` | no |

Every child gets `cwd=repoRoot`, the explicit Node/tool `PATH`, and the isolated
`KUBECONFIG`. Lane-specific environment is an allowlisted overlay:

- focused: `DAWN_REQUIRE_HELM=1` only for chart-RBAC, then
  `DAWN_TEST_K8S_CONTEXT=<context>` and `DAWN_K8S_TARGET=<minor>`;
- Kubernetes E2E: `DAWN_TEST_SMOKE_E2E=1`, `KIND_CLUSTER=<cluster>`, and
  `DAWN_TEST_K8S_CONTEXT=<context>`; and
- Docker E2E: `DAWN_TEST_SMOKE_E2E=1`.

The runner reads every image/version from the parsed policy and checks the
policy file's SHA-256 against `RunState.policySha256` before each lane. It does
not accept caller overrides for pins, timeouts, cluster names, contexts, or
cleanup targets.

The ignored tests use fake executables and temporary state to prove:

- an existing global active-run lease prevents creation of a second run;
- every Kubernetes child receives only the run-owned `KUBECONFIG`;
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
- a failed fixed-tag build is inspected in `finally`, adopted by exact image ID,
  and removed only if that ID still owns the tag; and
- tool-root cleanup rejects a forged path or owner marker.

Run:

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
export RUN_ROOT="$(node -e 'const {readFileSync}=require("node:fs"); const active=JSON.parse(readFileSync("artifacts/testing/dedicated-infrastructure/active-run.json","utf8")); process.stdout.write(active.runRoot)')"
test -f "$RUN_ROOT/state.json"
test -f "$RUN_ROOT/infra-runner.ts"
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
cd /Users/blove/.codex/worktrees/b5f4/dawn
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
export RUN_ROOT="$(node -e 'const {readFileSync}=require("node:fs"); const active=JSON.parse(readFileSync("artifacts/testing/dedicated-infrastructure/active-run.json","utf8")); process.stdout.write(active.runRoot)')"
test -f "$RUN_ROOT/state.json"
test -f "$RUN_ROOT/infra-runner.ts"
pnpm exec tsx "$RUN_ROOT/infra-runner.ts" bootstrap
pnpm exec tsx "$RUN_ROOT/infra-runner.ts" status
git status --short
```

Expected: tool versions/checksums and baselines are persisted, no cluster exists,
no fixed image was overwritten, ignored files do not appear in Git status, and
the repository has no new tracked change. No commit.

### Task 3: Run Chart Apply Smoke On Kubernetes 1.35

- [ ] **Step 1: Invoke the complete lane**

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
export RUN_ROOT="$(node -e 'const {readFileSync}=require("node:fs"); const active=JSON.parse(readFileSync("artifacts/testing/dedicated-infrastructure/active-run.json","utf8")); process.stdout.write(active.runRoot)')"
test -f "$RUN_ROOT/state.json"
test -f "$RUN_ROOT/infra-runner.ts"
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

The chart/reachability argv are exactly equivalent to:

```bash
helm --kube-context "<context>" install dawn-app charts/dawn-app \
  --set-string "image.repository=<placeholder-repository>" \
  --set-string "image.digest=<placeholder-digest>" \
  --set containerPort=8080 --set healthPath=/ \
  --set serviceAccount.create=true \
  --set serviceAccount.name=dawn-app-smoke \
  --wait --timeout 3m
kubectl --context "<context>" rollout status deploy/dawn-app --timeout=120s
kubectl --context "<context>" run curl \
  --image="<policy-reachability-image>" --restart=Never --rm -i --quiet -- \
  curl -sf http://dawn-app.default.svc.cluster.local/
```

Diagnostics include the default namespace. Cleanup uninstalls the exact release
then deletes the exact cluster. Verify the result row and exact cluster absence.
No commit.

### Task 4: Run Focused Compatibility On Kubernetes 1.35

- [ ] **Step 1: Invoke the complete lane**

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
export RUN_ROOT="$(node -e 'const {readFileSync}=require("node:fs"); const active=JSON.parse(readFileSync("artifacts/testing/dedicated-infrastructure/active-run.json","utf8")); process.stdout.write(active.runRoot)')"
test -f "$RUN_ROOT/state.json"
test -f "$RUN_ROOT/infra-runner.ts"
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
cd /Users/blove/.codex/worktrees/b5f4/dawn
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
export RUN_ROOT="$(node -e 'const {readFileSync}=require("node:fs"); const active=JSON.parse(readFileSync("artifacts/testing/dedicated-infrastructure/active-run.json","utf8")); process.stdout.write(active.runRoot)')"
test -f "$RUN_ROOT/state.json"
test -f "$RUN_ROOT/infra-runner.ts"
pnpm exec tsx "$RUN_ROOT/infra-runner.ts" run focused-1.34
```

Use the policy 1.34 image and target `1.34`; otherwise execute the same
chart-RBAC, verified Calico, readiness, harness, diagnostics, and exact cleanup
sequence as Task 4. This lane runs even if 1.35 failed unless a separately
confirmed shared prerequisite blocks both. No commit.

### Task 6: Run Focused Compatibility On Kubernetes 1.36

- [ ] **Step 1: Invoke the complete lane**

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
export RUN_ROOT="$(node -e 'const {readFileSync}=require("node:fs"); const active=JSON.parse(readFileSync("artifacts/testing/dedicated-infrastructure/active-run.json","utf8")); process.stdout.write(active.runRoot)')"
test -f "$RUN_ROOT/state.json"
test -f "$RUN_ROOT/infra-runner.ts"
pnpm exec tsx "$RUN_ROOT/infra-runner.ts" run focused-1.36
```

Use the policy 1.36 image and target `1.36`; otherwise execute the same
sequence as Task 4. This lane runs independently of target-specific 1.34/1.35
failures. No commit.

### Task 7: Run Packaged Kubernetes E2E On Kubernetes 1.35

- [ ] **Step 1: Invoke the complete lane**

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
export RUN_ROOT="$(node -e 'const {readFileSync}=require("node:fs"); const active=JSON.parse(readFileSync("artifacts/testing/dedicated-infrastructure/active-run.json","utf8")); process.stdout.write(active.runRoot)')"
test -f "$RUN_ROOT/state.json"
test -f "$RUN_ROOT/infra-runner.ts"
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

The workload argv are exactly equivalent to:

```bash
kubectl --context "<context>" create namespace dawn-app
helm --kube-context "<context>" install dawn-sandbox-infra \
  charts/dawn-sandbox-infra -n dawn-sandboxes --create-namespace \
  -f test/k8s-smoke/values-sandbox-infra.yaml --wait
kubectl --context "<context>" apply \
  -f test/k8s-smoke/aimock.k8s.yaml
kubectl --context "<context>" -n dawn-app rollout status \
  deploy/aimock --timeout=120s
helm --kube-context "<context>" install dawn-app charts/dawn-app \
  -n dawn-app -f test/k8s-smoke/values-dawn-app.yaml --wait
sh test/k8s-smoke/assert-k8s.sh
```

Cleanup uses only this disposable cluster/context and these exact names:

```bash
helm --kube-context "<context>" uninstall dawn-app -n dawn-app
helm --kube-context "<context>" uninstall dawn-sandbox-infra -n dawn-sandboxes
kubectl --context "<context>" delete namespace dawn-app dawn-sandboxes \
  --ignore-not-found=true --wait=false
kind delete cluster --name "<owned-cluster>"
```

Track the two image IDs immediately after build. At cleanup, require each fixed
tag still resolve to the recorded ID before removing that tag. A changed tag is
a cleanup failure and is not removed. Verify both tags are absent afterward.
Wrap each build in `try/finally`: once a fixed-tag build command has started,
inspect the tag in `finally` even when the command failed. Because preflight
proved absence, any observed tag becomes run-owned with its exact image ID and
must enter identity-checked cleanup. This captures the intermediate
`dawn-smoke-app:k8s` tag left by a partially failed build.
No commit.

### Task 8: Run Packaged Docker E2E Independently

- [ ] **Step 1: Invoke the complete lane even after Kubernetes-only failures**

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
export RUN_ROOT="$(node -e 'const {readFileSync}=require("node:fs"); const active=JSON.parse(readFileSync("artifacts/testing/dedicated-infrastructure/active-run.json","utf8")); process.stdout.write(active.runRoot)')"
test -f "$RUN_ROOT/state.json"
test -f "$RUN_ROOT/infra-runner.ts"
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
The `build-image.sh docker` call also uses `try/finally` adoption: it can create
the base `dawn-smoke-app:docker` tag and then fail while adding the static Docker
CLI. Inspect and claim that exact tag after every started build outcome, then
remove it only when its current image ID still matches the recorded ID.

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
cd /Users/blove/.codex/worktrees/b5f4/dawn
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
export RUN_ROOT="$(node -e 'const {readFileSync}=require("node:fs"); const active=JSON.parse(readFileSync("artifacts/testing/dedicated-infrastructure/active-run.json","utf8")); process.stdout.write(active.runRoot)')"
test -f "$RUN_ROOT/state.json"
test -f "$RUN_ROOT/infra-runner.ts"
pnpm exec tsx "$RUN_ROOT/infra-runner.ts" validate
```

`validate` must require:

- exactly six distinct rows in the fixed order;
- only the declared enum values;
- all status/classification/cleanup/blocked-field invariants in the Persisted
  Evidence Contract;
- parseable ordered timestamps and nonempty tool versions/resources;
- attempt count, IDs, retry eligibility, and retry resource naming;
- a nonempty diagnostics path for every failed attempt; the file must exist,
  be owned by this run root, have a SHA-256 recorded in state, and have a
  modification time between that attempt's start and finish;
- an existing native artifact for each attempted focused lane. Parse the JSON
  and require its target, observed server minor, harness run ID, and timestamps
  to match the recorded lane/attempt; require its SHA-256 and path to be
  recorded on that `AttemptRecord`. The report schema has no context field, so
  validate the attempt's separately recorded `context` against the exact
  cluster resource and the argv ledger used to invoke the harness;
- a named prerequisite and exact hosted equivalent for every blocked row;
- exact absence of every run-owned cluster, fixed smoke object, registry
  process, and fixed image tag;
- sandbox container/volume namespace sets equal to the captured baseline (and
  empty for any successfully attempted Docker lane);
- unchanged baseline Kind clusters; and
- no unrecorded retained cluster.

Also re-hash `.github/kubernetes-compatibility.json` and require it to equal
`RunState.policySha256`. Require the recorded Kind, kubectl, and Helm paths to
be children of the owned tool root; require versions `v0.32.0`, `v1.35.6`, and
`v4.2.3`; and require the recorded Kind/kubectl download hashes to equal the
fixed expected hashes in Task 2. Compare every pre-existing fixed container,
network, sandbox container, volume, and image tag to its baseline object/image
ID. A pre-existing object may remain unchanged; it may never disappear or be
replaced. When an E2E lane passed its preflight, the relevant baseline entries
must have been absent and the run-created fixed tags/resources must now be
absent.

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
cd /Users/blove/.codex/worktrees/b5f4/dawn
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
export RUN_ROOT="$(node -e 'const {readFileSync}=require("node:fs"); const active=JSON.parse(readFileSync("artifacts/testing/dedicated-infrastructure/active-run.json","utf8")); process.stdout.write(active.runRoot)')"
test -f "$RUN_ROOT/state.json"
test -f "$RUN_ROOT/infra-runner.ts"
pnpm exec tsx "$RUN_ROOT/infra-runner.ts" cleanup
```

`cleanup` re-runs the exact absence/baseline audit, validates canonical
`TOOL_ROOT` plus its owner marker, and removes only that tool root through
`fs.rm`. It leaves ignored evidence under `RUN_ROOT`. It refuses to finish
while an owned or retained cluster/resource remains. Only after tool-root
absence is proved does it atomically set `finalizedAt`, verify that the global
`active-run.json` lease still has this run ID and nonce, and remove that exact
lease. A mismatch leaves the lease untouched and fails cleanup.

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
