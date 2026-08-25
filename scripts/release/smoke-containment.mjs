import { spawn } from "node:child_process"
import { randomUUID as defaultRandomUUID } from "node:crypto"
import * as defaultFileSystem from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const CONTROL_OUTER_TIMEOUT_MS = 40_000
const WORKLOAD_OUTER_TIMEOUT_MS = 25 * 60_000 + 15_000
const CONTROL_OUTPUT_BYTES = 1024 * 1024
const READY_ATTEMPTS = 200
const EMPTY_ATTEMPTS = 40
const POLL_MS = 50
const UNIT_PATTERN = /^dawn-release-smoke-[0-9a-f]{32}\.service$/u
const IMAGE_VALUE_PATTERN = /^[A-Za-z0-9._+-]{1,128}$/u
const DEFAULT_PATHS = Object.freeze({
  sudo: "/usr/bin/sudo",
  timeout: "/usr/bin/timeout",
  systemdRun: "/usr/bin/systemd-run",
  systemctl: "/usr/bin/systemctl",
  tee: "/usr/bin/tee",
})
const REQUIRED_LIVE_PROPERTIES = Object.freeze({
  ActiveState: "active",
  SubState: "running",
  Type: "exec",
  KillMode: "control-group",
  NoNewPrivileges: "yes",
  RestrictSUIDSGID: "yes",
  CapabilityBoundingSet: "",
  AmbientCapabilities: "",
  Delegate: "no",
  ProtectControlGroups: "yes",
  UMask: "0077",
})
const SHOW_PROPERTIES = Object.freeze(["ControlGroup", ...Object.keys(REQUIRED_LIVE_PROPERTIES)])
const SHIM_PATH = fileURLToPath(new URL("./smoke-command-shim.mjs", import.meta.url))

export function createSystemdCgroupContainment(overrides = {}) {
  const dependencies = {
    environment: process.env,
    fileSystem: defaultFileSystem,
    gid: typeof process.getgid === "function" ? process.getgid() : null,
    nodePath: process.execPath,
    paths: DEFAULT_PATHS,
    platform: process.platform,
    randomUUID: defaultRandomUUID,
    shimPath: SHIM_PATH,
    sleep: (milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    spawnClient: defaultSpawnClient,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    ...overrides,
  }
  validateDependencies(dependencies)
  let capability = null
  let probePromise = null

  return Object.freeze({
    async probe({ signal } = {}) {
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new TypeError("Containment probe signal must be an AbortSignal")
      }
      if (signal?.aborted) throw abortError("Strict containment capability probe was aborted")
      if (capability !== null) return capability
      probePromise ??= performProbe(dependencies, signal)
      try {
        capability = await probePromise
        return capability
      } catch (error) {
        probePromise = null
        capability = null
        throw error
      }
    },

    async runContained(invocation) {
      if (capability === null) {
        throw new Error("Strict systemd/cgroup-v2 capability was not proven")
      }
      return performContainedInvocation(dependencies, invocation)
    },
  })
}

export function buildControlClientInvocation(paths, executable, args) {
  assertFixedPaths(paths)
  if (![paths.systemctl, paths.systemdRun, paths.tee].includes(executable)) {
    throw new TypeError("Privileged control executable is not fixed")
  }
  assertStringArray(args, "Privileged control arguments")
  return Object.freeze({
    command: paths.sudo,
    args: Object.freeze([
      "-n",
      paths.timeout,
      "--signal=TERM",
      "--kill-after=5s",
      "30s",
      executable,
      ...args,
    ]),
    outerTimeoutMs: CONTROL_OUTER_TIMEOUT_MS,
  })
}

export function buildWorkloadClientInvocation(paths, systemdRunArgs) {
  assertFixedPaths(paths)
  assertStringArray(systemdRunArgs, "systemd-run arguments")
  return Object.freeze({
    command: paths.sudo,
    args: Object.freeze([
      "-n",
      paths.timeout,
      "--signal=TERM",
      "--kill-after=10s",
      "25m",
      paths.systemdRun,
      ...systemdRunArgs,
    ]),
    outerTimeoutMs: WORKLOAD_OUTER_TIMEOUT_MS,
  })
}

