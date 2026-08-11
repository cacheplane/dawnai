# Dedicated Infrastructure Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the known Docker smoke ownership defect, then collect local, secret-safe evidence for all six dedicated chart, Kubernetes, and Docker infrastructure lanes without adding a public runner or mutating hosted state.

**Architecture:** The only pre-confirmed source change is an ownership-aware rewrite of `test/k8s-smoke/assert-docker.sh`, covered by a deterministic fake-command test under `test/**/*.test.ts`. Local evidence then uses a temporary Node 24/tool environment, one uniquely named disposable Kind cluster at a time, the checked-in compatibility policy and workflow commands, and per-lane records under ignored artifacts. Any further source change is conditional on reproducible live evidence and must enter systematic debugging and TDD before implementation.

**Tech Stack:** POSIX `sh`, TypeScript 7, Node 24, pnpm 10.33.0, Vitest 4, Docker Desktop, Kind v0.32.0, kubectl v1.35.6, Helm v4.2.3, Kubernetes 1.34/1.35/1.36, Calico v3.32.1, `curl`, `jq`

---

## Scope And File Map

Known tracked changes:

- Create `test/k8s-compat/assert-docker-smoke.test.ts`: deterministic fake `docker`, `curl`, `jq`, and `sleep` harness for the Docker smoke shell lifecycle.
- Modify `test/k8s-smoke/assert-docker.sh`: fail-closed preflight, exact thread-derived ownership, diagnostics-first traps, and exact cleanup.

Canonical inputs to read but not change unless later live evidence proves a separate defect:

- `.github/kubernetes-compatibility.json`: Node/pnpm/Helm/Kind/kubectl, Kubernetes node image, Calico, and workload image pins.
- `.github/workflows/kubernetes-compat.yml`: focused endpoint prerequisites and harness invocation.
- `.github/workflows/ci.yml`: chart apply, canonical 1.35, Kubernetes E2E, and Docker E2E commands.
- `.github/kind/kind-calico.yaml`: no-CNI Kind configuration for Calico-backed lanes.
- `scripts/kubernetes-compat/**`: verified Calico preparation, focused harness, redacted reports, ownership-aware namespace cleanup, and `--keep-on-failure` behavior.
- `test/k8s-smoke/assert-k8s.sh`, `test/k8s-smoke/build-image.sh`, `test/k8s-smoke/serve-registry.ts`, and the smoke manifests/values: packaged-application E2E behavior.

Ignored local evidence only:

- `artifacts/testing/dedicated-infrastructure/$RUN_ID/environment.txt`
- `artifacts/testing/dedicated-infrastructure/$RUN_ID/results.tsv`
- `artifacts/testing/dedicated-infrastructure/$RUN_ID/$LANE/attempts.tsv`
- `artifacts/testing/dedicated-infrastructure/$RUN_ID/$LANE/run.log`
- `artifacts/testing/dedicated-infrastructure/$RUN_ID/$LANE/diagnostics.log`
- Existing native focused reports under `artifacts/testing/kubernetes-compat/*.json`

Do not add a package script, checked-in local lane runner, changeset, workflow, workflow fixture, or public command for this phase. Do not push, open a pull request, dispatch a workflow, alter branch protection, or make any other hosted mutation.

## Execution Contract

Run every command from `/Users/blove/.codex/worktrees/b5f4/dawn` on branch `blove/kubernetes-compat-hardening`. The interactive default is Node 22, so every Node/pnpm command must explicitly prepend the installed Node 24 path:

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
export NODE24_BIN="/Users/blove/.nvm/versions/node/v24.19.0/bin"
export PATH="$NODE24_BIN:$PATH"
test "$(git branch --show-current)" = "blove/kubernetes-compat-hardening"
node --version
corepack pnpm --version
```

Expected: branch check passes, Node prints `v24.19.0`, and pnpm prints `10.33.0`. The policy pins hosted CI to Node `24.17.0`; local work deliberately uses the installed Node 24 patch and records the exact value.

The six first-pass lanes are sequential and immutable in this order:

| Order | Result ID | Lane | Kubernetes |
|---:|---|---|---|
| 1 | `chart-apply-1.35` | Chart apply smoke | 1.35.5 |
| 2 | `focused-1.35` | Canonical focused compatibility | 1.35.5 |
| 3 | `focused-1.34` | Lower endpoint focused compatibility | 1.34.8 |
| 4 | `focused-1.36` | Upper endpoint focused compatibility | 1.36.1 |
| 5 | `kubernetes-e2e-1.35` | Packaged Dawn application Kubernetes E2E | 1.35.5 |
| 6 | `docker-e2e` | Packaged Dawn application Docker E2E | n/a |

Every lane gets a `passed`, `failed`, or `blocked` row. A version-specific failure does not block either endpoint cluster. Only a confirmed shared prerequisite failure may block dependent lanes: for example, a verified Calico checksum failure may block all Calico lanes, and a reproducible `chart-rbac` failure may block the focused and Kubernetes E2E lanes. Kubernetes failures never block Docker E2E. A shared workspace build failure may block both packaged-app lanes only after it is independently reproduced outside cluster setup.

### Failure, Retry, And Retention Contract

Apply this contract immediately after every operational attempt in Tasks 3-8:

- Classify a failure as exactly one of `bootstrap/environment`, `cluster-setup`, `dawn-behavior`, or `cleanup`; record the class beside the lane log before changing source. An ARM64-only result is local-environment evidence and must name the equivalent hosted Ubuntu AMD64 lane still required.
- Allow one clean retry only for evidence-backed transient download, image-pull/load, Docker bootstrap, or cluster-setup failure. A Kubernetes retry uses the same policy image with the new exact name `${cluster}-retry1`, starts only after deletion of the first exact cluster is confirmed, and is also deleted by exact name. A Docker retry starts only after the hardened script proves the exact fixed resources and both sandbox namespaces empty. Record `attempt0` and `retry1`; never take a second retry.
- Never retry a checksum mismatch, unsupported host, policy mismatch, Dawn assertion, provider behavior, chart lifecycle, permission, or E2E contract failure merely to seek a pass. For any assertion or Dawn-behavior failure, invoke `@superpowers:systematic-debugging`, reduce the issue to the narrowest reproducible cause, invoke `@superpowers:test-driven-development`, preserve RED evidence, implement only the proven fix, preserve GREEN evidence, and rerun the affected lane from a clean environment. This plan deliberately does not invent fixes for failures that have not occurred.
- Continue independent lanes after a version-specific failure. Mark a lane `blocked` only when a separately confirmed shared prerequisite applies, and name that prerequisite in its result row. Kubernetes failures never block Task 8's Docker lane.
- First-pass cleanup is mandatory, including on signals. Retention is allowed only as a separate, explicit Kubernetes rerun after the first-pass result and bounded diagnostics have been saved. Use a new exact `dawn-local-${RUN_TOKEN}-*-retain1` cluster, use `--keep-on-failure` only for a focused harness rerun, never retain Docker resources, and delete that exact retained cluster before Task 9 can complete. A retained-cluster cleanup failure is `cleanup`, not permission to use prefix-wide deletion.

No command in this plan pushes a branch, opens a pull request, dispatches a workflow, modifies branch protection, or adds a public/committed infrastructure runner.

### Task 1: Harden Docker Smoke Ownership Under Deterministic TDD

**Files:**
- Create: `test/k8s-compat/assert-docker-smoke.test.ts`
- Modify: `test/k8s-smoke/assert-docker.sh`

- [ ] **Step 1: Add a fake-command harness that runs the real shell script**

Create `test/k8s-compat/assert-docker-smoke.test.ts`. Keep every fake in this test file so the test remains enrolled by the existing `test/k8s-compat/vitest.config.ts` and no second test configuration is needed. The complete harness shape is:

```ts
import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

const repoRoot = process.cwd()
const script = resolve(repoRoot, "test/k8s-smoke/assert-docker.sh")
const temporaryRoots: string[] = []

interface Event {
  readonly command: string
  readonly args: readonly string[]
}

interface Harness {
  readonly root: string
  readonly statePath: string
  readonly transcriptPath: string
  run(): ReturnType<typeof spawnSync>
  events(): Promise<readonly Event[]>
}

const fakeCommandSource = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { basename } from "node:path"

const command = basename(process.argv[1] ?? "")
const args = process.argv.slice(2)
const statePath = process.env.FAKE_STATE
const transcriptPath = process.env.FAKE_TRANSCRIPT
if (!statePath || !transcriptPath) process.exit(97)

const load = () => JSON.parse(readFileSync(statePath, "utf8"))
const save = (state) => writeFileSync(statePath, JSON.stringify(state))
appendFileSync(transcriptPath, JSON.stringify({ command, args }) + "\\n")

const output = (value) => process.stdout.write(String(value))
const sanitize = (value) => value.replace(/[^a-zA-Z0-9_.-]/g, "_")
const has = (args, value) => args.includes(value)

if (command === "sleep") process.exit(0)

if (command === "jq") {
  const program = args.join(" ")
  const state = load()
  if (program.includes(".thread_id")) output(state.threadId + "\\n")
  else output("1000\\n" + state.sandboxHostname + "\\n")
  process.exit(0)
}

if (command === "curl") {
  const state = load()
  const joined = args.join(" ")
  const suffix = sanitize(state.threadId)
  const sandbox = "dawn-sbx-" + suffix
  const volume = "dawn-sbx-vol-" + suffix
  if (joined.includes("/runs/wait")) {
    state.containers[sandbox] = {
      hostname: state.sandboxHostname,
      user: "1000:1000",
      readonlyRootfs: "true",
      labels: {
        "dawn.sandbox": state.scenario === "thread-label-mismatch" ? "another_thread" : suffix,
        "dawn.sandbox.identity": state.scenario === "identity-label-invalid" ? "not-a-digest" : "a".repeat(64),
      },
    }
    if (state.scenario !== "volume-not-observed") {
      state.volumes = [...new Set([...state.volumes, volume])]
    }
    if (state.scenario === "extra-sandbox") {
      state.containers["dawn-sbx-foreign"] = {
        hostname: "foreign",
        user: "1000:1000",
        readonlyRootfs: "true",
        labels: { "dawn.sandbox": "foreign", "dawn.sandbox.identity": "b".repeat(64) },
      }
    }
    save(state)
    if (state.scenario === "signal") {
      process.kill(process.ppid, "SIGTERM")
      setTimeout(() => process.exit(143), 100)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
    }
    if (state.scenario === "run-failure") process.exit(22)
    output("{}")
    process.exit(0)
  }
  if (joined.includes("-X POST") && joined.includes("/threads") && !joined.includes("/runs/")) {
    output(JSON.stringify({ thread_id: state.threadId }))
    process.exit(0)
  }
  if (joined.includes("-X DELETE")) {
    delete state.containers[sandbox]
    state.volumes = state.volumes.filter((name) => name !== volume)
    save(state)
    process.exit(0)
  }
  process.exit(0)
}

