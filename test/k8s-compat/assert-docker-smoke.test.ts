import { spawn } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, join, resolve } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

const REPOSITORY_ROOT = resolve(__dirname, "../..")
const SCRIPT = resolve(REPOSITORY_ROOT, "test/k8s-smoke/assert-docker.sh")
const APP_NAME = "dawn-smoke-app"
const AIMOCK_NAME = "dawn-smoke-aimock"
const NETWORK_NAME = "dawn-smoke-net"
const THREAD_ID = "thread:123"
const SANITIZED_THREAD_ID = "thread_123"
const SANDBOX_NAME = `dawn-sbx-${SANITIZED_THREAD_ID}`
const SANDBOX_VOLUME = `dawn-sbx-vol-${SANITIZED_THREAD_ID}`
const VALID_IDENTITY = "a".repeat(64)
const objectId = (character: string): string => character.repeat(64)
const NETWORK_ID = objectId("1")
const AIMOCK_ID = objectId("2")
const APP_ID = objectId("3")
const SANDBOX_ID = objectId("4")
const FOREIGN_CONTAINER_ID = objectId("f")
const FOREIGN_NETWORK_ID = objectId("e")
const RUN_WATCHDOG_MS = 10_000
const TEST_TIMEOUT_MS = RUN_WATCHDOG_MS + 5_000

type FixedResource = "network" | "aimock" | "app"

interface FakeContainer {
  readonly id: string
  readonly labels: Record<string, string>
  readonly user: string
  readonly readonlyRootfs: boolean
  readonly hostname: string
}

interface FakeNetwork {
  readonly id: string
}

interface FakeVolume {
  readonly CreatedAt: string
  readonly Driver: string
  readonly Labels: Record<string, string> | null
  readonly Mountpoint: string
  readonly Name: string
  readonly Options: Record<string, string> | null
  readonly Scope: string
}

type MutationAction =
  | { readonly type: "add-container"; readonly name: string }
  | { readonly type: "add-volume"; readonly name: string }
  | { readonly type: "replace-container"; readonly name: string }
  | {
      readonly type: "set-container-label"
      readonly name: string
      readonly label: string
      readonly value: string
    }
  | { readonly type: "replace-network"; readonly name: string }
  | { readonly type: "replace-volume"; readonly name: string }

interface Mutation {
  readonly key: string
  readonly occurrence: number
  readonly action: MutationAction
  readonly timing?: "before" | "after"
  readonly applied?: boolean
}

interface FailingQuery {
  readonly key: string
  readonly occurrence: number
}

interface FakeOptions {
  threadId: string
  runMode: "success" | "delayed-success" | "failure" | "hang"
  runDelayMs: number
  createSandbox: boolean
  createVolume: boolean
  sandboxLabel: string
  identityLabel: string
  sandboxUser: string
  sandboxReadonlyRootfs: boolean
  unexpectedSandboxName: string
  deleteRemovesSandbox: boolean
  runWaitMarker: string
  sandboxInspectMarker: string
  identityInspectMarker: string
  hangSandboxIdInspect: boolean
  hangIdentityReadTarget: string
  createHangTarget: FixedResource | ""
  createSuppressOutputTarget: FixedResource | ""
  createOutputMarkers: Record<FixedResource, string>
  detachedPidMarker: string
  hangDiagnostic: boolean
  cleanupMode:
    | "normal"
    | "ignore-term"
    | "term-zero"
    | "remove-then-ignore-term"
    | "remove-then-term-zero"
  networkCreateOrphan: boolean
  lateSandboxOnAppRemoval: "none" | "owned" | "foreign"
  replaceVolumeAfterAppRemovalList: boolean
  failingQueries: readonly FailingQuery[]
  mutations: readonly Mutation[]
}

interface FakeState {
  nextId: number
  containers: Record<string, FakeContainer>
  networks: Record<string, FakeNetwork>
  volumes: Record<string, FakeVolume>
  occurrences: Record<string, number>
  options: FakeOptions
}

interface TranscriptEntry {
  readonly command: string
  readonly args: readonly string[]
}

interface SmokeResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly transcript: readonly TranscriptEntry[]
  readonly state: FakeState
  readonly elapsedMs: number
  readonly orphanProcessIds: readonly number[]
  readonly activeOrphanProcessIds: readonly number[]
}