export function buildSystemdRunArguments({
  cwd,
  descriptorPath,
  gid,
  nodePath,
  runtimeMaxSec,
  shimPath,
  timeoutStopSec,
  uid,
  unit,
}) {
  if (
    typeof cwd !== "string" ||
    !path.isAbsolute(cwd) ||
    typeof descriptorPath !== "string" ||
    !path.isAbsolute(descriptorPath) ||
    typeof nodePath !== "string" ||
    !path.isAbsolute(nodePath) ||
    typeof shimPath !== "string" ||
    !path.isAbsolute(shimPath) ||
    !Number.isSafeInteger(uid) ||
    uid < 1 ||
    !Number.isSafeInteger(gid) ||
    gid < 1 ||
    !Number.isSafeInteger(runtimeMaxSec) ||
    runtimeMaxSec < 1 ||
    runtimeMaxSec > 20 * 60 ||
    !Number.isSafeInteger(timeoutStopSec) ||
    timeoutStopSec < 1 ||
    timeoutStopSec > 30 ||
    typeof unit !== "string" ||
    !UNIT_PATTERN.test(unit)
  ) {
    throw new TypeError("Transient smoke unit inputs are invalid")
  }
  return Object.freeze([
    "--wait",
    "--pipe",
    "--expand-environment=no",
    "--unit",
    unit,
    "--uid",
    String(uid),
    "--gid",
    String(gid),
    "--working-directory",
    cwd,
    "--property=Type=exec",
    "--property=KillMode=control-group",
    "--property=NoNewPrivileges=yes",
    "--property=RestrictSUIDSGID=yes",
    "--property=CapabilityBoundingSet=",
    "--property=AmbientCapabilities=",
    "--property=Delegate=no",
    "--property=ProtectControlGroups=yes",
    "--property=UMask=0077",
    `--property=RuntimeMaxSec=${runtimeMaxSec}s`,
    `--property=TimeoutStopSec=${timeoutStopSec}s`,
    nodePath,
    shimPath,
    descriptorPath,
  ])
}

export function validateLiveUnitProperties(output, unit) {
  if (typeof output !== "string" || typeof unit !== "string" || !UNIT_PATTERN.test(unit)) {
    throw new Error("Live systemd unit property response is invalid")
  }
  const values = new Map()
  for (const line of output.trimEnd().split("\n")) {
    const separator = line.indexOf("=")
    if (separator < 1) throw new Error("Live systemd unit property response is malformed")
    const key = line.slice(0, separator)
    if (!SHOW_PROPERTIES.includes(key) || values.has(key)) {
      throw new Error("Live systemd unit property response contains unexpected fields")
    }
    values.set(key, line.slice(separator + 1))
  }
  if (values.size !== SHOW_PROPERTIES.length) {
    throw new Error("Live systemd unit property response is incomplete")
  }
  for (const [key, expected] of Object.entries(REQUIRED_LIVE_PROPERTIES)) {
    if (values.get(key) !== expected) {
      throw new Error(`Live systemd unit property ${key} is not exact`)
    }
  }
  const expectedControlGroup = `/system.slice/${unit}`
  if (values.get("ControlGroup") !== expectedControlGroup) {
    throw new Error("Live systemd unit control group is not exact")
  }
  return Object.freeze({ controlGroup: expectedControlGroup })
}

export function parseCgroupEvents(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 16 * 1024) {
    throw new Error("cgroup.events is missing or exceeds its bound")
  }
  let populated = null
  for (const line of output.trimEnd().split("\n")) {
    const match = /^([a-z_]+) ([0-9]+)$/u.exec(line)
    if (match === null) throw new Error("cgroup.events is malformed")
    if (match[1] === "populated") {
      if (populated !== null || (match[2] !== "0" && match[2] !== "1")) {
        throw new Error("cgroup.events populated value is invalid")
      }
      populated = Number(match[2])
    }
  }
  if (populated === null) throw new Error("cgroup.events lacks populated state")
  return Object.freeze({ populated })
}