if (command !== "docker") process.exit(98)
const state = load()
const saveAndExit = (code = 0) => { save(state); process.exit(code) }
const container = (name) => state.containers[name]
const filterValue = () => args[args.indexOf("--filter") + 1] ?? ""
const filteredContainers = () => {
  const filter = filterValue()
  if (!filter.startsWith("name=")) return Object.keys(state.containers)
  const pattern = filter.slice("name=".length)
  if (pattern.startsWith("^") && pattern.endsWith("$")) {
    const exact = pattern.slice(1, -1)
    return container(exact) ? [exact] : []
  }
  return Object.keys(state.containers).filter((name) => name.includes(pattern))
}

if (args[0] === "info") process.exit(0)
if (args[0] === "ps") {
  output(filteredContainers().join("\\n") + (filteredContainers().length ? "\\n" : ""))
  process.exit(0)
}
if (args[0] === "container" && args[1] === "inspect") {
  process.exit(container(args.at(-1)) ? 0 : 1)
}
if (args[0] === "network" && args[1] === "inspect") {
  process.exit(state.networks.includes(args[2]) ? 0 : 1)
}
if (args[0] === "network" && args[1] === "create") {
  state.networks.push(args[2])
  saveAndExit()
}
if (args[0] === "network" && args[1] === "rm") {
  state.networks = state.networks.filter((name) => name !== args[2])
  saveAndExit()
}
if (args[0] === "volume" && args[1] === "ls") {
  output(state.volumes.join("\\n") + (state.volumes.length ? "\\n" : ""))
  process.exit(0)
}
if (args[0] === "volume" && args[1] === "inspect") {
  process.exit(state.volumes.includes(args[2]) ? 0 : 1)
}
if (args[0] === "volume" && args[1] === "rm") {
  state.volumes = state.volumes.filter((name) => name !== args[2])
  saveAndExit()
}
if (args[0] === "run") {
  if (has(args, "--rm")) { output("0\\n"); process.exit(0) }
  const name = args[args.indexOf("--name") + 1]
  state.containers[name] = {
    hostname: name === "dawn-smoke-app" ? "app-host" : name,
    user: "1000:1000",
    readonlyRootfs: "true",
    labels: {},
  }
  saveAndExit()
}
if (args[0] === "inspect") {
  const name = args.at(-1)
  const value = container(name)
  if (!value) process.exit(1)
  const format = args[args.indexOf("-f") + 1] ?? ""
  if (format.includes("Config.Hostname")) output(value.hostname + "\\n")
  else if (format.includes("Config.User")) output(value.user + "\\n")
  else if (format.includes("ReadonlyRootfs")) output(value.readonlyRootfs + "\\n")
  else if (format.includes(".Name")) output("/" + name + "\\n")
  else if (format.includes("dawn.sandbox.identity")) output((value.labels["dawn.sandbox.identity"] ?? "") + "\\n")
  else if (format.includes("dawn.sandbox")) output((value.labels["dawn.sandbox"] ?? "") + "\\n")
  process.exit(0)
}
if (args[0] === "logs") { output("bounded fake logs\\n"); process.exit(0) }
if (args[0] === "rm" && args[1] === "-f") {
  for (const name of args.slice(2)) delete state.containers[name]
  saveAndExit()
}
process.exit(0)
`

async function makeHarness(scenario: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "dawn-docker-smoke-"))
  temporaryRoots.push(root)
  const statePath = join(root, "state.json")
  const transcriptPath = join(root, "transcript.jsonl")
  const fakeBin = join(root, "bin")
  await mkdir(fakeBin)
  const initial = {
    scenario,
    threadId: "thread/123",
    sandboxHostname: "dawn-sbx-thread_123",
    containers: scenario === "occupied-app" ? { "dawn-smoke-app": { labels: {} } } :
      scenario === "occupied-aimock" ? { "dawn-smoke-aimock": { labels: {} } } :
      scenario === "occupied-sandbox" ? { "dawn-sbx-foreign": { labels: { "dawn.sandbox": "foreign" } } } : {},
    volumes: scenario === "occupied-volume" ? ["dawn-sbx-vol-foreign"] : [],
    networks: scenario === "occupied-network" ? ["dawn-smoke-net"] : [],
  }
  await writeFile(statePath, JSON.stringify(initial))
  await writeFile(transcriptPath, "")
  for (const name of ["docker", "curl", "jq", "sleep"]) {
    const path = join(fakeBin, name)
    await writeFile(path, fakeCommandSource)
    await chmod(path, 0o755)
  }
  return {
    root,
    statePath,
    transcriptPath,
    run: () =>
      spawnSync("sh", [script], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          FAKE_STATE: statePath,
          FAKE_TRANSCRIPT: transcriptPath,
        },
      }),
    events: async () =>
      (await readFile(transcriptPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Event),
  }
}

function destructiveTarget(event: Event): string | undefined {
  if (event.command !== "docker") return undefined
  if (event.args[0] === "rm" && event.args[1] === "-f") return event.args[2]
  if (event.args[0] === "volume" && event.args[1] === "rm") return event.args[2]
  if (event.args[0] === "network" && event.args[1] === "rm") return event.args[2]
  return undefined
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("assert-docker smoke ownership", () => {
  test.each(["occupied-app", "occupied-aimock", "occupied-network", "occupied-sandbox", "occupied-volume"])(
    "refuses %s without deleting it",
    async (scenario) => {
      const harness = await makeHarness(scenario)
      const result = harness.run()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/refus|occupied|already exists/i)
      expect((await harness.events()).map(destructiveTarget).filter(Boolean)).toEqual([])
    },
  )

  test("derives exact sandbox names and removes only run-owned resources", async () => {
    const harness = await makeHarness("success")
    const result = harness.run()
    expect(result.status).toBe(0)
    const events = await harness.events()
    const targets = events.map(destructiveTarget).filter(Boolean)
    expect(new Set(targets)).toEqual(new Set([
      "dawn-smoke-app",
      "dawn-smoke-aimock",
      "dawn-smoke-net",
    ]))
    expect(events.some((event) =>
      event.command === "docker" &&
      event.args[0] === "container" &&
      event.args[1] === "inspect" &&
      event.args[2] === "dawn-sbx-thread_123"
    )).toBe(true)
    expect(events.some((event) =>
      event.command === "docker" &&
      event.args[0] === "volume" &&
      event.args[1] === "inspect" &&
      event.args[2] === "dawn-sbx-vol-thread_123"
    )).toBe(true)
    expect(events.some((event) =>
      event.command === "docker" &&
      event.args[0] === "inspect" &&
      event.args.join(" ").includes("dawn.sandbox.identity") &&
      event.args.at(-1) === "dawn-sbx-thread_123"
    )).toBe(true)
  })

  test.each(["run-failure", "signal"])(
    "captures exact diagnostics before cleanup on %s",
    async (scenario) => {
      const harness = await makeHarness(scenario)
      const result = harness.run()
      expect(result.status).not.toBe(0)
      const events = await harness.events()
      const logs = events.findIndex((event) => event.command === "docker" && event.args[0] === "logs")
      const removal = events.findIndex((event) => destructiveTarget(event) === "dawn-smoke-app")
      const targets = events.map(destructiveTarget).filter(Boolean)
      expect(logs).toBeGreaterThanOrEqual(0)
      expect(removal).toBeGreaterThan(logs)
      expect(targets).toContain("dawn-sbx-thread_123")
      expect(targets).toContain("dawn-sbx-vol-thread_123")
      expect(targets).not.toContain("dawn-sbx-foreign")
    },
  )

  test("reports an unexpected concurrent sandbox without deleting it", async () => {
    const harness = await makeHarness("extra-sandbox")
    const result = harness.run()
    expect(result.status).not.toBe(0)
    const targets = (await harness.events()).map(destructiveTarget).filter(Boolean)
    expect(targets).not.toContain("dawn-sbx-foreign")
  })

  test.each(["thread-label-mismatch", "identity-label-invalid"])(
    "refuses to adopt an exact-name container with %s",
    async (scenario) => {
      const harness = await makeHarness(scenario)
      const result = harness.run()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/identity|label|refus/i)
      const targets = (await harness.events()).map(destructiveTarget).filter(Boolean)
      expect(targets).not.toContain("dawn-sbx-thread_123")
      expect(targets).not.toContain("dawn-sbx-vol-thread_123")
    },
  )

  test("does not claim a thread-derived volume until its creation is observed", async () => {
    const harness = await makeHarness("volume-not-observed")
    const result = harness.run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/volume|observed|created/i)
    const targets = (await harness.events()).map(destructiveTarget).filter(Boolean)
    expect(targets).not.toContain("dawn-sbx-vol-thread_123")
  })
})
```

During implementation, tighten any fake parsing needed by the final shell syntax, but do not replace dynamic lifecycle assertions with source-text-only checks.

- [ ] **Step 2: Run the test and preserve the red evidence**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts assert-docker-smoke
```

Expected RED: the current script invokes `cleanup` before preflight and therefore deletes occupied fixed/prefix resources; signal handling also cleans without first emitting diagnostics.

- [ ] **Step 3: Replace prefix ownership with exact run state**

In `test/k8s-smoke/assert-docker.sh`, remove both calls/loops that delete `dawn-sbx-*` or `dawn-sbx-vol-*` by prefix. Preserve the existing Agent Protocol and sandbox hardening assertions, but replace lifecycle state, preflight, traps, sandbox discovery, and teardown checks with these complete boundaries:

```sh
SBX_PREFIX=dawn-sbx-
SBX_VOL_PREFIX=dawn-sbx-vol-

APP_OWNED=0
AIMOCK_OWNED=0
NETWORK_OWNED=0
SBX_CONTAINER_OWNED=0
SBX_VOLUME_OWNED=0
SBX_NAMES_PREFLIGHTED=0
RUN_REQUEST_STARTED=0
SBX_NAME=
SBX_VOLUME=
SANITIZED_TID=
SBX_IDENTITY=
SIGNAL_NAME=

fail() {
  echo "ASSERT FAILED: $*" >&2
  exit 1
}

container_exists() {
  docker container inspect "$1" >/dev/null 2>&1
}

network_exists() {
  docker network inspect "$1" >/dev/null 2>&1
}

volume_exists() {
  docker volume inspect "$1" >/dev/null 2>&1
}

sandbox_container_names() {
  docker ps -a --format '{{.Names}}' | awk -v prefix="$SBX_PREFIX" 'index($0, prefix) == 1'
}

sandbox_volume_names() {
  docker volume ls -q | awk -v prefix="$SBX_VOL_PREFIX" 'index($0, prefix) == 1'
}