interface SmokeFixtureOptions {
  readonly configure?: (state: FakeState) => void
  readonly environment?: Readonly<Record<string, string>>
  readonly signalOnIdentityRead?: NodeJS.Signals
  readonly signalOnCreateOutput?: {
    readonly resource: FixedResource
    readonly signal: NodeJS.Signals
  }
  readonly signalOnRunWait?: NodeJS.Signals
  readonly signalOnSandboxInspect?: NodeJS.Signals
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function container(id: string, hostname: string): FakeContainer {
  return {
    id,
    labels: {},
    user: "1000:1000",
    readonlyRootfs: true,
    hostname,
  }
}

function volume(name: string, generation = 1): FakeVolume {
  return {
    CreatedAt: `2026-08-11T00:00:0${generation}Z`,
    Driver: "local",
    Labels: null,
    Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    Name: name,
    Options: null,
    Scope: "local",
  }
}

function defaultState(markers: {
  readonly createOutput: Record<FixedResource, string>
  readonly detachedPids: string
  readonly identityInspect: string
  readonly runWait: string
  readonly sandboxInspect: string
}): FakeState {
  return {
    nextId: 1,
    containers: {
      unrelated: container(FOREIGN_CONTAINER_ID, "unrelated"),
    },
    networks: {
      unrelated: { id: FOREIGN_NETWORK_ID },
    },
    volumes: {
      unrelated: volume("unrelated"),
    },
    occurrences: {},
    options: {
      threadId: THREAD_ID,
      runMode: "success",
      runDelayMs: 0,
      createSandbox: true,
      createVolume: true,
      sandboxLabel: SANITIZED_THREAD_ID,
      identityLabel: VALID_IDENTITY,
      sandboxUser: "1000:1000",
      sandboxReadonlyRootfs: true,
      unexpectedSandboxName: "",
      deleteRemovesSandbox: true,
      runWaitMarker: markers.runWait,
      sandboxInspectMarker: markers.sandboxInspect,
      identityInspectMarker: markers.identityInspect,
      hangSandboxIdInspect: false,
      hangIdentityReadTarget: "",
      createHangTarget: "",
      createSuppressOutputTarget: "",
      createOutputMarkers: markers.createOutput,
      detachedPidMarker: markers.detachedPids,
      hangDiagnostic: false,
      cleanupMode: "normal",
      networkCreateOrphan: false,
      lateSandboxOnAppRemoval: "none",
      replaceVolumeAfterAppRemovalList: false,
      failingQueries: [],
      mutations: [],
    },
  }
}

const FAKE_DISPATCHER = String.raw`import { spawn } from "node:child_process"
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs"

const command = process.argv[2]
const args = process.argv.slice(3)
const statePath = process.env.FAKE_STATE
const transcriptPath = process.env.FAKE_TRANSCRIPT
if (!statePath || !transcriptPath) throw new Error("fake command paths are required")

appendFileSync(transcriptPath, JSON.stringify({ command, args }) + "\n")

const load = () => JSON.parse(readFileSync(statePath, "utf8"))
const save = (state) => {
  const temporaryPath = statePath + "." + process.pid + ".tmp"
  writeFileSync(temporaryPath, JSON.stringify(state))
  renameSync(temporaryPath, statePath)
}
const nextId = (state) => {
  const character = (((state.nextId - 1) % 15) + 1).toString(16)
  state.nextId += 1
  return character.repeat(64)
}
const findContainer = (state, target) =>
  Object.entries(state.containers).find(([name, value]) => name === target || value.id === target)
const findNetwork = (state, target) =>
  Object.entries(state.networks).find(([name, value]) => name === target || value.id === target)
const sandboxName = (state) =>
  "dawn-sbx-" + state.options.threadId.replace(/[^a-zA-Z0-9_.-]/g, "_")
const sandboxVolume = (state) =>
  "dawn-sbx-vol-" + state.options.threadId.replace(/[^a-zA-Z0-9_.-]/g, "_")
const makeVolume = (name, generation = 1) => ({
  CreatedAt: "2026-08-11T00:00:0" + generation + "Z",
  Driver: "local",
  Labels: null,
  Mountpoint: "/var/lib/docker/volumes/" + name + "/_data",
  Name: name,
  Options: null,
  Scope: "local",
})
const makeContainer = (state, name, overrides = {}) => ({
  id: nextId(state, name + "-id"),
  labels: {},
  user: "1000:1000",
  readonlyRootfs: true,
  hostname: name,
  ...overrides,
})

const createSandboxResources = (state, ownership = "owned") => {
  const name = sandboxName(state)
  const volumeName = sandboxVolume(state)
  const owned = ownership === "owned"
  state.containers[name] = makeContainer(state, name, {
    labels: {
      "dawn.sandbox": owned ? state.options.sandboxLabel : "foreign-thread",
      "dawn.sandbox.identity": owned ? state.options.identityLabel : "b".repeat(64),
    },
    user: state.options.sandboxUser,
    readonlyRootfs: state.options.sandboxReadonlyRootfs,
    hostname: name,
  })
  state.volumes[volumeName] = makeVolume(volumeName)
}

const applyAction = (state, action) => {
  if (action.type === "add-container") {
    state.containers[action.name] = makeContainer(state, action.name)
    return
  }
  if (action.type === "add-volume") {
    state.volumes[action.name] = makeVolume(action.name)
    return
  }
  if (action.type === "replace-container") {
    const previous = state.containers[action.name]
    state.containers[action.name] = makeContainer(state, action.name, {
      labels: { ...(previous?.labels ?? {}) },
      user: previous?.user ?? "1000:1000",
      readonlyRootfs: previous?.readonlyRootfs ?? true,
      hostname: previous?.hostname ?? action.name,
    })
    return
  }
  if (action.type === "set-container-label") {
    const target = state.containers[action.name]
    if (target) target.labels[action.label] = action.value
    return
  }
  if (action.type === "replace-network") {
    state.networks[action.name] = { id: nextId(state, action.name + "-id") }
    return
  }
  if (action.type === "replace-volume") {
    const current = state.volumes[action.name]
    const currentGeneration = Number(current?.CreatedAt?.slice(18, 19) ?? "1")
    const generation = currentGeneration + 1
    state.volumes[action.name] = makeVolume(action.name, generation)
  }
}

const applyMutations = (state, key, occurrence, timing) => {
  for (const mutation of state.options.mutations) {
    const mutationTiming = mutation.timing ?? "before"
    if (
      !mutation.applied &&
      mutation.key === key &&
      mutation.occurrence === occurrence &&
      mutationTiming === timing
    ) {
      applyAction(state, mutation.action)
      mutation.applied = true
    }
  }
}

const before = (state, key) => {
  const occurrence = (state.occurrences[key] ?? 0) + 1
  state.occurrences[key] = occurrence
  applyMutations(state, key, occurrence, "before")
  save(state)
}

const after = (state, key) => {
  applyMutations(state, key, state.occurrences[key] ?? 0, "after")
  save(state)
}

const failConfiguredQuery = (state, key) => {
  const occurrence = state.occurrences[key] ?? 0
  if (
    state.options.failingQueries.some(
      (query) => query.key === key && query.occurrence === occurrence,
    )
  ) {
    fail("forced listing failure: " + key)
  }
}

const matchesNameFilter = (name, expression) => {
  if (!expression) return true
  try {
    return new RegExp(expression).test(name)
  } catch {
    fail("invalid name filter: " + expression)
  }
}

const hang = (label, termMode = "default") => {
  process.stderr.write("FAKE HANG " + label + "\n")
  if (termMode === "ignore") process.on("SIGTERM", () => {})
  if (termMode === "zero") process.on("SIGTERM", () => process.exit(0))
  setInterval(() => {}, 1_000)
}

const emitCreateResult = (state, resource, id) => {
  if (state.options.createSuppressOutputTarget !== resource) process.stdout.write(id + "\n")
  writeFileSync(state.options.createOutputMarkers[resource], "entered")
  if (state.options.createHangTarget === resource) {
    hang("docker " + resource + " create after output", "ignore")
  }
}

const fail = (message = "not found") => {
  process.stderr.write(message + "\n")
  process.exit(1)
}

const docker = () => {
  const state = load()
  const first = args[0]

  if (first === "info") return

  if (first === "run") {
    const nameIndex = args.indexOf("--name")
    if (nameIndex === -1) {
      process.stdout.write("123\n")
      return
    }
    const name = args[nameIndex + 1]
    if (state.containers[name]) fail("container name is occupied")
    const created = makeContainer(state, name)
    state.containers[name] = created
    save(state)
    emitCreateResult(state, name === "dawn-smoke-aimock" ? "aimock" : "app", created.id)
    return
  }

  if (first === "network" && args[1] === "create") {
    const name = args[2]
    if (state.networks[name]) fail("network name is occupied")
    state.networks[name] = { id: nextId(state, name + "-id") }
    save(state)
    if (state.options.createSuppressOutputTarget !== "network") {
      process.stdout.write(state.networks[name].id + "\n")
    }
    writeFileSync(state.options.createOutputMarkers.network, "entered")
    if (state.options.networkCreateOrphan) {
      const grandchild = spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => process.stdout.write(''), 1000)",
        ],
        { detached: true, stdio: ["ignore", "inherit", "inherit"] },
      )
      grandchild.unref()
      writeFileSync(state.options.detachedPidMarker, grandchild.pid + "\n")
      hang("docker network create with stdout orphan", "zero")
    }
    if (state.options.createHangTarget === "network") {
      hang("docker network create after output", "ignore")
    }
    return
  }

  if (first === "network" && args[1] === "ls") {
    const filterIndex = args.indexOf("--filter")
    const filter = filterIndex === -1 ? "" : args[filterIndex + 1]
    const expression = filter.startsWith("name=") ? filter.slice(5) : ""
    const key = "network-list:" + (filterIndex === -1 ? "<all>" : expression)
    before(state, key)
    const current = load()
    failConfiguredQuery(current, key)
    const noTrunc = args.includes("--no-trunc")
    const matches = Object.entries(current.networks).filter(([name]) =>
      matchesNameFilter(name, expression),
    )
    const formatIndex = args.indexOf("--format")
    const format = formatIndex === -1 ? "" : args[formatIndex + 1]
    const output = matches.map(([name, value]) => {
      const displayedId = noTrunc ? value.id : value.id.slice(0, 12)
      return format.includes("Name") ? displayedId + " " + name : displayedId
    })
    if (output.length > 0) process.stdout.write(output.join("\n") + "\n")
    after(current, key)
    return
  }

  if (first === "network" && args[1] === "inspect") {
    const target = args.at(-1)
    const key = "network-id:" + target
    before(state, key)
    const current = load()
    failConfiguredQuery(current, key)
    if (
      current.options.hangIdentityReadTarget === target &&
      current.occurrences[key] === 1
    ) {
      writeFileSync(current.options.identityInspectMarker, "entered")
      hang("docker network identity inspect")
      return
    }
    const found = findNetwork(current, target)
    if (!found) fail()
    process.stdout.write(found[1].id + "\n")
    after(current, key)
    return
  }

  if (first === "inspect") {
    const formatIndex = args.findIndex((value) => value === "--format" || value === "-f")
    const format = formatIndex === -1 ? "" : args[formatIndex + 1]
    const target = args.at(-1)
    let key = "container-inspect:" + target
    if (format === "{{.Id}}") key = "container-id:" + target
    else if (format.includes("dawn.sandbox.identity")) key = "container-identity:" + target
    else if (format.includes("dawn.sandbox")) key = "container-thread-label:" + target
    else if (format === "{{.Config.User}}") key = "container-user"
    else if (format === "{{.HostConfig.ReadonlyRootfs}}") key = "container-rootfs"
    else if (format === "{{.Config.Hostname}}") key = "container-hostname"
    else if (format === "{{.Name}}") key = "container-name"
    before(state, key)
    const current = load()
    failConfiguredQuery(current, key)
    if (
      format === "{{.Id}}" &&
      current.options.hangIdentityReadTarget === target &&
      current.occurrences[key] === 1
    ) {
      writeFileSync(current.options.identityInspectMarker, "entered")
      hang("docker container identity inspect")
      return
    }
    if (
      format === "{{.Id}}" &&
      target === sandboxName(current) &&
      current.options.hangSandboxIdInspect &&
      current.occurrences[key] === 1
    ) {
      writeFileSync(current.options.sandboxInspectMarker, "entered")
      hang("docker sandbox adoption inspect")
      return
    }
    const found = findContainer(current, target)
    if (!found) fail()
    const [name, value] = found
    if (!format) {
      process.stdout.write(JSON.stringify([{ Id: value.id, Name: "/" + name, Config: value }]) + "\n")
    } else if (format === "{{.Id}}") process.stdout.write(value.id + "\n")
    else if (format.includes("dawn.sandbox.identity")) {
      process.stdout.write((value.labels["dawn.sandbox.identity"] ?? "") + "\n")
    } else if (format.includes("dawn.sandbox")) {
      process.stdout.write((value.labels["dawn.sandbox"] ?? "") + "\n")
    } else if (format === "{{.Config.User}}") process.stdout.write(value.user + "\n")
    else if (format === "{{.HostConfig.ReadonlyRootfs}}") {
      process.stdout.write(String(value.readonlyRootfs) + "\n")
    } else if (format === "{{.Config.Hostname}}") process.stdout.write(value.hostname + "\n")
    else if (format === "{{.Name}}") process.stdout.write("/" + name + "\n")
    after(current, key)
    return
  }

  if (first === "volume" && args[1] === "inspect") {
    const name = args.at(-1)
    before(state, "volume-inspect:" + name)
    const current = load()
    failConfiguredQuery(current, "volume-inspect:" + name)
    const found = current.volumes[name]
    if (!found) fail()
    process.stdout.write(JSON.stringify([found]) + "\n")
    after(current, "volume-inspect:" + name)
    return
  }

  if (first === "ps") {
    const filterIndex = args.indexOf("--filter")
    const filter = filterIndex === -1 ? "" : args[filterIndex + 1]
    const expression = filter.startsWith("name=") ? filter.slice(5) : ""
    const key = "container-list:" + (filterIndex === -1 ? "<all>" : expression)
    before(state, key)
    const current = load()
    failConfiguredQuery(current, key)
    const noTrunc = args.includes("--no-trunc")
    const matches = Object.entries(current.containers).filter(([name]) =>
      matchesNameFilter(name, expression),
    )
    const formatIndex = args.indexOf("--format")
    const format = formatIndex === -1 ? "" : args[formatIndex + 1]
    const output = matches.map(([name, value]) => {
      const displayedId = noTrunc ? value.id : value.id.slice(0, 12)
      if (format.includes("Names")) return format.includes("ID") ? displayedId + " " + name : name
      return displayedId
    })
    if (output.length > 0) process.stdout.write(output.join("\n") + "\n")
    after(current, key)
    return
  }

  if (first === "volume" && args[1] === "ls") {
    const filterIndex = args.indexOf("--filter")
    const filter = filterIndex === -1 ? "" : args[filterIndex + 1]
    const expression = filter.startsWith("name=") ? filter.slice(5) : ""
    const key = "volume-list:" + (filterIndex === -1 ? "<all>" : expression)
    before(state, key)
    const current = load()
    failConfiguredQuery(current, key)
    const names = Object.keys(current.volumes).filter((name) =>
      matchesNameFilter(name, expression),
    )
    if (names.length > 0) process.stdout.write(names.join("\n") + "\n")
    if (
      current.options.replaceVolumeAfterAppRemovalList &&
      !current.containers["dawn-smoke-app"] &&
      current.volumes[sandboxVolume(current)]
    ) {
      applyAction(current, { type: "replace-volume", name: sandboxVolume(current) })
      current.options.replaceVolumeAfterAppRemovalList = false
    }
    after(current, key)
    return
  }

  if (first === "logs") {
    const target = args[1]
    const found = findContainer(state, target)
    const name = found?.[0] ?? target
    if (state.options.hangDiagnostic && name === "dawn-smoke-app") {
      hang("docker logs " + target, "ignore")
      return
    }
    process.stderr.write("logs for " + name + "\n")
    return
  }

  if (first === "rm") {
    const target = args.at(-1)
    const found = findContainer(state, target)
    const name = found?.[0] ?? target
    if (
      (state.options.cleanupMode === "ignore-term" ||
        state.options.cleanupMode === "term-zero") &&
      name === "dawn-smoke-app"
    ) {
      hang(
        "docker rm " + target,
        state.options.cleanupMode === "term-zero" ? "zero" : "ignore",
      )
      return
    }
    if (!found) fail()
    if (name === "dawn-smoke-app" && state.options.lateSandboxOnAppRemoval !== "none") {
      createSandboxResources(state, state.options.lateSandboxOnAppRemoval)
    }
    delete state.containers[found[0]]
    save(state)
    if (
      name === "dawn-smoke-app" &&
      (state.options.cleanupMode === "remove-then-ignore-term" ||
        state.options.cleanupMode === "remove-then-term-zero")
    ) {
      hang(
        "docker rm " + target + " after removal",
        state.options.cleanupMode === "remove-then-term-zero" ? "zero" : "ignore",
      )
    }
    return
  }

  if (first === "network" && args[1] === "rm") {
    const target = args.at(-1)
    const found = findNetwork(state, target)
    if (!found) fail()
    delete state.networks[found[0]]
    save(state)
    return
  }

  if (first === "volume" && args[1] === "rm") {
    const name = args.at(-1)
    if (!state.volumes[name]) fail()
    delete state.volumes[name]
    save(state)
    return
  }

  fail("unsupported fake docker command: " + args.join(" "))
}

const curl = () => {
  const state = load()
  const url = args.find((argument) => argument.startsWith("http://")) ?? ""
  const methodIndex = args.indexOf("-X")
  const method = methodIndex === -1 ? "GET" : args[methodIndex + 1]

  if (url.endsWith("/healthz")) {
    const key = "healthz"
    before(state, key)
    const current = load()
    failConfiguredQuery(current, key)
    after(current, key)
    return
  }

  if (method === "POST" && url.endsWith("/threads")) {
    process.stdout.write(JSON.stringify({ thread_id: state.options.threadId }))
    return
  }

  if (method === "POST" && url.endsWith("/runs/wait")) {
    const name = sandboxName(state)
    if (state.options.createSandbox && state.options.createVolume) {
      createSandboxResources(state)
    } else {
      if (state.options.createSandbox) {
        state.containers[name] = makeContainer(state, name, {
          labels: {
            "dawn.sandbox": state.options.sandboxLabel,
            "dawn.sandbox.identity": state.options.identityLabel,
          },
          user: state.options.sandboxUser,
          readonlyRootfs: state.options.sandboxReadonlyRootfs,
          hostname: name,
        })
      }
      if (state.options.createVolume) {
        const volumeName = sandboxVolume(state)
        state.volumes[volumeName] = makeVolume(volumeName)
      }
    }
    if (state.options.unexpectedSandboxName) {
      const unexpected = state.options.unexpectedSandboxName
      state.containers[unexpected] = makeContainer(state, unexpected, {
        labels: {
          "dawn.sandbox": "concurrent",
          "dawn.sandbox.identity": "b".repeat(64),
        },
      })
    }
    save(state)
    if (state.options.runWaitMarker) writeFileSync(state.options.runWaitMarker, "entered")
    if (state.options.runMode === "hang") {
      hang("curl runs/wait")
      return
    }
    if (state.options.runMode === "failure") process.exit(22)
    if (state.options.runMode === "delayed-success") {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        state.options.runDelayMs,
      )
    }
    const content = JSON.stringify({ stdout: "1000\n" + name + "\n", stderr: "", exitCode: 0 })
    process.stdout.write(JSON.stringify({ messages: [{ type: "tool", name: "runBash", content }] }))
    return
  }

  if (url.endsWith("/state")) {
    const name = sandboxName(state)
    const content = JSON.stringify({ stdout: "1000\n" + name + "\n", stderr: "", exitCode: 0 })
    process.stdout.write(JSON.stringify({ values: { messages: [{ type: "tool", name: "runBash", content }] } }))
    return
  }

  if (method === "DELETE") {
    if (state.options.deleteRemovesSandbox) {
      delete state.containers[sandboxName(state)]
      delete state.volumes[sandboxVolume(state)]
      save(state)
    }
    return
  }

  fail("unsupported fake curl command: " + args.join(" "))
}

if (command === "docker") docker()
else if (command === "curl") curl()
else fail("unsupported fake command: " + command)
`

function shellWrapper(command: "docker" | "curl"): string {
  return `#!/bin/sh\nexec "$FAKE_NODE" "$FAKE_DISPATCHER" ${command} "$@"\n`
}

const JQ_WRAPPER = `#!/bin/sh
args_json=$("$REAL_JQ" -cn --args '$ARGS.positional' -- "$@") || exit 1
printf '{"command":"jq","args":%s}\n' "$args_json" >> "$FAKE_TRANSCRIPT"
exec "$REAL_JQ" "$@"
`

const SLEEP_WRAPPER = `#!/bin/sh
printf '{"command":"sleep","args":["%s"]}\n' "$1" >> "$FAKE_TRANSCRIPT"
if [ "$1" = "$SMOKE_RUN_TIMEOUT_SECONDS" ]; then
  exec /bin/sleep "$FAKE_SLEEP_RUN_TIMEOUT_SECONDS"
fi
if [ "$1" = "$SMOKE_COMMAND_TIMEOUT_SECONDS" ]; then
  exec /bin/sleep "$FAKE_SLEEP_TIMEOUT_SECONDS"
fi
exec /bin/sleep "$FAKE_SLEEP_SHORT_SECONDS"
`

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8")
  await chmod(path, 0o755)
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await readFile(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for fake command marker ${path}`)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function findExecutableOnPath(name: string, pathValue: string): Promise<string> {
  for (const directory of pathValue.split(delimiter)) {
    const candidate = resolve(directory || process.cwd(), name)
    try {
      if (!(await stat(candidate)).isFile()) continue
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES" && code !== "EPERM") {
        throw error
      }
    }
  }
  throw new Error(`Could not resolve ${name} from PATH`)
}

async function killRecordedProcesses(path: string): Promise<readonly number[]> {
  const processIds = await readRecordedProcessIds(path)
  for (const pid of processIds) {
    try {
      process.kill(pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  return processIds
}

async function readRecordedProcessIds(path: string): Promise<readonly number[]> {
  if (!(await fileExists(path))) return []
  return (await readFile(path, "utf8"))
    .split("\n")
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

async function waitForProcessesToExit(processIds: readonly number[]): Promise<readonly number[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const active = processIds.filter(processExists)
    if (active.length === 0) return []
    await wait(20)
  }
  return processIds.filter(processExists)
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

async function runSmoke(options: SmokeFixtureOptions = {}): Promise<SmokeResult> {
  const directory = await mkdtemp(join(tmpdir(), "dawn-docker-smoke-"))
  temporaryDirectories.push(directory)
  const parentPath = process.env.PATH ?? ""
  const realJq = await findExecutableOnPath("jq", parentPath)
  const bin = join(directory, "bin")
  const statePath = join(directory, "state.json")
  const transcriptPath = join(directory, "transcript.jsonl")
  const dispatcherPath = join(directory, "fake-command.mjs")
  const runWaitMarkerPath = join(directory, "run-wait-entered")
  const sandboxInspectMarkerPath = join(directory, "sandbox-inspect-entered")
  const identityInspectMarkerPath = join(directory, "identity-inspect-entered")
  const createOutputMarkerPaths: Record<FixedResource, string> = {
    network: join(directory, "network-create-output"),
    aimock: join(directory, "aimock-create-output"),
    app: join(directory, "app-create-output"),
  }
  const detachedPidMarkerPath = join(directory, "detached-pids")
  await mkdir(bin)

  const state = defaultState({
    createOutput: createOutputMarkerPaths,
    detachedPids: detachedPidMarkerPath,
    identityInspect: identityInspectMarkerPath,
    runWait: runWaitMarkerPath,
    sandboxInspect: sandboxInspectMarkerPath,
  })
  options.configure?.(state)
  await writeFile(statePath, JSON.stringify(state), "utf8")
  await writeFile(transcriptPath, "", "utf8")
  await writeFile(dispatcherPath, FAKE_DISPATCHER, "utf8")
  await writeExecutable(join(bin, "docker"), shellWrapper("docker"))
  await writeExecutable(join(bin, "curl"), shellWrapper("curl"))
  await writeExecutable(join(bin, "jq"), JQ_WRAPPER)
  await writeExecutable(join(bin, "sleep"), SLEEP_WRAPPER)

  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  const startedAt = Date.now()
  const child = spawn("sh", [SCRIPT], {
    cwd: REPOSITORY_ROOT,
    detached: true,
    env: {
      ...process.env,
      PATH: `${bin}:${parentPath}`,
      FAKE_NODE: process.execPath,
      FAKE_DISPATCHER: dispatcherPath,
      FAKE_STATE: statePath,
      FAKE_TRANSCRIPT: transcriptPath,
      REAL_JQ: realJq,
      SMOKE_COMMAND_TIMEOUT_SECONDS: "1",
      SMOKE_COMMAND_KILL_GRACE_SECONDS: "1",
      SMOKE_RUN_CURL_MAX_TIME_SECONDS: "1",
      SMOKE_RUN_TIMEOUT_SECONDS: "2",
      FAKE_SLEEP_TIMEOUT_SECONDS: "0.75",
      FAKE_SLEEP_RUN_TIMEOUT_SECONDS: "1.5",
      FAKE_SLEEP_SHORT_SECONDS: "0.02",
      ...options.environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (child.pid === undefined) throw new Error("Smoke script did not expose a process ID")
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))

  let watchdogFired = false
  const watchdog = setTimeout(() => {
    watchdogFired = true
    killProcessGroup(child.pid as number, "SIGKILL")
  }, RUN_WATCHDOG_MS)

  const exitCompletion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolvePromise({ code, signal }))
    },
  )
  const closeCompletion = new Promise<void>((resolvePromise) => {
    child.once("close", () => resolvePromise())
  })

  let outcome: { code: number | null; signal: NodeJS.Signals | null }
  let orphanProcessIds: readonly number[] = []
  let activeOrphanProcessIds: readonly number[] = []

  try {
    if (options.signalOnRunWait !== undefined) {
      await waitForFile(runWaitMarkerPath)
      killProcessGroup(child.pid, options.signalOnRunWait)
    } else if (options.signalOnSandboxInspect !== undefined) {
      await waitForFile(sandboxInspectMarkerPath)
      killProcessGroup(child.pid, options.signalOnSandboxInspect)
    } else if (options.signalOnIdentityRead !== undefined) {
      await waitForFile(identityInspectMarkerPath)
      killProcessGroup(child.pid, options.signalOnIdentityRead)
    } else if (options.signalOnCreateOutput !== undefined) {
      await waitForFile(createOutputMarkerPaths[options.signalOnCreateOutput.resource])
      killProcessGroup(child.pid, options.signalOnCreateOutput.signal)
    }
    outcome = await exitCompletion
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null && child.signalCode === null) {
      killProcessGroup(child.pid, "SIGKILL")
      await exitCompletion.catch(() => {})
    }
    orphanProcessIds = await killRecordedProcesses(detachedPidMarkerPath)
    activeOrphanProcessIds = await waitForProcessesToExit(orphanProcessIds)
    await closeCompletion
  }

  const transcriptText = await readFile(transcriptPath, "utf8")
  const transcript = transcriptText
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TranscriptEntry)
  if (watchdogFired) {
    const tail = transcript.slice(-12)
    throw new Error(
      `Smoke script exceeded its ten-second watchdog\nlast commands: ${JSON.stringify(tail)}\nstderr: ${Buffer.concat(stderrChunks).toString("utf8")}`,
    )
  }
  return {
    ...outcome,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    transcript,
    state: JSON.parse(await readFile(statePath, "utf8")) as FakeState,
    elapsedMs: Date.now() - startedAt,
    orphanProcessIds,
    activeOrphanProcessIds,
  }
}

function isDestructive(entry: TranscriptEntry): boolean {
  if (entry.command !== "docker") return false
  return (
    entry.args[0] === "rm" ||
    (entry.args[0] === "network" && entry.args[1] === "rm") ||
    (entry.args[0] === "volume" && entry.args[1] === "rm")
  )
}

function destructiveTargets(result: SmokeResult): readonly string[] {
  return result.transcript.filter(isDestructive).map((entry) => entry.args.at(-1) ?? "")
}

function commandIndex(result: SmokeResult, predicate: (entry: TranscriptEntry) => boolean): number {
  return result.transcript.findIndex(predicate)
}

function hasListingQuery(
  result: SmokeResult,
  resource: "container" | "network" | "volume",
  nameExpression: string | null,
): boolean {
  return result.transcript.some(({ command, args }) => {
    if (command !== "docker") return false
    const isResourceListing =
      (resource === "container" && args[0] === "ps") ||
      (resource === "network" && args[0] === "network" && args[1] === "ls") ||
      (resource === "volume" && args[0] === "volume" && args[1] === "ls")
    if (!isResourceListing) return false
    const filterIndex = args.indexOf("--filter")
    return nameExpression === null
      ? filterIndex === -1
      : args[filterIndex + 1] === `name=${nameExpression}`
  })
}

function attemptedFixedCreation(result: SmokeResult): boolean {
  return result.transcript.some(
    ({ command, args }) =>
      command === "docker" &&
      ((args[0] === "network" && args[1] === "create") ||
        (args[0] === "run" && args.includes("--name"))),
  )
}

function attemptedRunWait(result: SmokeResult): boolean {
  return result.transcript.some(
    ({ command, args }) => command === "curl" && args.some((arg) => arg.endsWith("/runs/wait")),
  )
}

function expectForeignObjectsPreserved(result: SmokeResult): void {
  expect(result.state.containers.unrelated?.id).toBe(FOREIGN_CONTAINER_ID)
  expect(result.state.networks.unrelated?.id).toBe(FOREIGN_NETWORK_ID)
  expect(result.state.volumes.unrelated?.Name).toBe("unrelated")
  expect(destructiveTargets(result)).not.toContain(FOREIGN_CONTAINER_ID)
  expect(destructiveTargets(result)).not.toContain(FOREIGN_NETWORK_ID)
  expect(destructiveTargets(result)).not.toContain("unrelated")
}

function expectFixedObjectsRemovedById(result: SmokeResult): void {
  const targets = destructiveTargets(result)
  expect(targets).toContain(NETWORK_ID)
  expect(targets).toContain(AIMOCK_ID)
  expect(targets).toContain(APP_ID)
  expect(targets).not.toContain(NETWORK_NAME)
  expect(targets).not.toContain(AIMOCK_NAME)
  expect(targets).not.toContain(APP_NAME)
}

function expectFixedResourceRemoved(result: SmokeResult, resource: FixedResource): void {
  if (resource === "network") expect(result.state.networks[NETWORK_NAME]).toBeUndefined()
  else if (resource === "aimock") expect(result.state.containers[AIMOCK_NAME]).toBeUndefined()
  else expect(result.state.containers[APP_NAME]).toBeUndefined()
}

describe("Docker smoke ownership", () => {
  test.each([
    {
      name: "app container",
      configure: (state: FakeState) => {
        state.containers[APP_NAME] = container(objectId("b"), APP_NAME)
      },
    },
    {
      name: "aimock container",
      configure: (state: FakeState) => {
        state.containers[AIMOCK_NAME] = container(objectId("c"), AIMOCK_NAME)
      },
    },
    {
      name: "network",
      configure: (state: FakeState) => {
        state.networks[NETWORK_NAME] = { id: objectId("d") }
      },
    },
    {
      name: "sandbox container",
      configure: (state: FakeState) => {
        state.containers["dawn-sbx-occupied"] = container(objectId("b"), "dawn-sbx-occupied")
      },
    },
    {
      name: "sandbox volume",
      configure: (state: FakeState) => {
        state.volumes["dawn-sbx-vol-occupied"] = volume("dawn-sbx-vol-occupied")
      },
    },
  ])(
    "fails closed when the $name is occupied",
    async ({ configure }) => {
      const result = await runSmoke({ configure })

      expect(result.code).toBe(1)
      expect(result.signal).toBeNull()
      expect(result.stderr).toMatch(/occupied|refus/i)
      expect(destructiveTargets(result)).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )

  test.each([
    {
      name: "app container",
      resource: "container" as const,
      expression: null,
      key: "container-list:<all>",
      occurrence: 1,
      beforeFixedMutation: true,
    },
    {
      name: "aimock container",
      resource: "container" as const,
      expression: null,
      key: "container-list:<all>",
      occurrence: 2,
      beforeFixedMutation: true,
    },
    {
      name: "network",
      resource: "network" as const,
      expression: null,
      key: "network-list:<all>",
      occurrence: 1,
      beforeFixedMutation: true,
    },
    {
      name: "sandbox container prefix",
      resource: "container" as const,
      expression: "dawn-sbx-",
      key: "container-list:dawn-sbx-",
      occurrence: 1,
      beforeFixedMutation: true,
    },
    {
      name: "sandbox volume prefix",
      resource: "volume" as const,
      expression: "dawn-sbx-vol-",
      key: "volume-list:dawn-sbx-vol-",
      occurrence: 1,
      beforeFixedMutation: true,
    },
    {
      name: "derived sandbox container",
      resource: "container" as const,
      expression: null,
      key: "container-list:<all>",
      occurrence: 3,
      beforeFixedMutation: false,
    },
    {
      name: "derived sandbox volume",
      resource: "volume" as const,
      expression: null,
      key: "volume-list:<all>",
      occurrence: 1,
      beforeFixedMutation: false,
    },
  ])(
    "fails closed when the $name listing fails",
    async ({ resource, expression, key, occurrence, beforeFixedMutation }) => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.failingQueries = [{ key, occurrence }]
        },
      })

      expect(result.code).toBe(1)
      expect(result.signal).toBeNull()
      expect(hasListingQuery(result, resource, expression)).toBe(true)
      expect(attemptedRunWait(result)).toBe(false)
      if (beforeFixedMutation) {
        expect(attemptedFixedCreation(result)).toBe(false)
        expect(destructiveTargets(result)).toEqual([])
      }
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "does not adopt a regex-near sandbox container for a dotted thread ID",
    async () => {
      const threadId = "thread.123"
      const targetName = `dawn-sbx-${threadId}`
      const nearName = "dawn-sbx-threadX123"
      const result = await runSmoke({
        configure: (state) => {
          state.options.threadId = threadId
          state.options.sandboxLabel = threadId
          state.options.runMode = "failure"
          state.options.createSandbox = false
          state.options.createVolume = false
          state.options.mutations = [
            {
              key: `container-list:^${targetName}$`,
              occurrence: 1,
              action: { type: "add-container", name: nearName },
            },
            {
              key: "container-list:<all>",
              occurrence: 3,
              action: { type: "add-container", name: nearName },
            },
          ]
        },
      })

      expect(attemptedRunWait(result)).toBe(true)
      expect(result.state.containers[targetName]).toBeUndefined()
      expect(result.state.containers[nearName]).toBeDefined()
      expect(destructiveTargets(result)).not.toContain(result.state.containers[nearName]?.id)
      expect(destructiveTargets(result)).not.toContain(nearName)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "does not adopt a regex-near sandbox volume for a dotted thread ID",
    async () => {
      const threadId = "thread.123"
      const targetName = `dawn-sbx-vol-${threadId}`
      const nearName = "dawn-sbx-vol-threadX123"
      const result = await runSmoke({
        configure: (state) => {
          state.options.threadId = threadId
          state.options.sandboxLabel = threadId
          state.options.runMode = "failure"
          state.options.createVolume = false
          state.options.mutations = [
            {
              key: `volume-list:^${targetName}$`,
              occurrence: 1,
              action: { type: "add-volume", name: nearName },
            },
            {
              key: "volume-list:<all>",
              occurrence: 1,
              action: { type: "add-volume", name: nearName },
            },
          ]
        },
      })

      expect(attemptedRunWait(result)).toBe(true)
      expect(result.state.volumes[targetName]).toBeUndefined()
      expect(result.state.volumes[nearName]).toBeDefined()
      expect(destructiveTargets(result)).not.toContain(nearName)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "does not refuse or delete a regex-near network for a dotted literal name",
    async () => {
      const targetName = "dawn.smoke.net"
      const nearName = "dawnXsmokeXnet"
      const nearId = objectId("d")
      const result = await runSmoke({
        environment: { NET: targetName },
        configure: (state) => {
          state.networks[nearName] = { id: nearId }
        },
      })

      expect(result.code, result.stderr).toBe(0)
      expect(result.state.networks[nearName]?.id).toBe(nearId)
      expect(destructiveTargets(result)).not.toContain(nearId)
      expect(destructiveTargets(result)).not.toContain(nearName)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "uses exact sanitized sandbox names on success",
    async () => {
      const result = await runSmoke()

      expect(
        result.code,
        `${result.stderr}\nlast commands: ${JSON.stringify(result.transcript.slice(-12))}`,
      ).toBe(0)
      expect(result.signal).toBeNull()
      expect(result.stdout).toContain("sandbox-docker-e2e assertions PASSED")
      expect(result.transcript).toContainEqual({
        command: "docker",
        args: ["inspect", "--format", "{{.Id}}", SANDBOX_NAME],
      })
      expect(result.transcript).toContainEqual({
        command: "docker",
        args: ["volume", "inspect", SANDBOX_VOLUME],
      })
      expect(
        result.transcript.some(
          ({ command, args }) =>
            command === "docker" &&
            args[0] === "ps" &&
            args.includes("--no-trunc") &&
            args.includes("{{.ID}} {{.Names}}") &&
            args.includes("--filter") === false,
        ),
      ).toBe(true)
      expect(
        result.transcript.some(
          ({ command, args }) =>
            command === "docker" &&
            args.includes("{{.Config.User}}") &&
            args.includes("1000") === false,
        ),
      ).toBe(true)
      expect(
        result.transcript.some(
          ({ command, args }) =>
            command === "docker" && args.includes("{{.HostConfig.ReadonlyRootfs}}"),
        ),
      ).toBe(true)
      const deleteIndex = commandIndex(
        result,
        ({ command, args }) => command === "curl" && args.includes("DELETE"),
      )
      const firstFixedDestructiveIndex = commandIndex(
        result,
        (entry) =>
          isDestructive(entry) && [APP_ID, AIMOCK_ID, NETWORK_ID].includes(entry.args.at(-1) ?? ""),
      )
      const diagnosticIndex = commandIndex(
        result,
        ({ command, args }) => command === "docker" && args[0] === "logs",
      )
      expect(deleteIndex).toBeGreaterThan(-1)
      expect(diagnosticIndex).toBeGreaterThan(deleteIndex)
      expect(firstFixedDestructiveIndex).toBeGreaterThan(deleteIndex)
      expect(firstFixedDestructiveIndex).toBeGreaterThan(diagnosticIndex)
      expect(result.stderr).not.toContain("----- diagnostics")
      expect(result.state.containers[SANDBOX_NAME]).toBeUndefined()
      expect(result.state.volumes[SANDBOX_VOLUME]).toBeUndefined()
      expect(destructiveTargets(result)).not.toContain(SANDBOX_ID)
      expect(destructiveTargets(result)).not.toContain(SANDBOX_NAME)
      expect(destructiveTargets(result)).not.toContain(SANDBOX_VOLUME)
      expectFixedObjectsRemovedById(result)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "revalidates an adopted sandbox immediately before Agent Protocol DELETE",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.mutations = [
            {
              key: "container-name",
              occurrence: 1,
              timing: "after",
              action: { type: "replace-container", name: SANDBOX_NAME },
            },
          ]
        },
      })

      const replacement = result.state.containers[SANDBOX_NAME]
      expect(result.code).toBe(1)
      expect(
        result.transcript.some(
          ({ command, args }) => command === "curl" && args.includes("DELETE"),
        ),
      ).toBe(false)
      expect(replacement).toBeDefined()
      expect(replacement?.id).not.toBe(SANDBOX_ID)
      expect(result.state.volumes[SANDBOX_VOLUME]).toBeDefined()
      expect(destructiveTargets(result)).not.toContain(replacement?.id)
      expect(destructiveTargets(result)).not.toContain(SANDBOX_VOLUME)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "rechecks the exclusive sandbox set immediately before Agent Protocol DELETE",
    async () => {
      const concurrentName = "dawn-sbx-pre-delete-concurrent"
      const result = await runSmoke({
        configure: (state) => {
          state.options.mutations = [
            {
              key: "container-name",
              occurrence: 1,
              timing: "after",
              action: { type: "add-container", name: concurrentName },
            },
          ]
        },
      })

      expect(result.code).toBe(1)
      expect(
        result.transcript.some(
          ({ command, args }) => command === "curl" && args.includes("DELETE"),
        ),
      ).toBe(false)
      expect(result.state.containers[concurrentName]).toBeDefined()
      expect(destructiveTargets(result)).not.toContain(result.state.containers[concurrentName]?.id)
      expect(destructiveTargets(result)).not.toContain(concurrentName)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "revalidates the sandbox volume fingerprint immediately before Agent Protocol DELETE",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.mutations = [
            {
              key: "container-name",
              occurrence: 1,
              timing: "after",
              action: { type: "replace-volume", name: SANDBOX_VOLUME },
            },
          ]
        },
      })

      const replacement = result.state.volumes[SANDBOX_VOLUME]
      expect(result.code).toBe(1)
      expect(
        result.transcript.some(
          ({ command, args }) => command === "curl" && args.includes("DELETE"),
        ),
      ).toBe(false)
      expect(replacement?.CreatedAt).toBe("2026-08-11T00:00:02Z")
      expect(replacement?.Labels).toBeNull()
      expect(replacement?.Options).toBeNull()
      expect(destructiveTargets(result)).not.toContain(SANDBOX_VOLUME)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "allows runs/wait to use its longer command budget",
    async () => {
      const result = await runSmoke({
        environment: {
          SMOKE_COMMAND_TIMEOUT_SECONDS: "1",
          SMOKE_RUN_CURL_MAX_TIME_SECONDS: "2",
          SMOKE_RUN_TIMEOUT_SECONDS: "3",
        },
        configure: (state) => {
          state.options.runMode = "delayed-success"
          state.options.runDelayMs = 1_200
        },
      })

      expect(result.code, result.stderr).toBe(0)
      expect(
        result.transcript.some(
          ({ command, args }) =>
            command === "curl" &&
            args.includes("--max-time") &&
            args[args.indexOf("--max-time") + 1] === "2" &&
            args.some((arg) => arg.endsWith("/runs/wait")),
        ),
      ).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "adopts exact sandbox ownership after a failed run",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.runMode = "failure"
        },
      })

      expect(result.code).toBe(1)
      expect(result.signal).toBeNull()
      expect(result.stderr).toContain("POST /threads/thread:123/runs/wait request failed")
      expect(result.state.containers[SANDBOX_NAME]).toBeUndefined()
      expect(result.state.volumes[SANDBOX_VOLUME]).toBeUndefined()
      expect(destructiveTargets(result)).toContain(SANDBOX_ID)
      expect(destructiveTargets(result)).toContain(SANDBOX_VOLUME)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "adopts owned resources created while the app is being quiesced",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.runMode = "failure"
          state.options.createSandbox = false
          state.options.createVolume = false
          state.options.lateSandboxOnAppRemoval = "owned"
        },
      })

      expect(result.code).toBe(1)
      expect(result.state.containers[SANDBOX_NAME]).toBeUndefined()
      expect(result.state.volumes[SANDBOX_VOLUME]).toBeUndefined()
      expect(destructiveTargets(result)).toContain(SANDBOX_VOLUME)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "reopens final adoption after DELETE observed the sandbox absent",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.lateSandboxOnAppRemoval = "owned"
        },
      })

      expect(result.code, result.stderr).toBe(0)
      expect(result.state.containers[SANDBOX_NAME]).toBeUndefined()
      expect(result.state.volumes[SANDBOX_VOLUME]).toBeUndefined()
      expect(destructiveTargets(result)).toContain(SANDBOX_VOLUME)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "does not adopt foreign resources created while the app is being quiesced",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.runMode = "failure"
          state.options.createSandbox = false
          state.options.createVolume = false
          state.options.lateSandboxOnAppRemoval = "foreign"
        },
      })

      const foreignSandbox = result.state.containers[SANDBOX_NAME]
      expect(result.code).toBe(1)
      expect(foreignSandbox).toBeDefined()
      expect(result.state.volumes[SANDBOX_VOLUME]).toBeDefined()
      expect(destructiveTargets(result)).not.toContain(foreignSandbox?.id)
      expect(destructiveTargets(result)).not.toContain(SANDBOX_VOLUME)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "retries adoption after TERM interrupts the first sandbox identity inspect",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.hangSandboxIdInspect = true
        },
        signalOnSandboxInspect: "SIGTERM",
      })

      expect(result.code).toBe(143)
      expect(result.signal).toBeNull()
      expect(result.state.containers[SANDBOX_NAME]).toBeUndefined()
      expect(result.state.volumes[SANDBOX_VOLUME]).toBeUndefined()
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "reports TERM before cleaning only adopted ownership",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.runMode = "hang"
        },
        signalOnRunWait: "SIGTERM",
      })

      expect(result.code).toBe(143)
      expect(result.signal).toBeNull()
      expect(result.stderr).toMatch(/diagnostics.*signal=TERM/is)
      const diagnosticIndex = commandIndex(
        result,
        ({ command, args }) => command === "docker" && args[0] === "logs",
      )
      const destructiveIndex = result.transcript.findIndex(isDestructive)
      expect(diagnosticIndex).toBeGreaterThan(-1)
      expect(destructiveIndex).toBeGreaterThan(diagnosticIndex)
      expect(destructiveTargets(result)).toContain(SANDBOX_ID)
      expect(destructiveTargets(result)).toContain(SANDBOX_VOLUME)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "leaves an unexpected concurrent sandbox untouched",
    async () => {
      const unexpectedName = "dawn-sbx-concurrent"
      const result = await runSmoke({
        configure: (state) => {
          state.options.unexpectedSandboxName = unexpectedName
        },
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/unexpected|exactly one/i)
      expect(result.state.containers[unexpectedName]).toBeDefined()
      expect(destructiveTargets(result)).not.toContain(result.state.containers[unexpectedName]?.id)
      expect(destructiveTargets(result)).not.toContain(unexpectedName)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test.each([
    ["thread label", "wrong-thread", VALID_IDENTITY],
    ["identity label", SANITIZED_THREAD_ID, "A".repeat(64)],
  ])(
    "rejects an invalid sandbox %s",
    async (_name, sandboxLabel, identityLabel) => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.runMode = "failure"
          state.options.sandboxLabel = sandboxLabel
          state.options.identityLabel = identityLabel
        },
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/label|identity/i)
      expect(result.state.containers[SANDBOX_NAME]).toBeDefined()
      expect(result.state.volumes[SANDBOX_VOLUME]).toBeDefined()
      expect(destructiveTargets(result)).not.toContain(result.state.containers[SANDBOX_NAME]?.id)
      expect(destructiveTargets(result)).not.toContain(SANDBOX_VOLUME)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "does not claim a sandbox volume that was never observed",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.runMode = "failure"
          state.options.createVolume = false
        },
      })

      expect(result.code).toBe(1)
      expect(result.state.containers[SANDBOX_NAME]).toBeUndefined()
      expect(destructiveTargets(result)).not.toContain(SANDBOX_VOLUME)
    },
    TEST_TIMEOUT_MS,
  )

  test.each([
    [
      "network",
      `network-id:${NETWORK_NAME}`,
      { type: "replace-network", name: NETWORK_NAME },
      [] as const,
    ],
    [
      "aimock",
      `container-id:${AIMOCK_NAME}`,
      { type: "replace-container", name: AIMOCK_NAME },
      [NETWORK_ID] as const,
    ],
    [
      "app",
      `container-id:${APP_NAME}`,
      { type: "replace-container", name: APP_NAME },
      [AIMOCK_ID, NETWORK_ID] as const,
    ],
  ] as const)(
    "rejects an immediate post-create %s identity mismatch without re-adopting the replacement",
    async (_resource, key, action, otherOwnedIds) => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.mutations = [{ key, occurrence: 1, action }]
        },
      })

      const replacement =
        action.type === "replace-network"
          ? result.state.networks[action.name]
          : result.state.containers[action.name]
      const targets = destructiveTargets(result)
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/ownership changed|refusing replacement/i)
      expect(replacement).toBeDefined()
      expect(targets).not.toContain(replacement?.id)
      expect(targets).not.toContain(action.name)
      for (const ownedId of otherOwnedIds) expect(targets).toContain(ownedId)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "rejects an app replacement observed during health polling without re-adopting it",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.failingQueries = [{ key: "healthz", occurrence: 1 }]
          state.options.mutations = [
            {
              key: "healthz",
              occurrence: 1,
              action: { type: "replace-container", name: APP_NAME },
            },
          ]
        },
      })

      const replacement = result.state.containers[APP_NAME]
      const targets = destructiveTargets(result)
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/ownership changed.*healthz/is)
      expect(replacement).toBeDefined()
      expect(targets).not.toContain(replacement?.id)
      expect(targets).not.toContain(APP_NAME)
      expect(targets).toContain(AIMOCK_ID)
      expect(targets).toContain(NETWORK_ID)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test.each([
    ["network", NETWORK_ID],
    ["aimock", AIMOCK_ID],
    ["app", APP_ID],
  ] as const)(
    "cleans an ambiguous %s create that times out after emitting its immutable ID",
    async (resource, expectedId) => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.createHangTarget = resource
        },
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/COMMAND TIMEOUT.*docker/is)
      expectFixedResourceRemoved(result, resource)
      expect(destructiveTargets(result)).toContain(expectedId)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test.each([
    ["network", NETWORK_ID],
    ["aimock", AIMOCK_ID],
    ["app", APP_ID],
  ] as const)(
    "adopts an exact-name %s after an ambiguous create emits no usable ID",
    async (resource, expectedId) => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.createHangTarget = resource
          state.options.createSuppressOutputTarget = resource
        },
      })

      expect(result.code).toBe(1)
      expectFixedResourceRemoved(result, resource)
      expect(destructiveTargets(result)).toContain(expectedId)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test.each([
    ["network", NETWORK_ID],
    ["aimock", AIMOCK_ID],
    ["app", APP_ID],
  ] as const)(
    "cleans an ambiguous %s create when TERM arrives after output",
    async (resource, expectedId) => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.createHangTarget = resource
        },
        signalOnCreateOutput: { resource, signal: "SIGTERM" },
      })

      expect(result.code).toBe(143)
      expect(result.signal).toBeNull()
      expectFixedResourceRemoved(result, resource)
      expect(destructiveTargets(result)).toContain(expectedId)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test.each([
    ["network", "network" as const, NETWORK_NAME, `network-id:${NETWORK_NAME}`, NETWORK_ID],
    ["aimock", "container" as const, AIMOCK_NAME, `container-id:${AIMOCK_NAME}`, AIMOCK_ID],
    ["app", "container" as const, APP_NAME, `container-id:${APP_NAME}`, APP_ID],
  ])(
    "retains the returned %s ID when the follow-up identity read fails",
    async (_description, resource, name, key, expectedId) => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.failingQueries = [{ key, occurrence: 1 }]
        },
      })

      expect(result.code).toBe(1)
      if (resource === "network") expect(result.state.networks[name]).toBeUndefined()
      else expect(result.state.containers[name]).toBeUndefined()
      expect(destructiveTargets(result)).toContain(expectedId)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test.each([
    ["network", "network" as const, NETWORK_NAME, NETWORK_ID],
    ["aimock", "container" as const, AIMOCK_NAME, AIMOCK_ID],
    ["app", "container" as const, APP_NAME, APP_ID],
  ])(
    "retains the returned %s ID when TERM arrives during identity revalidation",
    async (_description, resource, name, expectedId) => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.hangIdentityReadTarget = name
        },
        signalOnIdentityRead: "SIGTERM",
      })

      expect(result.code).toBe(143)
      expect(result.signal).toBeNull()
      if (resource === "network") expect(result.state.networks[name]).toBeUndefined()
      else expect(result.state.containers[name]).toBeUndefined()
      expect(destructiveTargets(result)).toContain(expectedId)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test.each([
    ["app", "container-list:<all>", 4, { type: "replace-container", name: APP_NAME }],
    ["aimock", "container-list:<all>", 5, { type: "replace-container", name: AIMOCK_NAME }],
    ["network", "network-list:<all>", 2, { type: "replace-network", name: NETWORK_NAME }],
  ] as const)(
    "refuses a same-name %s replacement",
    async (_name, key, occurrence, action) => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.runMode = "failure"
          state.options.mutations = [{ key, occurrence, action }]
        },
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/ownership|changed|replacement/i)
      const replacement =
        action.type === "replace-network"
          ? result.state.networks[action.name]
          : result.state.containers[action.name]
      expect(replacement).toBeDefined()
      expect(destructiveTargets(result)).not.toContain(replacement?.id)
      expect(destructiveTargets(result)).not.toContain(action.name)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "refuses a same-name sandbox replacement during assertions",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.mutations = [
            {
              key: "container-user",
              occurrence: 1,
              action: { type: "replace-container", name: SANDBOX_NAME },
            },
          ]
        },
      })

      expect(result.code).toBe(1)
      expect(result.state.containers[SANDBOX_NAME]).toBeDefined()
      expect(result.state.volumes[SANDBOX_VOLUME]).toBeDefined()
      expect(destructiveTargets(result)).not.toContain(result.state.containers[SANDBOX_NAME]?.id)
      expect(destructiveTargets(result)).not.toContain(SANDBOX_VOLUME)
    },
    TEST_TIMEOUT_MS,
  )

  test.each([
    ["ID", { type: "replace-container", name: SANDBOX_NAME }],
    [
      "thread label",
      {
        type: "set-container-label",
        name: SANDBOX_NAME,
        label: "dawn.sandbox",
        value: "replacement",
      },
    ],
    [
      "identity label",
      {
        type: "set-container-label",
        name: SANDBOX_NAME,
        label: "dawn.sandbox.identity",
        value: "c".repeat(64),
      },
    ],
  ] as const)(
    "invalidates container and volume claims after an adopted sandbox %s change",
    async (_name, action) => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.runMode = "failure"
          state.options.mutations = [{ key: "container-list:<all>", occurrence: 6, action }]
        },
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/ownership|label|changed|identity/i)
      expect(result.state.containers[SANDBOX_NAME]).toBeDefined()
      expect(result.state.volumes[SANDBOX_VOLUME]).toBeDefined()
      expect(destructiveTargets(result)).not.toContain(result.state.containers[SANDBOX_NAME]?.id)
      expect(destructiveTargets(result)).not.toContain(SANDBOX_VOLUME)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "detects a same-name volume replacement from its canonical fingerprint",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.sandboxReadonlyRootfs = false
          state.options.mutations = [
            {
              key: `volume-inspect:${SANDBOX_VOLUME}`,
              occurrence: 2,
              action: { type: "replace-volume", name: SANDBOX_VOLUME },
            },
            {
              key: `volume-inspect:${SANDBOX_VOLUME}`,
              occurrence: 2,
              action: { type: "replace-container", name: SANDBOX_NAME },
            },
            {
              key: `volume-inspect:${SANDBOX_VOLUME}`,
              occurrence: 2,
              action: {
                type: "set-container-label",
                name: SANDBOX_NAME,
                label: "dawn.sandbox.identity",
                value: objectId("c"),
              },
            },
          ]
        },
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/fingerprint|ownership|changed/i)
      const replacementContainer = result.state.containers[SANDBOX_NAME]
      expect(replacementContainer).toBeDefined()
      expect(replacementContainer?.id).not.toBe(SANDBOX_ID)
      expect(replacementContainer?.labels["dawn.sandbox.identity"]).toBe(objectId("c"))
      expect(result.state.volumes[SANDBOX_VOLUME]?.CreatedAt).toBe("2026-08-11T00:00:02Z")
      expect(result.state.volumes[SANDBOX_VOLUME]?.Driver).toBe("local")
      expect(result.state.volumes[SANDBOX_VOLUME]?.Labels).toBeNull()
      expect(result.state.volumes[SANDBOX_VOLUME]?.Mountpoint).toBe(
        `/var/lib/docker/volumes/${SANDBOX_VOLUME}/_data`,
      )
      expect(result.state.volumes[SANDBOX_VOLUME]?.Options).toBeNull()
      expect(destructiveTargets(result)).not.toContain(replacementContainer?.id)
      expect(destructiveTargets(result)).not.toContain(SANDBOX_NAME)
      expect(destructiveTargets(result)).not.toContain(SANDBOX_VOLUME)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "skips volume removal when metadata changes after the final name listing",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.runMode = "failure"
          state.options.replaceVolumeAfterAppRemovalList = true
        },
      })

      const replacement = result.state.volumes[SANDBOX_VOLUME]
      expect(result.code).toBe(1)
      expect(replacement?.CreatedAt).toBe("2026-08-11T00:00:02Z")
      expect(replacement?.Driver).toBe("local")
      expect(replacement?.Labels).toBeNull()
      expect(replacement?.Mountpoint).toBe(`/var/lib/docker/volumes/${SANDBOX_VOLUME}/_data`)
      expect(replacement?.Options).toBeNull()
      expect(destructiveTargets(result)).not.toContain(SANDBOX_VOLUME)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "treats a TERM-to-zero cleanup command as timed out",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.cleanupMode = "term-zero"
        },
      })

      expect(result.elapsedMs).toBeLessThan(RUN_WATCHDOG_MS)
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/COMMAND TIMEOUT.*docker rm/is)
      expect(result.stderr).toMatch(/app container ID still exists after removal.*status=124/is)
      expect(result.stderr).toMatch(/----- diagnostics status=0 signal=NONE -----/)
      expect(result.stderr.indexOf("----- diagnostics status=0 signal=NONE -----")).toBeGreaterThan(
        result.stderr.indexOf("COMMAND TIMEOUT"),
      )
      expect(result.state.containers[APP_NAME]).toBeDefined()
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "continues cleanup but fails when TERM-to-zero app removal times out after confirmed absence",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.runMode = "failure"
          state.options.createSandbox = false
          state.options.createVolume = false
          state.options.cleanupMode = "remove-then-term-zero"
          state.options.lateSandboxOnAppRemoval = "owned"
        },
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/COMMAND TIMEOUT.*docker rm/is)
      expect(result.state.containers[APP_NAME]).toBeUndefined()
      expect(result.state.containers[AIMOCK_NAME]).toBeUndefined()
      expect(result.state.networks[NETWORK_NAME]).toBeUndefined()
      expect(result.state.containers[SANDBOX_NAME]).toBeUndefined()
      expect(result.state.volumes[SANDBOX_VOLUME]).toBeUndefined()
      expectFixedObjectsRemovedById(result)
      expect(destructiveTargets(result)).toContain(SANDBOX_VOLUME)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "skips sandbox cleanup when app removal cannot be confirmed",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.runMode = "failure"
          state.options.cleanupMode = "term-zero"
        },
      })

      expect(result.code).toBe(1)
      expect(result.state.containers[APP_NAME]).toBeDefined()
      expect(result.state.containers[SANDBOX_NAME]).toBeDefined()
      expect(result.state.volumes[SANDBOX_VOLUME]).toBeDefined()
      expect(destructiveTargets(result)).not.toContain(SANDBOX_ID)
      expect(destructiveTargets(result)).not.toContain(SANDBOX_VOLUME)
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "does not let a deliberate stdout-holding orphan retain the smoke pipe",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.networkCreateOrphan = true
        },
      })

      expect(result.elapsedMs).toBeLessThan(5_000)
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/COMMAND TIMEOUT.*docker network create/is)
      expect(result.signal).toBeNull()
      expect(result.orphanProcessIds).toHaveLength(1)
      expect(result.activeOrphanProcessIds).toEqual([])
      expect(result.state.networks[NETWORK_NAME]).toBeUndefined()
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "bounds a hanging diagnostic before cleanup",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.runMode = "failure"
          state.options.hangDiagnostic = true
        },
      })

      expect(result.elapsedMs).toBeLessThan(RUN_WATCHDOG_MS)
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/COMMAND TIMEOUT.*docker logs/is)
      const hangingLog = result.stderr.indexOf("FAKE HANG docker logs")
      const timeout = result.stderr.indexOf("COMMAND TIMEOUT")
      const nextLog = result.stderr.indexOf("logs for dawn-smoke-aimock")
      expect(hangingLog).toBeGreaterThan(-1)
      expect(timeout).toBeGreaterThan(hangingLog)
      expect(nextLog).toBeGreaterThan(timeout)
      expect(result.transcript.findIndex(isDestructive)).toBeGreaterThan(
        commandIndex(result, ({ command, args }) => command === "docker" && args[0] === "logs"),
      )
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "bounds a hanging cleanup before continuing",
    async () => {
      const result = await runSmoke({
        configure: (state) => {
          state.options.runMode = "failure"
          state.options.cleanupMode = "ignore-term"
        },
      })

      expect(result.elapsedMs).toBeLessThan(RUN_WATCHDOG_MS)
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/COMMAND TIMEOUT.*docker rm/is)
      expect(result.stderr).toMatch(/app container ID still exists after removal.*status=124/is)
      expect(result.stderr).toMatch(/grace expired.*sending KILL/is)
      expect(result.stderr).toMatch(/----- diagnostics status=1 signal=NONE -----/)
      const cleanupTimeout = result.stderr.indexOf("COMMAND TIMEOUT")
      const diagnosticsOutput = result.stderr.indexOf(
        "----- diagnostics status=1 signal=NONE -----",
      )
      const diagnosticIndex = commandIndex(
        result,
        ({ command, args }) => command === "docker" && args[0] === "logs",
      )
      const appRemoval = commandIndex(
        result,
        ({ command, args }) => command === "docker" && args[0] === "rm" && args.at(-1) === APP_ID,
      )
      const aimockRemoval = commandIndex(
        result,
        ({ command, args }) =>
          command === "docker" && args[0] === "rm" && args.at(-1) === AIMOCK_ID,
      )
      expect(diagnosticIndex).toBeGreaterThan(-1)
      expect(appRemoval).toBeGreaterThan(diagnosticIndex)
      expect(cleanupTimeout).toBeGreaterThan(-1)
      expect(cleanupTimeout).toBeGreaterThan(diagnosticsOutput)
      expect(result.stderr.match(/----- diagnostics status=/g)).toHaveLength(1)
      expect(appRemoval).toBeGreaterThan(-1)
      expect(aimockRemoval).toBeGreaterThan(appRemoval)
      expect(result.state.containers[APP_NAME]).toBeDefined()
      expectForeignObjectsPreserved(result)
    },
    TEST_TIMEOUT_MS,
  )
})

test("the harness invokes the requested smoke script", () => {
  expect(basename(SCRIPT)).toBe("assert-docker.sh")
})