async function performProbe(dependencies, signal) {
  if (dependencies.platform !== "linux") {
    throw new Error("Strict smoke containment is unsupported outside Linux")
  }
  if (!Number.isSafeInteger(dependencies.uid) || dependencies.uid < 1) {
    throw new Error("Strict smoke containment requires a non-root numeric UID")
  }
  if (!Number.isSafeInteger(dependencies.gid) || dependencies.gid < 1) {
    throw new Error("Strict smoke containment requires a non-root numeric GID")
  }
  const imageOS = validatedImageValue(dependencies.environment.ImageOS, "ImageOS")
  const imageVersion = validatedImageValue(dependencies.environment.ImageVersion, "ImageVersion")
  if (imageOS !== "ubuntu24") {
    throw new Error("Strict smoke containment requires the ubuntu-24.04 runner image")
  }
  await verifyUnifiedCgroupV2(dependencies)
  for (const executable of Object.values(dependencies.paths)) {
    await verifyRootOwnedExecutable(dependencies.fileSystem, executable)
  }
  const version = await runControl(dependencies, dependencies.paths.systemdRun, ["--version"])
  if (!/^systemd 255(?:\s|$)/u.test(version.stdout)) {
    throw new Error("Strict smoke containment requires stock systemd 255")
  }
  if (signal?.aborted) throw abortError("Strict containment capability probe was aborted")
  const result = await performContainedInvocation(
    dependencies,
    {
      command: "/usr/bin/true",
      args: [],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
      acceptedExitCodes: [0],
      ...(signal === undefined ? {} : { signal }),
    },
    { probe: true },
  )
  if (result.exitCode !== 0) throw new Error("Strict smoke containment probe workload failed")
  return Object.freeze({ adapter: "systemd-cgroup-v2", imageOS, imageVersion })
}

async function performContainedInvocation(dependencies, invocation, { probe = false } = {}) {
  validateInvocation(invocation)
  if (!probe && dependencies.platform !== "linux") {
    throw new Error("Strict smoke containment is unsupported outside Linux")
  }
  const token = dependencies.randomUUID().replaceAll("-", "")
  if (!/^[0-9a-f]{32}$/u.test(token)) throw new Error("Containment unit nonce is invalid")
  const unit = `dawn-release-smoke-${token}.service`
  const root = await dependencies.fileSystem.mkdtemp(path.join(os.tmpdir(), "dawn-smoke-control-"))
  const descriptorPath = path.join(root, "command.json")
  const readyPath = path.join(root, "ready")
  const gatePath = path.join(root, "gate")
  let workload = null
  let cgroupPath = null
  let primaryError = null
  let result = null
  const cleanupErrors = []

  try {
    await dependencies.fileSystem.chmod(root, 0o700)
    const descriptor = canonicalDescriptor({
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd,
      env: invocation.env,
      gatePath,
      readyPath,
    })
    await dependencies.fileSystem.writeFile(descriptorPath, descriptor, {
      flag: "wx",
      mode: 0o600,
    })
    const systemdArgs = buildSystemdRunArguments({
      cwd: invocation.cwd,
      descriptorPath,
      gid: dependencies.gid,
      nodePath: dependencies.nodePath,
      runtimeMaxSec: Math.max(1, Math.ceil(invocation.timeoutMs / 1_000)),
      shimPath: dependencies.shimPath,
      timeoutStopSec: 10,
      uid: dependencies.uid,
      unit,
    })
    const clientInvocation = buildWorkloadClientInvocation(dependencies.paths, systemdArgs)
    workload = dependencies.spawnClient({
      ...clientInvocation,
      cwd: "/tmp",
      maxOutputBytes: invocation.maxOutputBytes,
    })
    validateClientHandle(workload)
    await waitForReady(dependencies, workload, readyPath)
    const live = await showLiveUnit(dependencies, unit)
    const properties = validateLiveUnitProperties(live.stdout, unit)
    cgroupPath = validatedCgroupPath(properties.controlGroup, unit)
    await verifyCgroupControlFiles(dependencies.fileSystem, cgroupPath)
    if (invocation.signal?.aborted) throw abortError("Contained smoke command was aborted")
    await dependencies.fileSystem.writeFile(gatePath, "go\n", { flag: "wx", mode: 0o600 })
    const outcome = await awaitWorkloadOutcome(workload, invocation)
    if (outcome.type === "done") {
      result = outcome.result
    } else {
      primaryError = outcome.error
    }
  } catch (error) {
    primaryError = error
  }

  if (workload !== null) {
    try {
      await cleanupContainedUnit(dependencies, { cgroupPath, unit, workload })
    } catch (error) {
      cleanupErrors.push(...flattenErrors(error))
    }
  }
  try {
    await dependencies.fileSystem.rm(root, { recursive: true, force: true })
  } catch (error) {
    cleanupErrors.push(error)
  }

  if (primaryError !== null || cleanupErrors.length > 0) {
    const errors = [...(primaryError === null ? [] : [primaryError]), ...cleanupErrors]
    if (errors.length === 1) throw errors[0]
    throw new AggregateError(errors, "Contained smoke workload and cleanup did not both succeed")
  }
  if (result === null) throw new Error("Contained smoke workload produced no result")
  return result
}