observe_run_owned_sandbox() {
  [ "$SBX_NAMES_PREFLIGHTED" = 1 ] || return 0
  [ "$RUN_REQUEST_STARTED" = 1 ] || return 0

  if container_exists "$SBX_NAME"; then
    observed_thread=$(docker inspect -f '{{ index .Config.Labels "dawn.sandbox" }}' "$SBX_NAME" 2>/dev/null | tr -d '\r')
    observed_identity=$(docker inspect -f '{{ index .Config.Labels "dawn.sandbox.identity" }}' "$SBX_NAME" 2>/dev/null | tr -d '\r')
    [ "$observed_thread" = "$SANITIZED_TID" ] || return 1
    printf '%s\n' "$observed_identity" | grep -Eq '^[0-9a-f]{64}$' || return 1
    if [ -n "$SBX_IDENTITY" ] && [ "$observed_identity" != "$SBX_IDENTITY" ]; then
      SBX_CONTAINER_OWNED=0
      return 1
    fi
    SBX_IDENTITY=$observed_identity
    SBX_CONTAINER_OWNED=1
  fi

  # Docker volumes have no provider identity label. Ownership is therefore the
  # conjunction of preflight absence, the exact sanitized thread-derived name,
  # and observation after this run's request began.
  if volume_exists "$SBX_VOLUME"; then
    SBX_VOLUME_OWNED=1
  fi
}

diagnostics() {
  status=$1
  echo "----- docker smoke diagnostics (status=$status signal=${SIGNAL_NAME:-none}) -----" >&2
  for name in "$APP_NAME" "$AIMOCK_NAME"; do
    docker ps -a --filter "name=^${name}$" --format '{{.ID}} {{.Names}} {{.Status}}' >&2 2>&1 || true
  done
  if [ -n "$SBX_NAME" ]; then
    docker ps -a --filter "name=^${SBX_NAME}$" --format '{{.ID}} {{.Names}} {{.Status}}' >&2 2>&1 || true
  fi
  echo "----- sandbox namespace -----" >&2
  sandbox_container_names 2>/dev/null | sed -n '1,50p' >&2 || true
  sandbox_volume_names 2>/dev/null | sed -n '1,50p' >&2 || true
  echo "----- app logs -----" >&2
  docker logs "$APP_NAME" --tail=150 >&2 2>&1 || true
  echo "----- aimock logs -----" >&2
  docker logs "$AIMOCK_NAME" --tail=60 >&2 2>&1 || true
  if [ -n "$SBX_NAME" ]; then
    echo "----- exact sandbox state ($SBX_NAME) -----" >&2
    docker inspect -f 'name={{.Name}} user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} thread={{index .Config.Labels "dawn.sandbox"}} identity={{index .Config.Labels "dawn.sandbox.identity"}}' "$SBX_NAME" >&2 2>&1 || true
  fi
}

cleanup() {
  cleanup_failed=0
  if [ "$SBX_CONTAINER_OWNED" = 1 ]; then
    docker rm -f "$SBX_NAME" >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [ "$SBX_VOLUME_OWNED" = 1 ]; then
    docker volume rm "$SBX_VOLUME" >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [ "$APP_OWNED" = 1 ]; then
    docker rm -f "$APP_NAME" >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [ "$AIMOCK_OWNED" = 1 ]; then
    docker rm -f "$AIMOCK_NAME" >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [ "$NETWORK_OWNED" = 1 ]; then
    docker network rm "$NET" >/dev/null 2>&1 || cleanup_failed=1
  fi
  return "$cleanup_failed"
}

on_signal() {
  SIGNAL_NAME=$1
  case "$SIGNAL_NAME" in
    HUP) exit 129 ;;
    INT) exit 130 ;;
    TERM) exit 143 ;;
  esac
}

on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  observe_run_owned_sandbox
  ownership_status=$?
  if [ "$ownership_status" -ne 0 ]; then
    echo "ASSERT FAILED: exact sandbox identity changed; refusing to adopt it" >&2
    status=1
  fi
  if [ "$status" -ne 0 ]; then
    diagnostics "$status"
  fi
  cleanup
  cleanup_status=$?
  if [ "$cleanup_status" -ne 0 ]; then
    echo "ASSERT FAILED: exact run-owned Docker cleanup failed" >&2
    status=1
  fi
  exit "$status"
}

trap 'on_signal HUP' HUP
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap on_exit EXIT
```

Replace the clean-slate section with fail-closed preflight:

```sh
for executable in docker curl jq awk grep sed tr; do
  command -v "$executable" >/dev/null 2>&1 || fail "required host command is missing: $executable"
done
docker info >/dev/null 2>&1 || fail "host docker daemon not reachable (DooD needs a working host docker)"

container_exists "$APP_NAME" && fail "refusing occupied app container: $APP_NAME"
container_exists "$AIMOCK_NAME" && fail "refusing occupied aimock container: $AIMOCK_NAME"
network_exists "$NET" && fail "refusing occupied Docker network: $NET"

PREEXISTING_SBX=$(sandbox_container_names)
[ -z "$PREEXISTING_SBX" ] || fail "refusing occupied sandbox-container namespace: $PREEXISTING_SBX"
PREEXISTING_SBX_VOLUMES=$(sandbox_volume_names)
[ -z "$PREEXISTING_SBX_VOLUMES" ] || fail "refusing occupied sandbox-volume namespace: $PREEXISTING_SBX_VOLUMES"

docker network create "$NET" >/dev/null 2>&1 || fail "failed to create Docker network $NET"
NETWORK_OWNED=1
```

Set each fixed ownership bit immediately after its successful `docker run`. Immediately after parsing `TID`, derive and preflight the exact sandbox names before the run request:

```sh
SANITIZED_TID=$(printf '%s' "$TID" | sed 's/[^a-zA-Z0-9_.-]/_/g')
SBX_NAME="${SBX_PREFIX}${SANITIZED_TID}"
SBX_VOLUME="${SBX_VOL_PREFIX}${SANITIZED_TID}"
container_exists "$SBX_NAME" && fail "refusing pre-existing thread sandbox container: $SBX_NAME"
volume_exists "$SBX_VOLUME" && fail "refusing pre-existing thread sandbox volume: $SBX_VOLUME"
SBX_NAMES_PREFLIGHTED=1
RUN_REQUEST_STARTED=1
```

After `/runs/wait`, call `observe_run_owned_sandbox`, require it to set both ownership bits, and require the entire live prefix namespace to contain only the two exact names. Replace all later prefix counts and discovery with exact `container_exists "$SBX_NAME"` / `volume_exists "$SBX_VOLUME"` checks. Inspect `SBX_NAME` directly and require both `dawn.sandbox=$SANITIZED_TID` and a 64-hex `dawn.sandbox.identity` before asserting user/rootfs/hostname. After `DELETE`, poll only those exact names; clear the ownership bits once absence is observed.

- [ ] **Step 4: Run green and focused static checks**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts assert-docker-smoke
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsc -p test/k8s-compat/tsconfig.json --noEmit
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec biome check --config-path packages/config-biome/biome.json \
    test/k8s-compat/assert-docker-smoke.test.ts
sh -n test/k8s-smoke/assert-docker.sh
```

Expected GREEN: all fake scenarios pass, TypeScript and Biome pass, and `sh -n` exits zero. Confirm the shell source contains no destructive command whose target comes from `docker ps ... dawn-sbx-` or `docker volume ls ... dawn-sbx-vol-`.

- [ ] **Step 5: Commit the known fix before any live lane**

```bash
git add test/k8s-compat/assert-docker-smoke.test.ts test/k8s-smoke/assert-docker.sh
git commit -m "fix(testing): isolate Docker smoke cleanup"
```

Do not change `.github/workflows/ci.yml` in this task. Its hosted runner has an additional prefix-wide teardown block, but the local Docker lane in Task 8 must invoke only the hardened script and must never copy or execute that hosted-only teardown.

### Task 2: Verify The Pinned Temporary Toolchain And Prerequisites

**Files:**
- Create ignored: `artifacts/testing/dedicated-infrastructure/$RUN_ID/**`
- Create temporary outside repository: `${TMPDIR:-/tmp}/dawn-infra-tools.*/kind`, `kubectl`, `helm`, checksums, Calico manifests, and kubeconfig
- Verify only: `.github/kubernetes-compatibility.json`

- [ ] **Step 1: Create one run identity, private tool directory, and result table**

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
export NODE24_BIN="/Users/blove/.nvm/versions/node/v24.19.0/bin"
export PATH="$NODE24_BIN:$PATH"
export STATE_ROOT="$PWD/artifacts/testing/dedicated-infrastructure"
export RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(node -e 'process.stdout.write(require("node:crypto").randomUUID().replaceAll("-", "").slice(0, 8))')"
export RUN_TOKEN="${RUN_ID##*-}"
export RUN_ROOT="$STATE_ROOT/$RUN_ID"
export TOOL_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dawn-infra-tools.XXXXXX")"
export KUBECONFIG="$TOOL_ROOT/kubeconfig"
mkdir -p "$RUN_ROOT"
chmod 700 "$RUN_ROOT" "$TOOL_ROOT"
printf 'lane\tstatus\tstarted_at\tfinished_at\texit_code\tclassification\tresource\ttool_versions\tnative_artifact\tcleanup\tretry\n' > "$RUN_ROOT/results.tsv"
printf '%s\n' "$RUN_ID" > "$RUN_ROOT/run-id.txt"
printf '%s\n' "$RUN_ID" > "$STATE_ROOT/active-run-id"
printf '%s\n' "$TOOL_ROOT" > "$RUN_ROOT/tool-root.txt"
git check-ignore "$RUN_ROOT/results.tsv" "$STATE_ROOT/active-run-id"
```

Expected: `git check-ignore "$RUN_ROOT/results.tsv"` prints the result path. The temporary kubeconfig is outside `artifacts/` and is deleted with `TOOL_ROOT`.

- [ ] **Step 2: Read exact policy values and reject a non-Darwin-ARM64 host**

```bash
export POLICY_NODE="$(jq -er '.toolchain.node' .github/kubernetes-compatibility.json)"
export POLICY_PNPM="$(jq -er '.toolchain.pnpm' .github/kubernetes-compatibility.json)"
export POLICY_HELM="$(jq -er '.toolchain.helm' .github/kubernetes-compatibility.json)"
export POLICY_KIND="$(jq -er '.toolchain.kind' .github/kubernetes-compatibility.json)"
export POLICY_KUBECTL="$(jq -er '.toolchain.kubectl' .github/kubernetes-compatibility.json)"
export IMAGE_134="$(jq -er '.targets[] | select(.minor == "1.34") | .nodeImage' .github/kubernetes-compatibility.json)"
export IMAGE_135="$(jq -er '.targets[] | select(.minor == "1.35") | .nodeImage' .github/kubernetes-compatibility.json)"
export IMAGE_136="$(jq -er '.targets[] | select(.minor == "1.36") | .nodeImage' .github/kubernetes-compatibility.json)"
test "$(uname -s)" = Darwin
test "$(uname -m)" = arm64
test "$POLICY_NODE" = 24.17.0
test "$POLICY_PNPM" = 10.33.0
test "$POLICY_HELM" = v4.2.3
test "$POLICY_KIND" = v0.32.0
test "$POLICY_KUBECTL" = v1.35.6
```

Expected: all tests pass on the approved local host. A host-architecture mismatch blocks the five Kubernetes lanes before mutation but does not block Docker E2E; continue Task 8 if its independent Node, Docker, `curl`, and `jq` prerequisites pass. A shared Node/workspace prerequisite may block Docker only after it is reproduced independently of Kubernetes bootstrap.

- [ ] **Step 3: Download Kind, kubectl, and Helm to `TOOL_ROOT` and verify official checksums**

```bash
KIND_BASE="https://github.com/kubernetes-sigs/kind/releases/download/${POLICY_KIND}"
KIND_ASSET=kind-darwin-arm64
curl --fail --show-error --silent --location --max-redirs 5 \
  --proto '=https' --proto-redir '=https' \
  "$KIND_BASE/$KIND_ASSET" -o "$TOOL_ROOT/$KIND_ASSET"