async function awaitWorkloadOutcome(workload, invocation) {
  let timeout
  let abortListener
  const timeoutPromise = new Promise((resolvePromise) => {
    timeout = setTimeout(() => {
      const error = new Error(`Contained smoke command timed out after ${invocation.timeoutMs}ms`)
      error.code = "ETIMEDOUT"
      error.timeoutMs = invocation.timeoutMs
      resolvePromise({ type: "failure", error })
    }, invocation.timeoutMs)
  })
  const abortPromise =
    invocation.signal === undefined
      ? new Promise(() => {})
      : new Promise((resolvePromise) => {
          abortListener = () =>
            resolvePromise({
              type: "failure",
              error: abortError("Contained smoke command was aborted"),
            })
          invocation.signal.addEventListener("abort", abortListener, { once: true })
        })
  try {
    return await Promise.race([
      workload.done.then(
        (result) => ({ type: "done", result }),
        (error) => ({ type: "failure", error }),
      ),
      workload.outputLimit.then((error) => ({ type: "failure", error })),
      timeoutPromise,
      abortPromise,
    ])
  } finally {
    clearTimeout(timeout)
    if (abortListener !== undefined) invocation.signal?.removeEventListener("abort", abortListener)
  }
}

async function cleanupContainedUnit(dependencies, { cgroupPath, unit, workload }) {
  const errors = []
  let inactiveProven = false
  let cgroupRemoved = false
  if (cgroupPath !== null) {
    try {
      cgroupRemoved =
        (await readPopulated(dependencies, cgroupPath, { allowMissing: true })) === null
      inactiveProven = cgroupRemoved
    } catch (error) {
      errors.push(error)
    }
  }

  if (!cgroupRemoved) {
    try {
      const state = await showUnitState(dependencies, unit)
      inactiveProven = state !== "active" && state !== "activating" && state !== "deactivating"
      if (!inactiveProven) {
        await runControl(dependencies, dependencies.paths.systemctl, [
          "kill",
          "--kill-whom=all",
          "--signal=TERM",
          unit,
        ])
      }
    } catch (error) {
      const removal = await proveCgroupRemovalAfterControlFailure(
        dependencies,
        cgroupPath,
        unit,
        error,
        errors,
      )
      cgroupRemoved ||= removal
      inactiveProven ||= removal
    }
  }

  if (!cgroupRemoved && cgroupPath !== null) {
    try {
      const populated = await readPopulated(dependencies, cgroupPath, {
        allowMissing: inactiveProven,
      })
      if (populated === 1) {
        await runControl(
          dependencies,
          dependencies.paths.tee,
          ["--", path.join(cgroupPath, "cgroup.kill")],
          { input: "1\n" },
        )
      }
      await waitForEmptyCgroup(dependencies, cgroupPath, { allowMissing: inactiveProven })
    } catch (error) {
      errors.push(error)
    }
  }

  if (!cgroupRemoved) {
    for (const args of [
      ["stop", unit],
      ["reset-failed", unit],
    ]) {
      try {
        await runControl(dependencies, dependencies.paths.systemctl, args)
      } catch (error) {
        const removal = await proveCgroupRemovalAfterControlFailure(
          dependencies,
          cgroupPath,
          unit,
          error,
          errors,
        )
        if (removal) {
          cgroupRemoved = true
          break
        }
      }
    }
    inactiveProven = true
  }

  if (cgroupPath !== null && !cgroupRemoved) {
    try {
      await waitForEmptyCgroup(dependencies, cgroupPath, { allowMissing: true })
    } catch (error) {
      errors.push(error)
    }
  }
  try {
    await workload.terminateAndReap()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, "Strict containment cleanup failed")
}

async function proveCgroupRemovalAfterControlFailure(
  dependencies,
  cgroupPath,
  unit,
  controlError,
  errors,
) {
  if (cgroupPath === null || !isExactMissingUnitControlError(controlError, unit)) {
    errors.push(controlError)
    return false
  }
  try {
    const populated = await readPopulated(dependencies, cgroupPath, { allowMissing: true })
    if (populated === null) return true
    errors.push(controlError)
  } catch (proofError) {
    errors.push(controlError, proofError)
  }
  return false
}

function isExactMissingUnitControlError(error, unit) {
  if (
    error?.code !== "ECONTROL" ||
    error.executable !== DEFAULT_PATHS.systemctl ||
    typeof error.stderr !== "string"
  ) {
    return false
  }
  return new Set([
    `Unit ${unit} could not be found.\n`,
    `Failed to stop ${unit}: Unit ${unit} not loaded.\n`,
    `Failed to reset failed state of unit ${unit}: Unit ${unit} not loaded.\n`,
  ]).has(error.stderr)
}

async function runControl(dependencies, executable, args, { input } = {}) {
  const invocation = buildControlClientInvocation(dependencies.paths, executable, args)
  const client = dependencies.spawnClient({
    ...invocation,
    cwd: "/tmp",
    maxOutputBytes: CONTROL_OUTPUT_BYTES,
    ...(input === undefined ? {} : { input }),
  })
  validateClientHandle(client)
  const outcome = await Promise.race([
    client.outputLimit.then((error) => ({ type: "output-limit", error })),
    client.done.then(
      (result) => ({ type: "done", result }),
      (error) => ({ type: "client-error", error }),
    ),
  ])
  if (outcome.type === "output-limit") {
    try {
      await client.terminateAndReap()
    } catch (cleanupError) {
      throw new AggregateError(
        [outcome.error, cleanupError],
        "Privileged control output limit and client reap both failed",
      )
    }
    throw outcome.error
  }
  if (outcome.type === "client-error") throw outcome.error
  const { result } = outcome
  if (result.exitCode !== 0) {
    const error = new Error(
      `Privileged control command ${executable} failed with exit code ${result.exitCode}: ${result.stderr}`,
    )
    error.code = "ECONTROL"
    error.executable = executable
    error.exitCode = result.exitCode
    error.stderr = result.stderr
    throw error
  }
  return result
}

async function showLiveUnit(dependencies, unit) {
  return runControl(dependencies, dependencies.paths.systemctl, [
    "show",
    "--no-pager",
    `--property=${SHOW_PROPERTIES.join(",")}`,
    unit,
  ])
}

async function showUnitState(dependencies, unit) {
  const result = await runControl(dependencies, dependencies.paths.systemctl, [
    "show",
    "--no-pager",
    "--property=ActiveState",
    "--value",
    unit,
  ])
  const state = result.stdout.trim()
  if (!new Set(["active", "activating", "deactivating", "inactive", "failed"]).has(state)) {
    throw new Error("Transient smoke unit active state is invalid")
  }
  return state
}

async function waitForReady(dependencies, workload, readyPath) {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    const ready = await readOptionalFile(dependencies.fileSystem, readyPath)
    if (ready !== null) {
      if (ready !== "ready\n") throw new Error("Containment shim readiness marker is malformed")
      return
    }
    const completed = await Promise.race([
      workload.done.then(
        (result) => ({ done: true, result }),
        (error) => ({ done: true, error }),
      ),
      dependencies.sleep(POLL_MS).then(() => ({ done: false })),
    ])
    if (completed.done) {
      if (completed.error !== undefined) throw completed.error
      throw new Error(
        `Containment shim exited before readiness with code ${completed.result.exitCode}`,
      )
    }
  }
  throw new Error("Containment shim readiness timed out before workload gate")
}