curl --fail --show-error --silent --location --max-redirs 5 \
  --proto '=https' --proto-redir '=https' \
  "$KIND_BASE/$KIND_ASSET.sha256sum" -o "$TOOL_ROOT/$KIND_ASSET.sha256sum"
grep -Eq '^[0-9a-f]{64}  kind-darwin-arm64$' "$TOOL_ROOT/$KIND_ASSET.sha256sum"
test "$(awk '{print $1}' "$TOOL_ROOT/$KIND_ASSET.sha256sum")" = \
  dca67911095a110c2b5c36e26df6cac860c602033e456c0db47be498cdef1ebb
(cd "$TOOL_ROOT" && shasum -a 256 --check "$KIND_ASSET.sha256sum")
mv "$TOOL_ROOT/$KIND_ASSET" "$TOOL_ROOT/kind"
chmod 700 "$TOOL_ROOT/kind"

KUBECTL_BASE="https://dl.k8s.io/release/${POLICY_KUBECTL}/bin/darwin/arm64"
curl --fail --show-error --silent --location --max-redirs 5 \
  --proto '=https' --proto-redir '=https' \
  "$KUBECTL_BASE/kubectl" -o "$TOOL_ROOT/kubectl"
curl --fail --show-error --silent --location --max-redirs 5 \
  --proto '=https' --proto-redir '=https' \
  "$KUBECTL_BASE/kubectl.sha256" -o "$TOOL_ROOT/kubectl.sha256"
grep -Eq '^[0-9a-f]{64}$' "$TOOL_ROOT/kubectl.sha256"
test "$(cat "$TOOL_ROOT/kubectl.sha256")" = \
  1827b555615791c1c1065dd64870eb49a4e00e9dfd389a82a2ef1d31bb46d200
printf '%s  %s\n' "$(cat "$TOOL_ROOT/kubectl.sha256")" "$TOOL_ROOT/kubectl" \
  | shasum -a 256 --check
chmod 700 "$TOOL_ROOT/kubectl"

HELM_ASSET="helm-${POLICY_HELM}-darwin-arm64.tar.gz"
HELM_BASE=https://get.helm.sh
curl --fail --show-error --silent --location --max-redirs 5 \
  --proto '=https' --proto-redir '=https' \
  "$HELM_BASE/$HELM_ASSET" -o "$TOOL_ROOT/$HELM_ASSET"
curl --fail --show-error --silent --location --max-redirs 5 \
  --proto '=https' --proto-redir '=https' \
  "$HELM_BASE/$HELM_ASSET.sha256sum" -o "$TOOL_ROOT/$HELM_ASSET.sha256sum"
grep -Eq "^[0-9a-f]{64}  ${HELM_ASSET}$" "$TOOL_ROOT/$HELM_ASSET.sha256sum"
(cd "$TOOL_ROOT" && shasum -a 256 --check "$HELM_ASSET.sha256sum")
tar -xzf "$TOOL_ROOT/$HELM_ASSET" -C "$TOOL_ROOT"
mv "$TOOL_ROOT/darwin-arm64/helm" "$TOOL_ROOT/helm"
rm -rf "$TOOL_ROOT/darwin-arm64"
chmod 700 "$TOOL_ROOT/helm"
export PATH="$TOOL_ROOT:$NODE24_BIN:$PATH"
```

Expected checksum evidence:

```text
kind-darwin-arm64: OK
/.../kubectl: OK
helm-v4.2.3-darwin-arm64.tar.gz: OK
```

The official v0.32.0 Darwin ARM64 Kind digest is `dca67911095a110c2b5c36e26df6cac860c602033e456c0db47be498cdef1ebb`; the official kubectl v1.35.6 Darwin ARM64 digest is `1827b555615791c1c1065dd64870eb49a4e00e9dfd389a82a2ef1d31bb46d200`. Kind and kubectl must match both the upstream checksum response and these expected release digests. A redirect downgrade, unexpected checksum-file shape, or mismatch is a bootstrap failure. Do not fall back to Homebrew or a globally installed binary.

- [ ] **Step 4: Run shared preflight and capture exact versions/baselines**

```bash
test "$(command -v kind)" = "$TOOL_ROOT/kind"
test "$(command -v kubectl)" = "$TOOL_ROOT/kubectl"
test "$(command -v helm)" = "$TOOL_ROOT/helm"
test "$(command -v node)" = "$NODE24_BIN/node"
test "$(node --version)" = v24.19.0
test "$(pnpm --version)" = "$POLICY_PNPM"
test "$(kind version | awk '{print $2}')" = "$POLICY_KIND"
kubectl version --client --output=json | jq -e --arg v "$POLICY_KUBECTL" '.clientVersion.gitVersion == $v'
test "$(helm version --short | cut -d+ -f1)" = "$POLICY_HELM"
for executable in bash docker curl jq shasum tar awk sed grep git; do command -v "$executable" >/dev/null; done
docker info >/dev/null
pnpm install --frozen-lockfile
kind get clusters | LC_ALL=C sort > "$RUN_ROOT/kind-clusters.before.txt"
docker ps -a --format '{{.Names}}' \
  | awk '$0 == "dawn-smoke-app" || $0 == "dawn-smoke-aimock" || index($0, "dawn-sbx-") == 1' \
  | LC_ALL=C sort > "$RUN_ROOT/docker-smoke-containers.before.txt"
docker volume ls -q \
  | awk 'index($0, "dawn-sbx-vol-") == 1' \
  | LC_ALL=C sort > "$RUN_ROOT/docker-smoke-volumes.before.txt"
docker network ls --format '{{.Name}}' \
  | awk '$0 == "dawn-smoke-net"' \
  | LC_ALL=C sort > "$RUN_ROOT/docker-smoke-networks.before.txt"
{
  printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'host=%s %s\n' "$(uname -s)" "$(uname -m)"
  printf 'docker=%s\n' "$(docker version --format 'client={{.Client.Version}} server={{.Server.Version}} arch={{.Server.Arch}} os={{.Server.Os}}')"
  printf 'node=%s\n' "$(node --version)"
  printf 'pnpm=%s\n' "$(pnpm --version)"
  printf 'helm=%s policy=%s\n' "$(helm version --short)" "$POLICY_HELM"
  printf 'kind=%s\n' "$(kind version)"
  printf 'kubectl=%s\n' "$(kubectl version --client --output=json | jq -r '.clientVersion.gitVersion')"
  printf 'curl=%s\n' "$(curl --version | sed -n '1p')"
  printf 'jq=%s\n' "$(jq --version)"
} > "$RUN_ROOT/environment.txt"
```

Expected: Docker is reachable; the executable paths prove Node, Kind, kubectl, and Helm came from the explicit/temporary locations; pnpm, Kind, kubectl, and Helm match policy exactly; and `curl`, `jq`, checksum, archive, shell, and text-processing prerequisites are present. No global install or repository runner file is created.

- [ ] **Step 5: Define the per-lane result and diagnostics contract in the working shell**

```bash
record_result() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}" \
    >> "$RUN_ROOT/results.tsv"
}

finalize_lane_result() {
  lane=$1
  started_at=$2
  resource=$3
  tool_versions=$4
  native_artifact=$5
  retry=$6
  attempt_line=$(tail -n 1 "$RUN_ROOT/$lane/attempts.tsv")
  attempt_exit=$(printf '%s\n' "$attempt_line" | cut -f2)
  cleanup_status=$(printf '%s\n' "$attempt_line" | cut -f4)
  result_status=passed
  classification=none
  if [ "$attempt_exit" -ne 0 ] || [ "$cleanup_status" != passed ]; then
    result_status=failed
    if [ "$cleanup_status" != passed ]; then
      classification=cleanup
    else
      test -s "$RUN_ROOT/$lane/classification.txt"
      classification=$(sed -n '1p' "$RUN_ROOT/$lane/classification.txt")
      case "$classification" in
        bootstrap/environment|cluster-setup|dawn-behavior|cleanup) ;;
        *) echo "invalid failure classification: $classification" >&2; return 64 ;;
      esac
    fi
  fi
  record_result "$lane" "$result_status" "$started_at" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$attempt_exit" "$classification" \
    "$resource" "$tool_versions" "$native_artifact" "$cleanup_status" "$retry"
}

cluster_exists() {
  kind get clusters 2>/dev/null | grep -Fxq -- "$1"
}

capture_kubernetes_diagnostics() {
  lane=$1
  cluster=$2
  context="kind-$cluster"
  output="$RUN_ROOT/$lane/diagnostics.log"
  {
    echo '----- nodes -----'
    kubectl --context "$context" get nodes -o wide || true
    echo '----- pods -----'
    kubectl --context "$context" get pods -A -o wide || true
    echo '----- warning events (last 200) -----'
    kubectl --context "$context" get events -A --field-selector type=Warning \
      --sort-by=.metadata.creationTimestamp 2>/dev/null | tail -n 200 || true
    echo '----- storage classes -----'
    kubectl --context "$context" get storageclass -o wide || true
    echo '----- calico -----'
    kubectl --context "$context" -n kube-system \
      get daemonset/calico-node deployment/calico-kube-controllers -o wide || true
    kubectl --context "$context" -n kube-system \
      describe daemonset/calico-node deployment/calico-kube-controllers \
      | sed -n '1,500p' || true
    echo '----- helm -----'
    helm --kube-context "$context" list -A || true
    echo '----- app -----'
    kubectl --context "$context" -n dawn-app get pods,svc -o wide || true
    kubectl --context "$context" -n dawn-app describe pods | sed -n '1,500p' || true
    kubectl --context "$context" -n dawn-app logs deploy/dawn-app --all-containers --tail=200 || true
    kubectl --context "$context" -n dawn-app logs deploy/aimock --all-containers --tail=100 || true
    echo '----- sandboxes -----'
    kubectl --context "$context" -n dawn-sandboxes get pods,pvc,networkpolicy -o wide || true
    kubectl --context "$context" -n dawn-sandboxes describe pods,pvc \
      | sed -n '1,500p' || true
    echo '----- control-plane logs (last 200) -----'
    docker logs "${cluster}-control-plane" --tail=200 || true
  } > "$output" 2>&1
}

delete_exact_cluster() {
  cluster=$1
  kind delete cluster --name "$cluster"
  ! cluster_exists "$cluster"
}