async function waitForEmptyCgroup(dependencies, cgroupPath, { allowMissing }) {
  for (let attempt = 0; attempt < EMPTY_ATTEMPTS; attempt += 1) {
    const populated = await readPopulated(dependencies, cgroupPath, { allowMissing })
    if (populated === null || populated === 0) return
    if (attempt + 1 < EMPTY_ATTEMPTS) await dependencies.sleep(POLL_MS)
  }
  throw new Error("Strict containment cgroup remained populated after hard kill")
}

async function readPopulated(dependencies, cgroupPath, { allowMissing }) {
  try {
    return parseCgroupEvents(
      await dependencies.fileSystem.readFile(path.join(cgroupPath, "cgroup.events"), "utf8"),
    ).populated
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null
    throw error
  }
}

async function verifyUnifiedCgroupV2(dependencies) {
  const mountInfo = await dependencies.fileSystem.readFile("/proc/self/mountinfo", "utf8")
  const unified = mountInfo
    .split("\n")
    .some((line) => /\s\/sys\/fs\/cgroup\s[^-]*\s-\scgroup2\s/u.test(line))
  if (!unified) throw new Error("Strict smoke containment requires unified cgroup v2")
  const controllers = await dependencies.fileSystem.lstat("/sys/fs/cgroup/cgroup.controllers")
  if (!controllers.isFile()) throw new Error("Unified cgroup v2 controllers file is missing")
}

async function verifyRootOwnedExecutable(fileSystem, executable) {
  const status = await fileSystem.lstat(executable)
  if (
    !status.isFile() ||
    status.uid !== 0 ||
    (status.mode & 0o111) === 0 ||
    (status.mode & 0o022) !== 0
  ) {
    throw new Error(`Strict containment executable ${executable} is not root-owned and immutable`)
  }
}

async function verifyCgroupControlFiles(fileSystem, cgroupPath) {
  for (const name of ["cgroup.events", "cgroup.kill"]) {
    const status = await fileSystem.lstat(path.join(cgroupPath, name))
    if (!status.isFile()) throw new Error(`Strict containment ${name} control is missing`)
  }
}

function validatedCgroupPath(controlGroup, unit) {
  if (controlGroup !== `/system.slice/${unit}`) {
    throw new Error("Strict containment control group escaped its exact unit path")
  }
  const resolved = path.resolve("/sys/fs/cgroup", `.${controlGroup}`)
  if (!resolved.startsWith("/sys/fs/cgroup/system.slice/") || path.basename(resolved) !== unit) {
    throw new Error("Strict containment control-group filesystem path is unsafe")
  }
  return resolved
}