create_owned_cluster() {
  if cluster_exists "$cluster"; then
    echo "refusing pre-existing cluster: $cluster" >&2
    return 73
  fi
  set +e
  kind create cluster --name "$cluster" "$@" >> "$RUN_ROOT/$lane/run.log" 2>&1
  create_status=$?
  set -e
  if cluster_exists "$cluster"; then
    cluster_owned=1
  fi
  return "$create_status"
}
```

Run every Kubernetes attempt inside a fresh Bash subshell. Define lane-specific `cleanup_workloads` as a no-op except in Task 7, where it uninstalls the two exact releases and requests deletion of the two exact namespaces. Wrap each lane body with this lifecycle; the body calls `create_owned_cluster`, never raw `kind create cluster`:

```bash
set +e
(
  set -Eeuo pipefail
  cluster_owned=0
  REG_PID=
  signal_name=none
  cleanup_workloads() { :; }

  on_lane_signal() {
    signal_name=$1
    case "$signal_name" in
      HUP) exit 129 ;;
      INT) exit 130 ;;
      TERM) exit 143 ;;
    esac
  }

  on_lane_exit() {
    status=$?
    trap - EXIT HUP INT TERM
    set +e
    if [ "$status" -ne 0 ] && [ "$cluster_owned" = 1 ]; then
      capture_kubernetes_diagnostics "$lane" "$cluster"
    fi
    if [ -n "${REG_PID:-}" ]; then
      kill "$REG_PID" 2>/dev/null || true
      wait "$REG_PID" 2>/dev/null || true
    fi
    cleanup_status=passed
    cleanup_workloads || cleanup_status=failed
    if [ "$cluster_owned" = 1 ]; then
      delete_exact_cluster "$cluster" || cleanup_status=failed
    fi
    if [ "$cleanup_status" = failed ]; then
      status=1
    fi
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "${attempt_id:-attempt0}" "$status" "$signal_name" "$cleanup_status" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$RUN_ROOT/$lane/attempts.tsv"
    exit "$status"
  }

  trap 'on_lane_signal HUP' HUP
  trap 'on_lane_signal INT' INT
  trap 'on_lane_signal TERM' TERM
  trap on_lane_exit EXIT

  # Run the lane-specific commands from Tasks 3-7 here.
)
lane_exit=$?
set -e
```

Before entering the subshell, create `"$RUN_ROOT/$lane"`, initialize `attempts.tsv` with `attempt`, `exit_code`, `signal`, `cleanup`, and `finished_at` columns, record `started_at`, and require the exact cluster name to be absent. `create_owned_cluster` sets ownership only when a previously absent exact name is observed after the create attempt, including a partially failed create. Diagnostics therefore precede process, workload, namespace, and cluster cleanup on every nonzero exit or handled signal. Never delete a cluster selected by prefix or one present in `kind-clusters.before.txt`.

No commit: all Task 2 outputs are ignored or temporary.

Keep this working shell open for Tasks 3-8. Each task nevertheless re-derives every shell variable from `active-run-id`, `tool-root.txt`, and policy before use, and verifies that `record_result`, `finalize_lane_result`, `cluster_exists`, `capture_kubernetes_diagnostics`, `delete_exact_cluster`, and `create_owned_cluster` remain defined. If the shell is lost, re-evaluate this exact Step 5 function block; do not write a tracked runner.

### Task 3: Run Lane 1 - Chart Apply Smoke On Kubernetes 1.35

**Files:**
- Read: `.github/workflows/ci.yml`
- Read: `.github/kubernetes-compatibility.json`
- Record ignored: `artifacts/testing/dedicated-infrastructure/$RUN_ID/chart-apply-1.35/**`

- [ ] **Step 1: Create a unique default-CNI cluster**

Run Steps 1-2 as the body of Task 2's Bash lifecycle subshell so `EXIT`, `HUP`, `INT`, and `TERM` all capture bounded diagnostics before deleting only the observed exact cluster.

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
NODE24_BIN=/Users/blove/.nvm/versions/node/v24.19.0/bin
STATE_ROOT="$PWD/artifacts/testing/dedicated-infrastructure"
RUN_ID="$(cat "$STATE_ROOT/active-run-id")"
RUN_ROOT="$STATE_ROOT/$RUN_ID"
RUN_TOKEN="${RUN_ID##*-}"
TOOL_ROOT="$(cat "$RUN_ROOT/tool-root.txt")"
export KUBECONFIG="$TOOL_ROOT/kubeconfig"
export PATH="$TOOL_ROOT:$NODE24_BIN:$PATH"
POLICY_KIND="$(jq -er '.toolchain.kind' .github/kubernetes-compatibility.json)"
POLICY_KUBECTL="$(jq -er '.toolchain.kubectl' .github/kubernetes-compatibility.json)"
POLICY_HELM="$(jq -er '.toolchain.helm' .github/kubernetes-compatibility.json)"
IMAGE_135="$(jq -er '.targets[] | select(.minor == "1.35") | .nodeImage' .github/kubernetes-compatibility.json)"
VERSION_135="$(jq -er '.targets[] | select(.minor == "1.35") | .version' .github/kubernetes-compatibility.json)"
test "$(node --version)" = v24.19.0
test "$(kind version | awk '{print $2}')" = "$POLICY_KIND"
test "$(helm version --short | cut -d+ -f1)" = "$POLICY_HELM"
type record_result finalize_lane_result cluster_exists \
  capture_kubernetes_diagnostics delete_exact_cluster create_owned_cluster >/dev/null
retry_state=none
lane=chart-apply-1.35
cluster="dawn-local-${RUN_TOKEN}-chart-135"
context="kind-$cluster"
mkdir -p "$RUN_ROOT/$lane"
printf 'attempt\texit_code\tsignal\tcleanup\tfinished_at\n' > "$RUN_ROOT/$lane/attempts.tsv"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
! cluster_exists "$cluster"
create_owned_cluster --image "$IMAGE_135" --wait 180s
test "$(kubectl config current-context)" = "$context"
kubectl --context "$context" wait --for=condition=Ready nodes --all --timeout=180s
```

Expected GREEN: the exact context is current in the temporary kubeconfig and the 1.35 node is Ready. A create/image/readiness failure is setup-classified and may receive the one clean retry defined by the shared retry contract, using a new cluster name.

- [ ] **Step 2: Install the digest-pinned placeholder and prove Service reachability**

```bash
PLACEHOLDER_IMAGE="$(jq -er '.images.placeholderApp' .github/kubernetes-compatibility.json)"
REACHABILITY_IMAGE="$(jq -er '.images.reachabilityProbe' .github/kubernetes-compatibility.json)"
PLACEHOLDER_WITH_TAG="${PLACEHOLDER_IMAGE%@sha256:*}"
PLACEHOLDER_REPOSITORY="${PLACEHOLDER_WITH_TAG%:*}"
PLACEHOLDER_DIGEST="sha256:${PLACEHOLDER_IMAGE##*@sha256:}"
printf '%s\n' "$PLACEHOLDER_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'
printf '%s\n' "$REACHABILITY_IMAGE" | grep -Eq '@sha256:[0-9a-f]{64}$'
helm --kube-context "$context" install dawn-app charts/dawn-app \
  --set-string image.repository="$PLACEHOLDER_REPOSITORY" \
  --set-string image.digest="$PLACEHOLDER_DIGEST" \
  --set containerPort=8080 --set healthPath=/ \
  --set serviceAccount.create=true --set serviceAccount.name=dawn-app-smoke \
  --wait --timeout 3m
kubectl --context "$context" rollout status deploy/dawn-app --timeout=120s
kubectl --context "$context" run curl --image="$REACHABILITY_IMAGE" \
  --restart=Never --rm -i --quiet -- \
  curl -sf http://dawn-app.default.svc.cluster.local/ >/dev/null
printf 'app served OK\n'
```

Expected GREEN: Helm exits zero, rollout succeeds, and output contains `app served OK`. Any assertion failure is a Dawn-behavior failure and receives no blind retry.

- [ ] **Step 3: Record evidence, then delete only the exact cluster**

On success, append `helm list -A` and `kubectl version --output=yaml | sed -n '1,120p'` to `run.log`, then leave the lane body. The lifecycle trap diagnoses failures first and deletes only the owned exact cluster. Outside the subshell, classify any nonzero attempt before finalization, then record the real attempt rather than hardcoding success:

```bash
finalize_lane_result "$lane" "$started_at" "$cluster" \
  "node=$(node --version),kind=$POLICY_KIND,kubectl=$POLICY_KUBECTL,helm=$POLICY_HELM,k8s=$VERSION_135" \
  "$RUN_ROOT/$lane/run.log" "$retry_state"
```

Expected: `cluster_exists "$cluster"` is false and the row reflects the real attempt/cleanup result. Apply the same final-row pattern to all later lanes. No commit.

### Task 4: Run Lane 2 - Focused Compatibility On Kubernetes 1.35

**Files:**
- Read: `.github/workflows/ci.yml`
- Read: `.github/kind/kind-calico.yaml`
- Execute: `scripts/kubernetes-compat/**`
- Record ignored: `artifacts/testing/dedicated-infrastructure/$RUN_ID/focused-1.35/**`
- Record native ignored: `artifacts/testing/kubernetes-compat/kubernetes-compat-1-35-*.json`

- [ ] **Step 1: Run the lane-specific chart-RBAC prerequisite**

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
NODE24_BIN=/Users/blove/.nvm/versions/node/v24.19.0/bin
STATE_ROOT="$PWD/artifacts/testing/dedicated-infrastructure"
RUN_ID="$(cat "$STATE_ROOT/active-run-id")"
RUN_ROOT="$STATE_ROOT/$RUN_ID"
RUN_TOKEN="${RUN_ID##*-}"
TOOL_ROOT="$(cat "$RUN_ROOT/tool-root.txt")"
export KUBECONFIG="$TOOL_ROOT/kubeconfig"
export PATH="$TOOL_ROOT:$NODE24_BIN:$PATH"
POLICY_KIND="$(jq -er '.toolchain.kind' .github/kubernetes-compatibility.json)"
POLICY_KUBECTL="$(jq -er '.toolchain.kubectl' .github/kubernetes-compatibility.json)"
POLICY_HELM="$(jq -er '.toolchain.helm' .github/kubernetes-compatibility.json)"
IMAGE_135="$(jq -er '.targets[] | select(.minor == "1.35") | .nodeImage' .github/kubernetes-compatibility.json)"
VERSION_135="$(jq -er '.targets[] | select(.minor == "1.35") | .version' .github/kubernetes-compatibility.json)"
test "$(node --version)" = v24.19.0
type finalize_lane_result cluster_exists capture_kubernetes_diagnostics \
  delete_exact_cluster create_owned_cluster >/dev/null
retry_state=none
DAWN_REQUIRE_HELM=1 pnpm exec vitest --run \
  --config test/k8s-compat/vitest.config.ts chart-rbac
```

Expected GREEN: the chart/provider permission parity test passes without skipping. A reproducible failure is a shared prerequisite failure for focused/Kubernetes E2E lanes, but it does not block chart apply or Docker E2E.

- [ ] **Step 2: Create a unique no-CNI 1.35 cluster and install verified Calico**

```bash
lane=focused-1.35
cluster="dawn-local-${RUN_TOKEN}-focused-135"
context="kind-$cluster"
manifest="$TOOL_ROOT/calico-$cluster.yaml"
mkdir -p "$RUN_ROOT/$lane"
printf 'attempt\texit_code\tsignal\tcleanup\tfinished_at\n' > "$RUN_ROOT/$lane/attempts.tsv"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
! cluster_exists "$cluster"
create_owned_cluster --image "$IMAGE_135" \
  --config .github/kind/kind-calico.yaml --wait 180s
pnpm exec tsx scripts/kubernetes-compat/workflow.ts prepare-calico --output "$manifest"
kubectl --context "$context" apply --filename "$manifest"
kubectl --context "$context" -n kube-system rollout status daemonset/calico-node --timeout=180s
kubectl --context "$context" wait --for=condition=Ready nodes --all --timeout=180s
```

Expected GREEN: Calico preparation verifies the checked-in raw checksum and image occurrence map; the daemonset rolls out and the node becomes Ready. Never apply the remote URL directly.

- [ ] **Step 3: Run the canonical harness and capture its native report path**

```bash
marker="$RUN_ROOT/$lane/harness-start"
touch "$marker"
pnpm verify:k8s:compat -- --target 1.35 --context "$context" \
  >> "$RUN_ROOT/$lane/run.log" 2>&1
find artifacts/testing/kubernetes-compat -type f \
  -name 'kubernetes-compat-1-35-*.json' -newer "$marker" -print \
  | LC_ALL=C sort > "$RUN_ROOT/$lane/native-artifacts.txt"
test "$(wc -l < "$RUN_ROOT/$lane/native-artifacts.txt" | tr -d ' ')" = 1
jq -e '.target == "1.35" and .cleanup.status == "passed" and ([.steps[].status] | all(. == "passed"))' \
  "$(sed -n '1p' "$RUN_ROOT/$lane/native-artifacts.txt")"
```

Expected GREEN: one redacted JSON report records target 1.35, every stable step passes, and cleanup passes. The harness cleans its exact owned namespaces; the outer lane still owns only the exact Kind cluster.

- [ ] **Step 4: Record and clean up**

Run Steps 2-3 inside Task 2's diagnostics-first Bash lifecycle. It deletes only `dawn-local-${RUN_TOKEN}-focused-135`; on a signal or nonzero exit it writes bounded diagnostics first. After classification and any permitted single clean setup retry, finalize exactly once:

```bash
native_artifact="$(sed -n '1p' "$RUN_ROOT/$lane/native-artifacts.txt" 2>/dev/null || true)"
test -n "$native_artifact" || native_artifact=none
finalize_lane_result "$lane" "$started_at" "$cluster" \
  "node=$(node --version),kind=$POLICY_KIND,kubectl=$POLICY_KUBECTL,helm=$POLICY_HELM,k8s=$VERSION_135" \
  "$native_artifact" "$retry_state"
```

Expected: one lane row, passed exact-cluster cleanup, and either one passing native report or a classified bounded failure. No commit.

### Task 5: Run Lane 3 - Focused Compatibility On Kubernetes 1.34

**Files:**
- Read: `.github/workflows/kubernetes-compat.yml`
- Execute: `scripts/kubernetes-compat/**`
- Record ignored: `artifacts/testing/dedicated-infrastructure/$RUN_ID/focused-1.34/**`
- Record native ignored: `artifacts/testing/kubernetes-compat/kubernetes-compat-1-34-*.json`

- [ ] **Step 1: Repeat the exact focused prerequisites with the lower pin**

Run `chart-rbac` again because it is a prerequisite of this workflow lane, re-derive every value in this task, then place the cluster/Calico/harness commands inside Task 2's diagnostics-first Bash lifecycle:

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
NODE24_BIN=/Users/blove/.nvm/versions/node/v24.19.0/bin
STATE_ROOT="$PWD/artifacts/testing/dedicated-infrastructure"
RUN_ID="$(cat "$STATE_ROOT/active-run-id")"
RUN_ROOT="$STATE_ROOT/$RUN_ID"
RUN_TOKEN="${RUN_ID##*-}"
TOOL_ROOT="$(cat "$RUN_ROOT/tool-root.txt")"
export KUBECONFIG="$TOOL_ROOT/kubeconfig"
export PATH="$TOOL_ROOT:$NODE24_BIN:$PATH"
POLICY_KIND="$(jq -er '.toolchain.kind' .github/kubernetes-compatibility.json)"
POLICY_KUBECTL="$(jq -er '.toolchain.kubectl' .github/kubernetes-compatibility.json)"
POLICY_HELM="$(jq -er '.toolchain.helm' .github/kubernetes-compatibility.json)"
IMAGE_134="$(jq -er '.targets[] | select(.minor == "1.34") | .nodeImage' .github/kubernetes-compatibility.json)"
VERSION_134="$(jq -er '.targets[] | select(.minor == "1.34") | .version' .github/kubernetes-compatibility.json)"
test "$(node --version)" = v24.19.0
type finalize_lane_result cluster_exists capture_kubernetes_diagnostics \
  delete_exact_cluster create_owned_cluster >/dev/null
retry_state=none
DAWN_REQUIRE_HELM=1 pnpm exec vitest --run \
  --config test/k8s-compat/vitest.config.ts chart-rbac
lane=focused-1.34
cluster="dawn-local-${RUN_TOKEN}-focused-134"
context="kind-$cluster"
manifest="$TOOL_ROOT/calico-$cluster.yaml"
mkdir -p "$RUN_ROOT/$lane"
printf 'attempt\texit_code\tsignal\tcleanup\tfinished_at\n' > "$RUN_ROOT/$lane/attempts.tsv"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
! cluster_exists "$cluster"
create_owned_cluster --image "$IMAGE_134" \
  --config .github/kind/kind-calico.yaml --wait 180s
pnpm exec tsx scripts/kubernetes-compat/workflow.ts prepare-calico --output "$manifest"
kubectl --context "$context" apply --filename "$manifest"
kubectl --context "$context" -n kube-system rollout status daemonset/calico-node --timeout=180s
kubectl --context "$context" wait --for=condition=Ready nodes --all --timeout=180s
```

- [ ] **Step 2: Run target 1.34 and verify exact report accounting**

```bash
marker="$RUN_ROOT/$lane/harness-start"
touch "$marker"
pnpm verify:k8s:compat -- --target 1.34 --context "$context" \
  >> "$RUN_ROOT/$lane/run.log" 2>&1
find artifacts/testing/kubernetes-compat -type f \
  -name 'kubernetes-compat-1-34-*.json' -newer "$marker" -print \
  | LC_ALL=C sort > "$RUN_ROOT/$lane/native-artifacts.txt"
test "$(wc -l < "$RUN_ROOT/$lane/native-artifacts.txt" | tr -d ' ')" = 1
jq -e '.target == "1.34" and .cleanup.status == "passed" and ([.steps[].status] | all(. == "passed"))' \
  "$(sed -n '1p' "$RUN_ROOT/$lane/native-artifacts.txt")"
```

Expected GREEN: exact 1.34 server preflight, complete stable-ID accounting, no skipped provider tests, and passed cleanup.

- [ ] **Step 3: Record and clean up without inheriting 1.35 failure state**

Leave diagnostics and exact 1.34 cluster deletion to the lane trap. Run this lane even when Lane 2 had a version-specific 1.35 failure. Block it only for a confirmed shared prerequisite such as a reproducible Calico checksum or chart-RBAC failure, and still write a `blocked` row naming that prerequisite. Otherwise finalize exactly once:

```bash
native_artifact="$(sed -n '1p' "$RUN_ROOT/$lane/native-artifacts.txt" 2>/dev/null || true)"
test -n "$native_artifact" || native_artifact=none
finalize_lane_result "$lane" "$started_at" "$cluster" \
  "node=$(node --version),kind=$POLICY_KIND,kubectl=$POLICY_KUBECTL,helm=$POLICY_HELM,k8s=$VERSION_134" \
  "$native_artifact" "$retry_state"
```

Expected: one independent 1.34 result row and confirmed absence of the exact cluster. No commit.

### Task 6: Run Lane 4 - Focused Compatibility On Kubernetes 1.36

**Files:**
- Read: `.github/workflows/kubernetes-compat.yml`
- Execute: `scripts/kubernetes-compat/**`
- Record ignored: `artifacts/testing/dedicated-infrastructure/$RUN_ID/focused-1.36/**`
- Record native ignored: `artifacts/testing/kubernetes-compat/kubernetes-compat-1-36-*.json`

- [ ] **Step 1: Repeat the exact focused prerequisites with the upper pin**

Run `chart-rbac` again, re-derive every value in this task, then place the cluster/Calico/harness commands inside Task 2's diagnostics-first Bash lifecycle:

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
NODE24_BIN=/Users/blove/.nvm/versions/node/v24.19.0/bin
STATE_ROOT="$PWD/artifacts/testing/dedicated-infrastructure"
RUN_ID="$(cat "$STATE_ROOT/active-run-id")"
RUN_ROOT="$STATE_ROOT/$RUN_ID"
RUN_TOKEN="${RUN_ID##*-}"
TOOL_ROOT="$(cat "$RUN_ROOT/tool-root.txt")"
export KUBECONFIG="$TOOL_ROOT/kubeconfig"
export PATH="$TOOL_ROOT:$NODE24_BIN:$PATH"
POLICY_KIND="$(jq -er '.toolchain.kind' .github/kubernetes-compatibility.json)"
POLICY_KUBECTL="$(jq -er '.toolchain.kubectl' .github/kubernetes-compatibility.json)"
POLICY_HELM="$(jq -er '.toolchain.helm' .github/kubernetes-compatibility.json)"
IMAGE_136="$(jq -er '.targets[] | select(.minor == "1.36") | .nodeImage' .github/kubernetes-compatibility.json)"
VERSION_136="$(jq -er '.targets[] | select(.minor == "1.36") | .version' .github/kubernetes-compatibility.json)"
test "$(node --version)" = v24.19.0
type finalize_lane_result cluster_exists capture_kubernetes_diagnostics \
  delete_exact_cluster create_owned_cluster >/dev/null
retry_state=none
DAWN_REQUIRE_HELM=1 pnpm exec vitest --run \
  --config test/k8s-compat/vitest.config.ts chart-rbac
lane=focused-1.36
cluster="dawn-local-${RUN_TOKEN}-focused-136"
context="kind-$cluster"
manifest="$TOOL_ROOT/calico-$cluster.yaml"
mkdir -p "$RUN_ROOT/$lane"
printf 'attempt\texit_code\tsignal\tcleanup\tfinished_at\n' > "$RUN_ROOT/$lane/attempts.tsv"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
! cluster_exists "$cluster"
create_owned_cluster --image "$IMAGE_136" \
  --config .github/kind/kind-calico.yaml --wait 180s
pnpm exec tsx scripts/kubernetes-compat/workflow.ts prepare-calico --output "$manifest"
kubectl --context "$context" apply --filename "$manifest"
kubectl --context "$context" -n kube-system rollout status daemonset/calico-node --timeout=180s
kubectl --context "$context" wait --for=condition=Ready nodes --all --timeout=180s
```

- [ ] **Step 2: Run target 1.36 and verify exact report accounting**

```bash
marker="$RUN_ROOT/$lane/harness-start"
touch "$marker"
pnpm verify:k8s:compat -- --target 1.36 --context "$context" \
  >> "$RUN_ROOT/$lane/run.log" 2>&1
find artifacts/testing/kubernetes-compat -type f \
  -name 'kubernetes-compat-1-36-*.json' -newer "$marker" -print \
  | LC_ALL=C sort > "$RUN_ROOT/$lane/native-artifacts.txt"
test "$(wc -l < "$RUN_ROOT/$lane/native-artifacts.txt" | tr -d ' ')" = 1
jq -e '.target == "1.36" and .cleanup.status == "passed" and ([.steps[].status] | all(. == "passed"))' \
  "$(sed -n '1p' "$RUN_ROOT/$lane/native-artifacts.txt")"
```

Expected GREEN: exact 1.36 server preflight, complete stable-ID accounting, no skips, and passed cleanup.

- [ ] **Step 3: Record and clean up independently**

Leave diagnostics and exact 1.36 cluster deletion to the lane trap. Run this lane despite version-specific failures in 1.34 or 1.35, then finalize exactly once:

```bash
native_artifact="$(sed -n '1p' "$RUN_ROOT/$lane/native-artifacts.txt" 2>/dev/null || true)"
test -n "$native_artifact" || native_artifact=none
finalize_lane_result "$lane" "$started_at" "$cluster" \
  "node=$(node --version),kind=$POLICY_KIND,kubectl=$POLICY_KUBECTL,helm=$POLICY_HELM,k8s=$VERSION_136" \
  "$native_artifact" "$retry_state"
```

Expected: one independent 1.36 result row and confirmed absence of the exact cluster. No commit.

### Task 7: Run Lane 5 - Packaged Kubernetes E2E On Kubernetes 1.35

**Files:**
- Read: `.github/workflows/ci.yml`
- Execute: `test/k8s-smoke/build-image.sh`
- Execute: `test/k8s-smoke/assert-k8s.sh`
- Read: `test/k8s-smoke/aimock.k8s.yaml`
- Read: `test/k8s-smoke/values-dawn-app.yaml`
- Read: `test/k8s-smoke/values-sandbox-infra.yaml`
- Record ignored: `artifacts/testing/dedicated-infrastructure/$RUN_ID/kubernetes-e2e-1.35/**`

- [ ] **Step 1: Run build and chart-RBAC prerequisites before cluster mutation**

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
NODE24_BIN=/Users/blove/.nvm/versions/node/v24.19.0/bin
STATE_ROOT="$PWD/artifacts/testing/dedicated-infrastructure"
RUN_ID="$(cat "$STATE_ROOT/active-run-id")"
RUN_ROOT="$STATE_ROOT/$RUN_ID"
RUN_TOKEN="${RUN_ID##*-}"
TOOL_ROOT="$(cat "$RUN_ROOT/tool-root.txt")"
export KUBECONFIG="$TOOL_ROOT/kubeconfig"
export PATH="$TOOL_ROOT:$NODE24_BIN:$PATH"
export DAWN_TEST_SMOKE_E2E=1
POLICY_KIND="$(jq -er '.toolchain.kind' .github/kubernetes-compatibility.json)"
POLICY_KUBECTL="$(jq -er '.toolchain.kubectl' .github/kubernetes-compatibility.json)"
POLICY_HELM="$(jq -er '.toolchain.helm' .github/kubernetes-compatibility.json)"
IMAGE_135="$(jq -er '.targets[] | select(.minor == "1.35") | .nodeImage' .github/kubernetes-compatibility.json)"
VERSION_135="$(jq -er '.targets[] | select(.minor == "1.35") | .version' .github/kubernetes-compatibility.json)"
test "$(node --version)" = v24.19.0
type finalize_lane_result cluster_exists capture_kubernetes_diagnostics \
  delete_exact_cluster create_owned_cluster >/dev/null
retry_state=none
pnpm build
DAWN_REQUIRE_HELM=1 pnpm exec vitest --run \
  --config test/k8s-compat/vitest.config.ts chart-rbac
```

Expected GREEN: the full workspace builds so every package published to Verdaccio has current `dist/`, and chart/provider parity passes. A reproducible build failure is shared only with the packaged E2E lanes; it does not block the already-independent endpoint records.

- [ ] **Step 2: Create the unique canonical cluster and install verified Calico**

```bash
lane=kubernetes-e2e-1.35
cluster="dawn-local-${RUN_TOKEN}-e2e-135"
context="kind-$cluster"
manifest="$TOOL_ROOT/calico-$cluster.yaml"
mkdir -p "$RUN_ROOT/$lane"
printf 'attempt\texit_code\tsignal\tcleanup\tfinished_at\n' > "$RUN_ROOT/$lane/attempts.tsv"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export KIND_CLUSTER="$cluster"
export DAWN_TEST_K8S_CONTEXT="$context"
! cluster_exists "$cluster"
cleanup_workloads() {
  [ "$cluster_owned" = 1 ] || return 0
  cleanup_failed=0
  if helm --kube-context "$context" -n dawn-app status dawn-app >/dev/null 2>&1; then
    helm --kube-context "$context" -n dawn-app uninstall dawn-app || cleanup_failed=1
  fi
  if helm --kube-context "$context" -n dawn-sandboxes status dawn-sandbox-infra >/dev/null 2>&1; then
    helm --kube-context "$context" -n dawn-sandboxes uninstall dawn-sandbox-infra || cleanup_failed=1
  fi
  kubectl --context "$context" delete namespace dawn-app dawn-sandboxes \
    --ignore-not-found=true --wait=false || cleanup_failed=1
  return "$cleanup_failed"
}
create_owned_cluster --image "$IMAGE_135" \
  --config .github/kind/kind-calico.yaml --wait 180s
pnpm exec tsx scripts/kubernetes-compat/workflow.ts prepare-calico --output "$manifest"
kubectl --context "$context" apply --filename "$manifest"
kubectl --context "$context" -n kube-system rollout status daemonset/calico-node --timeout=180s
kubectl --context "$context" wait --for=condition=Ready nodes --all --timeout=180s
```

- [ ] **Step 3: Preload the policy sandbox image**

```bash
SANDBOX_IMAGE="$(pnpm exec tsx -e 'import { loadCompatibilityPolicy } from "./scripts/kubernetes-compat/policy.ts"; loadCompatibilityPolicy().then((policy) => process.stdout.write(policy.images.sandboxWorkload))')"
docker pull "$SANDBOX_IMAGE"
kind load docker-image "$SANDBOX_IMAGE" --name "$cluster"
```

Expected GREEN: the digest-pinned sandbox workload is present in Kind before any sandbox Pod starts. An external pull failure is image/bootstrap-classified and may receive one clean retry; never substitute a tag or digest.

- [ ] **Step 4: Build and load the user-facing app and deterministic model images**

```bash
URLFILE="$(mktemp "$TOOL_ROOT/verdaccio-url.XXXXXX")"
pnpm exec tsx test/k8s-smoke/serve-registry.ts "$URLFILE" \
  >> "$RUN_ROOT/$lane/run.log" 2>&1 &
REG_PID=$!
for _ in $(seq 1 180); do
  [ -s "$URLFILE" ] && break
  kill -0 "$REG_PID" 2>/dev/null || exit 1
  sleep 1
done
test -s "$URLFILE"
REG_URL="$(cat "$URLFILE")"
sh test/k8s-smoke/build-image.sh k8s "$REG_URL" \
  >> "$RUN_ROOT/$lane/run.log" 2>&1
kill "$REG_PID" 2>/dev/null || true
wait "$REG_PID" 2>/dev/null || true
unset REG_PID
kind load docker-image dawn-smoke-app:k8s --name "$cluster"
docker build -t dawn-smoke-aimock:latest \
  -f test/k8s-smoke/aimock/Dockerfile test/k8s-smoke \
  >> "$RUN_ROOT/$lane/run.log" 2>&1
kind load docker-image dawn-smoke-aimock:latest --name "$cluster"
```

The lane trap must stop `REG_PID` before cluster cleanup on any exit or signal. Registry startup/build failure is bootstrap/image-classified; inspect the bounded lane log before a single clean retry.

- [ ] **Step 5: Install both charts and run the full Agent Protocol assertion**

```bash
kubectl --context "$context" create namespace dawn-app
helm --kube-context "$context" install dawn-sandbox-infra charts/dawn-sandbox-infra \
  -n dawn-sandboxes --create-namespace \
  -f test/k8s-smoke/values-sandbox-infra.yaml --wait
kubectl --context "$context" apply -f test/k8s-smoke/aimock.k8s.yaml
kubectl --context "$context" -n dawn-app rollout status deploy/aimock --timeout=120s
helm --kube-context "$context" install dawn-app charts/dawn-app \
  -n dawn-app -f test/k8s-smoke/values-dawn-app.yaml --wait
DAWN_TEST_K8S_CONTEXT="$context" sh test/k8s-smoke/assert-k8s.sh \
  >> "$RUN_ROOT/$lane/run.log" 2>&1
```

Expected GREEN: the assertion proves a real non-root sandbox Pod, NetworkPolicy, genuine `runBash` output, and Pod/PVC removal after thread deletion. Any failure after assertion entry is Dawn behavior and gets no blind retry.

- [ ] **Step 6: Diagnose before teardown, record, and delete exact resources**

Run Steps 2-5 inside Task 2's Bash lifecycle. On nonzero exit or signal, the trap first calls `capture_kubernetes_diagnostics`, then runs the exact `cleanup_workloads` override above, and finally deletes the exact Kind cluster. Do not retain this first-pass cluster. After classification and any permitted single clean setup retry, finalize exactly once:

```bash
finalize_lane_result "$lane" "$started_at" "$cluster" \
  "node=$(node --version),kind=$POLICY_KIND,kubectl=$POLICY_KUBECTL,helm=$POLICY_HELM,k8s=$VERSION_135" \
  "$RUN_ROOT/$lane/run.log" "$retry_state"
```

Expected: the packaged app and aimock are built and loaded, both Helm releases become ready, `assert-k8s.sh` passes the real sandbox lifecycle, diagnostics are bounded on failure, and the exact cluster is absent afterward. No commit.

### Task 8: Run Lane 6 - Packaged Docker E2E

**Files:**
- Read: `.github/workflows/ci.yml`
- Execute: `test/k8s-smoke/build-image.sh`
- Execute hardened: `test/k8s-smoke/assert-docker.sh`
- Record ignored: `artifacts/testing/dedicated-infrastructure/$RUN_ID/docker-e2e/**`

- [ ] **Step 1: Run independent Docker prerequisites and rebuild the Docker variant**

Run this lane even if every Kubernetes lane failed for Kubernetes-specific reasons:

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
NODE24_BIN=/Users/blove/.nvm/versions/node/v24.19.0/bin
STATE_ROOT="$PWD/artifacts/testing/dedicated-infrastructure"
RUN_ID="$(cat "$STATE_ROOT/active-run-id")"
RUN_ROOT="$STATE_ROOT/$RUN_ID"
TOOL_ROOT="$(cat "$RUN_ROOT/tool-root.txt")"
export PATH="$TOOL_ROOT:$NODE24_BIN:$PATH"
export DAWN_TEST_SMOKE_E2E=1
POLICY_PNPM="$(jq -er '.toolchain.pnpm' .github/kubernetes-compatibility.json)"
SANDBOX_IMAGE="$(jq -er '.images.sandboxWorkload' .github/kubernetes-compatibility.json)"
test "$(node --version)" = v24.19.0
test "$(pnpm --version)" = "$POLICY_PNPM"
for executable in docker curl jq; do command -v "$executable" >/dev/null; done
docker info >/dev/null
type finalize_lane_result >/dev/null
retry_state=none
lane=docker-e2e
mkdir -p "$RUN_ROOT/$lane"
printf 'attempt\texit_code\tsignal\tcleanup\tfinished_at\n' > "$RUN_ROOT/$lane/attempts.tsv"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
pnpm build
docker pull "$SANDBOX_IMAGE"
URLFILE="$(mktemp "$TOOL_ROOT/verdaccio-url.XXXXXX")"
pnpm exec tsx test/k8s-smoke/serve-registry.ts "$URLFILE" \
  >> "$RUN_ROOT/$lane/run.log" 2>&1 &
REG_PID=$!
for _ in $(seq 1 180); do
  [ -s "$URLFILE" ] && break
  kill -0 "$REG_PID" 2>/dev/null || exit 1
  sleep 1
done
test -s "$URLFILE"
REG_URL="$(cat "$URLFILE")"
sh test/k8s-smoke/build-image.sh docker "$REG_URL" \
  >> "$RUN_ROOT/$lane/run.log" 2>&1
docker build -t dawn-smoke-aimock:latest \
  -f test/k8s-smoke/aimock/Dockerfile test/k8s-smoke \
  >> "$RUN_ROOT/$lane/run.log" 2>&1
kill "$REG_PID" 2>/dev/null || true
wait "$REG_PID" 2>/dev/null || true
unset REG_PID
```

Expected GREEN: the Docker app variant contains the static Docker CLI and both local images exist. Build/image failures are eligible for at most one clean retry after exact preflight.

Wrap Steps 1-2 in a Bash subshell with this outer signal/finally guard. It stops only the registry process started by this task; `assert-docker.sh` remains the sole owner and remover of app, mock, network, sandbox-container, and sandbox-volume resources:

```bash
REG_PID=
signal_name=none
on_docker_lane_signal() {
  signal_name=$1
  case "$signal_name" in HUP) exit 129 ;; INT) exit 130 ;; TERM) exit 143 ;; esac
}
on_docker_lane_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  cleanup_status=passed
  if docker container inspect dawn-smoke-app >/dev/null 2>&1 \
    || docker container inspect dawn-smoke-aimock >/dev/null 2>&1 \
    || docker network inspect dawn-smoke-net >/dev/null 2>&1 \
    || [ -n "$(docker ps -a --format '{{.Names}}' | awk 'index($0, "dawn-sbx-") == 1')" ] \
    || [ -n "$(docker volume ls -q | awk 'index($0, "dawn-sbx-vol-") == 1')" ]; then
    cleanup_status=failed
    status=1
  fi
  if [ "$status" -ne 0 ]; then
    {
      echo '----- exact smoke containers -----'
      docker ps -a --filter name='^dawn-smoke-app$' --filter name='^dawn-smoke-aimock$' \
        --format '{{.ID}} {{.Names}} {{.Status}}' | sed -n '1,20p' || true
      echo '----- sandbox names (first 50) -----'
      docker ps -a --format '{{.Names}}' | awk 'index($0, "dawn-sbx-") == 1' \
        | sed -n '1,50p' || true
      docker volume ls -q | awk 'index($0, "dawn-sbx-vol-") == 1' \
        | sed -n '1,50p' || true
      echo '----- bounded logs -----'
      docker logs dawn-smoke-app --tail=150 || true
      docker logs dawn-smoke-aimock --tail=60 || true
    } > "$RUN_ROOT/$lane/diagnostics.log" 2>&1
  fi
  if [ -n "${REG_PID:-}" ]; then
    kill "$REG_PID" 2>/dev/null || true
    wait "$REG_PID" 2>/dev/null || true
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "${attempt_id:-attempt0}" "$status" "$signal_name" "$cleanup_status" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$RUN_ROOT/$lane/attempts.tsv"
  exit "$status"
}
trap 'on_docker_lane_signal HUP' HUP
trap 'on_docker_lane_signal INT' INT
trap 'on_docker_lane_signal TERM' TERM
trap on_docker_lane_exit EXIT
```

- [ ] **Step 2: Establish exclusive preflight and run only the hardened local path**

The script itself must reject fixed-name or sandbox-prefix occupancy. Ensure no concurrent Dawn sandbox work is running, then:

```bash
test -z "$(docker ps -a --format '{{.Names}}' | awk '$0 == "dawn-smoke-app" || $0 == "dawn-smoke-aimock" || index($0, "dawn-sbx-") == 1')"
test -z "$(docker volume ls -q | awk 'index($0, "dawn-sbx-vol-") == 1')"
test -z "$(docker network ls --format '{{.Name}}' | awk '$0 == "dawn-smoke-net"')"
set +e
sh test/k8s-smoke/assert-docker.sh >> "$RUN_ROOT/$lane/run.log" 2>&1
lane_status=$?
set -e
[ "$lane_status" -eq 0 ] || exit "$lane_status"
```

Do **not** execute or copy `.github/workflows/ci.yml`'s hosted `Diagnostics + cleanup` block. In particular, the local path must never run either of these prefix-wide loops:

```sh
for c in $(docker ps -aq --filter name=dawn-sbx-); do docker rm -f "$c"; done
for v in $(docker volume ls -q --filter name=dawn-sbx-); do docker volume rm "$v"; done
```

The hardened script is solely responsible for diagnostics-first, exact run-owned cleanup. An assertion failure invokes systematic debugging and TDD before any clean rerun; never invent a fix from the live symptom.

- [ ] **Step 3: Perform a read-only cleanup audit and record the result**

```bash
! docker container inspect dawn-smoke-app >/dev/null 2>&1
! docker container inspect dawn-smoke-aimock >/dev/null 2>&1
! docker network inspect dawn-smoke-net >/dev/null 2>&1
test -z "$(docker ps -a --format '{{.Names}}' | awk 'index($0, "dawn-sbx-") == 1')"
test -z "$(docker volume ls -q | awk 'index($0, "dawn-sbx-vol-") == 1')"
```

Expected GREEN: the script prints `sandbox-docker-e2e assertions PASSED`, and all exact/prefix namespace reads are empty. If cleanup failed, record `cleanup` classification and exact diagnostics; do not repair it with a prefix delete. Record `run.log`, versions, exit status, classification, cleanup status, and retry status in `results.tsv`. No commit.

```bash
finalize_lane_result "$lane" "$started_at" docker-daemon \
  "node=$(node --version),pnpm=$POLICY_PNPM,docker=$(docker version --format '{{.Server.Version}}'),arch=$(docker version --format '{{.Server.Arch}}')" \
  "$RUN_ROOT/$lane/run.log" "$retry_state"
```

### Task 9: Run Final Evidence, Cleanup, And Repository Verification

**Files:**
- Verify: all intentional tracked changes
- Verify ignored: `artifacts/testing/dedicated-infrastructure/$RUN_ID/results.tsv`
- Delete temporary: `TOOL_ROOT` including kubeconfig, downloaded binaries, checksums, Calico files, and registry URL files

- [ ] **Step 1: Re-run focused checks for the confirmed Docker fix and any evidence-driven fix**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts assert-docker-smoke
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec tsc -p test/k8s-compat/tsconfig.json --noEmit
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec biome check --config-path packages/config-biome/biome.json \
    test/k8s-compat/assert-docker-smoke.test.ts
sh -n test/k8s-smoke/assert-docker.sh
```

Also rerun every exact RED/GREEN command introduced for an evidence-proven live defect, then rerun each affected live lane and downstream lane from a clean environment.

- [ ] **Step 2: Require six complete evidence rows**

```bash
test "$(($(wc -l < "$RUN_ROOT/results.tsv") - 1))" -eq 6
cut -f1 "$RUN_ROOT/results.tsv" | tail -n +2 > "$RUN_ROOT/result-order.txt"
printf '%s\n' \
  chart-apply-1.35 \
  focused-1.35 \
  focused-1.34 \
  focused-1.36 \
  kubernetes-e2e-1.35 \
  docker-e2e \
  | cmp -s - "$RUN_ROOT/result-order.txt"
```

Expected: exactly six rows in exact order. Every feasible lane is `passed`; any `blocked` row names a confirmed shared prerequisite and any host-specific failure names the hosted equivalent still required.

- [ ] **Step 3: Run the repository Definition of Done under Node 24**

```bash
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm ci:validate
git diff --check
```

Expected GREEN: all repository checks pass. This is local validation only; do not dispatch or inspect hosted workflows as part of this task.

- [ ] **Step 4: Audit exact cleanup against the captured baseline**

```bash
kind get clusters | LC_ALL=C sort > "$RUN_ROOT/kind-clusters.after.txt"
cmp -s "$RUN_ROOT/kind-clusters.before.txt" "$RUN_ROOT/kind-clusters.after.txt"
test -z "$(kind get clusters | awk -v prefix="dawn-local-${RUN_TOKEN}-" 'index($0, prefix) == 1')"
! docker container inspect dawn-smoke-app >/dev/null 2>&1
! docker container inspect dawn-smoke-aimock >/dev/null 2>&1
! docker network inspect dawn-smoke-net >/dev/null 2>&1
test -z "$(docker ps -a --format '{{.Names}}' | awk 'index($0, "dawn-sbx-") == 1')"
test -z "$(docker volume ls -q | awk 'index($0, "dawn-sbx-vol-") == 1')"
test -z "$(find "$RUN_ROOT" -type f \( -iname '*kubeconfig*' -o -iname '*token*' -o -iname '*secret*' \) -print)"
rm -rf "$TOOL_ROOT"
test ! -e "$TOOL_ROOT"
```

Expected: pre-existing Kind clusters are unchanged; every run-specific cluster, fixed smoke container/network, exact sandbox container/volume namespace, temporary kubeconfig, downloaded binary, and temporary registry file is gone. Do not compare/remove unrelated Docker images or pre-existing Docker resources. Remove only the exact generated smoke image tags after all reruns are complete:

```bash
docker image rm dawn-smoke-app:k8s dawn-smoke-app:docker dawn-smoke-aimock:latest \
  > "$RUN_ROOT/image-cleanup.log" 2>&1 || true
```

- [ ] **Step 5: Confirm repository and hosted-state boundaries**

```bash
git status --short
git log -1 --oneline
```

Expected: all intentional source fixes are committed, ignored evidence remains available locally, and no untracked credential/tool file exists. Confirm from the task transcript that no `git push`, PR creation, workflow dispatch, branch-protection write, or other hosted mutation occurred. Local success does not replace the exact hosted Linux lanes required before merge.