function canonicalDescriptor({ command, args, cwd, env, gatePath, readyPath }) {
  return Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, command, args, cwd, env, readyPath, gatePath })}\n`,
    "utf8",
  )
}

function defaultSpawnClient({ args, command, cwd, input, maxOutputBytes, outerTimeoutMs }) {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env: { PATH: "/usr/bin:/bin" },
    shell: false,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  let outputBytes = 0
  let outputLimitResolve
  let outputLimitReached = false
  const outputLimit = new Promise((resolvePromise) => {
    outputLimitResolve = resolvePromise
  })
  let settled = false
  let outerTimer
  let doneResolve
  let doneReject
  const done = new Promise((resolvePromise, rejectPromise) => {
    doneResolve = resolvePromise
    doneReject = rejectPromise
  })
  const append = (target, chunk) => {
    outputBytes += chunk.byteLength
    if (outputBytes > maxOutputBytes) {
      if (!outputLimitReached) {
        outputLimitReached = true
        const error = new Error(
          `Privileged client exceeded its ${maxOutputBytes}-byte output limit`,
        )
        error.code = "EOUTPUTLIMIT"
        error.maxOutputBytes = maxOutputBytes
        outputLimitResolve(error)
      }
      return target
    }
    return target + chunk.toString("utf8")
  }
  child.stdout.on("data", (chunk) => {
    stdout = append(stdout, chunk)
  })
  child.stderr.on("data", (chunk) => {
    stderr = append(stderr, chunk)
  })
  child.once("error", (error) => {
    if (settled) return
    settled = true
    clearTimeout(outerTimer)
    doneReject(error)
  })
  child.once("close", (exitCode, signal) => {
    if (settled) return
    settled = true
    clearTimeout(outerTimer)
    doneResolve({
      stdout,
      stderr,
      exitCode: Number.isSafeInteger(exitCode) ? exitCode : 128,
      signal: typeof signal === "string" ? signal : null,
    })
  })
  if (input !== undefined) child.stdin.end(input)
  outerTimer = setTimeout(() => {
    if (settled) return
    signalClientTree(child, "SIGTERM")
    setTimeout(() => signalClientTree(child, "SIGKILL"), 5_000).unref()
  }, outerTimeoutMs)

  return Object.freeze({
    done,
    outputLimit,
    async terminateAndReap() {
      if (!settled) signalClientTree(child, "SIGTERM")
      return done
    },
  })
}

function signalClientTree(child, signal) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        child.kill(signal)
      } catch {
        // The outer timeout remains the final bound if the local signal is rejected.
      }
    }
  }
}

function validateClientHandle(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    !(value.done instanceof Promise) ||
    !(value.outputLimit instanceof Promise) ||
    typeof value.terminateAndReap !== "function"
  ) {
    throw new TypeError("Privileged client handle is invalid")
  }
}

function validateDependencies(value) {
  assertFixedPaths(value.paths)
  if (
    typeof value.platform !== "string" ||
    typeof value.nodePath !== "string" ||
    !path.isAbsolute(value.nodePath) ||
    typeof value.shimPath !== "string" ||
    !path.isAbsolute(value.shimPath) ||
    typeof value.randomUUID !== "function" ||
    typeof value.sleep !== "function" ||
    typeof value.spawnClient !== "function" ||
    value.fileSystem === null ||
    typeof value.fileSystem !== "object"
  ) {
    throw new TypeError("Systemd containment dependencies are invalid")
  }
  for (const method of ["chmod", "lstat", "mkdtemp", "readFile", "rm", "writeFile"]) {
    if (typeof value.fileSystem[method] !== "function") {
      throw new TypeError(`Systemd containment file system must expose ${method}`)
    }
  }
}

function validateInvocation(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.command !== "string" ||
    !Array.isArray(value.args) ||
    typeof value.cwd !== "string" ||
    !path.isAbsolute(value.cwd) ||
    value.env === null ||
    typeof value.env !== "object" ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 1 ||
    value.timeoutMs > 20 * 60_000 ||
    !Number.isSafeInteger(value.maxOutputBytes) ||
    value.maxOutputBytes < 1 ||
    !Array.isArray(value.acceptedExitCodes) ||
    (value.signal !== undefined && !(value.signal instanceof AbortSignal))
  ) {
    throw new TypeError("Contained smoke invocation is invalid")
  }
}

function assertFixedPaths(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(DEFAULT_PATHS).some(
      (key) => typeof value[key] !== "string" || value[key] !== DEFAULT_PATHS[key],
    )
  ) {
    throw new TypeError("Strict containment executable paths are not exact")
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || /\0/u.test(item))) {
    throw new TypeError(`${label} are invalid`)
  }
}

async function readOptionalFile(fileSystem, filePath) {
  try {
    return await fileSystem.readFile(filePath, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

function validatedImageValue(value, label) {
  if (typeof value !== "string" || !IMAGE_VALUE_PATTERN.test(value)) {
    throw new Error(`Strict smoke containment ${label} is missing or invalid`)
  }
  return value
}

function flattenErrors(error) {
  return error instanceof AggregateError ? error.errors.flatMap(flattenErrors) : [error]
}

function abortError(message) {
  const error = new Error(message)
  error.name = "AbortError"
  error.code = "ABORT_ERR"
  return error
}
