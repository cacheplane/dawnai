import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"
import { runPublishedHarnessSmoke } from "../smoke/published-harness.mjs"
import { runRuntimeTargetsSmoke } from "../smoke/runtime-targets.mjs"
import { runScaffoldSmoke } from "../smoke/scaffold.mjs"
import { runStorageSmoke } from "../smoke/storage.mjs"
import {
  canonicalSmokeCommandDescriptor,
  parseSmokeCommandDescriptor,
} from "../smoke-command-shim.mjs"
import * as containmentModule from "../smoke-containment.mjs"
import {
  buildControlClientInvocation,
  buildSystemdRunArguments,
  buildWorkloadClientInvocation,
  createSystemdCgroupContainment,
  parseCgroupEvents,
  validateLiveUnitProperties,
} from "../smoke-containment.mjs"
import { createStrictSmokeProcessRunner } from "../smoke-process-runner.mjs"
import { parseSmokeResult } from "../smoke-result.mjs"

const PATHS = Object.freeze({
  sudo: "/usr/bin/sudo",
  timeout: "/usr/bin/timeout",
  systemdRun: "/usr/bin/systemd-run",
  systemctl: "/usr/bin/systemctl",
  tee: "/usr/bin/tee",
})

test("privileged control and workload clients use fixed timeout and hard-kill profiles", () => {
  assert.deepEqual(buildControlClientInvocation(PATHS, PATHS.systemctl, ["show", "dawn.service"]), {
    command: "/usr/bin/sudo",
    args: [
      "-n",
      "/usr/bin/timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "30s",
      "/usr/bin/systemctl",
      "show",
      "dawn.service",
    ],
    outerTimeoutMs: 40_000,
  })
  assert.deepEqual(buildWorkloadClientInvocation(PATHS, ["--wait", "--pipe"]), {
    command: "/usr/bin/sudo",
    args: [
      "-n",
      "/usr/bin/timeout",
      "--signal=TERM",
      "--kill-after=10s",
      "25m",
      "/usr/bin/systemd-run",
      "--wait",
      "--pipe",
    ],
    outerTimeoutMs: 25 * 60_000 + 15_000,
  })
})

test("a reaped privileged client hard-kills TERM-ignoring descendants before cancelling escalation", async () => {
  assert.equal(typeof containmentModule.spawnPrivilegedClient, "function")
  const child = new EventEmitter()
  child.pid = 42_424
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const timers = []
  const cleared = []
  const signals = []
  const handle = containmentModule.spawnPrivilegedClient(
    {
      command: "/usr/bin/true",
      args: [],
      cwd: "/tmp",
      maxOutputBytes: 1_024,
      outerTimeoutMs: 1_000,
    },
    {
      spawnImpl() {
        return child
      },
      signalTree(_child, signal) {
        signals.push(signal)
      },
      setTimer(callback) {
        const token = { callback, unref() {} }
        timers.push(token)
        return token
      },
      clearTimer(token) {
        cleared.push(token)
      },
    },
  )
  timers[0].callback()
  assert.deepEqual(signals, ["SIGTERM"])
  assert.equal(timers.length, 2)
  child.emit("close", 143, "SIGTERM")
  assert.equal((await handle.done).signal, "SIGTERM")
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
  assert.equal(cleared.includes(timers[0]), true)
  assert.equal(cleared.includes(timers[1]), true)
  timers[1].callback()
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
})

test("explicit privileged-client teardown escalates when the process group ignores TERM", async () => {
  const child = new EventEmitter()
  child.pid = 42_425
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const timers = []
  const signals = []
  const handle = containmentModule.spawnPrivilegedClient(
    {
      command: "/usr/bin/true",
      args: [],
      cwd: "/tmp",
      maxOutputBytes: 1_024,
      outerTimeoutMs: 1_000,
    },
    {
      spawnImpl() {
        return child
      },
      signalTree(_child, signal) {
        signals.push(signal)
      },
      setTimer(callback) {
        const token = { callback, unref() {} }
        timers.push(token)
        return token
      },
      clearTimer() {},
    },
  )

  const reaped = handle.terminateAndReap()
  assert.deepEqual(signals, ["SIGTERM"])
  assert.equal(timers.length, 2)
  timers[1].callback()
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
  child.emit("close", null, "SIGKILL")
  assert.equal((await reaped).signal, "SIGKILL")
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
})

test("transient units use the exact hardened gated service policy", () => {
  const args = buildSystemdRunArguments({
    cwd: "/tmp/consumer",
    descriptorPath: "/tmp/control/command.json",
    gid: 1_001,
    nodePath: "/opt/node/bin/node",
    runtimeMaxSec: 600,
    shimPath: "/repo/scripts/release/smoke-command-shim.mjs",
    timeoutStopSec: 10,
    uid: 1_000,
    unit: "dawn-release-smoke-0123456789abcdef0123456789abcdef.service",
  })
  assert.deepEqual(args.slice(0, 4), ["--wait", "--pipe", "--expand-environment=no", "--unit"])
  assert.equal(args.includes("--collect"), false)
  assert.equal(args.includes("--foreground"), false)
  assert.equal(
    args.some((arg) => /RemainAfterExit/u.test(arg)),
    false,
  )
  for (const property of [
    "Type=exec",
    "KillMode=control-group",
    "NoNewPrivileges=yes",
    "RestrictSUIDSGID=yes",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "Delegate=no",
    "ProtectControlGroups=yes",
    "UMask=0077",
    "RuntimeMaxSec=600s",
    "TimeoutStopSec=10s",
  ]) {
    assert.equal(args.includes(`--property=${property}`), true, property)
  }
  assert.deepEqual(args.slice(-3), [
    "/opt/node/bin/node",
    "/repo/scripts/release/smoke-command-shim.mjs",
    "/tmp/control/command.json",
  ])
})

test("live properties and cgroup events are parsed fail closed", () => {
  const properties = validateLiveUnitProperties(
    [
      "ActiveState=active",
      "SubState=running",
      "ControlGroup=/system.slice/dawn-release-smoke-0123456789abcdef0123456789abcdef.service",
      "Type=exec",
      "KillMode=control-group",
      "NoNewPrivileges=yes",
      "RestrictSUIDSGID=yes",
      "CapabilityBoundingSet=",
      "AmbientCapabilities=",
      "Delegate=no",
      "ProtectControlGroups=yes",
      "UMask=0077",
    ].join("\n"),
    "dawn-release-smoke-0123456789abcdef0123456789abcdef.service",
  )
  assert.equal(
    properties.controlGroup,
    "/system.slice/dawn-release-smoke-0123456789abcdef0123456789abcdef.service",
  )
  assert.deepEqual(parseCgroupEvents("populated 1\nfrozen 0\n"), { populated: 1 })
  assert.throws(() => parseCgroupEvents("populated 2\n"), /populated/iu)
  assert.throws(
    () => validateLiveUnitProperties("ActiveState=active\nProtectControlGroups=no\n", "x.service"),
    /property|control group|exact/iu,
  )
})

test("strict runner refuses workloads until its capability probe succeeds", async () => {
  const calls = []
  const containment = {
    async probe() {
      calls.push("probe")
      return { adapter: "systemd-cgroup-v2", imageOS: "ubuntu24", imageVersion: "20260818.1" }
    },
    async runContained(input) {
      calls.push(input)
      return { stdout: "ok", stderr: "", exitCode: 0 }
    },
  }
  const runner = createStrictSmokeProcessRunner({ containment })
  await assert.rejects(runner.runCommand("node", ["probe.mjs"]), /probe|capability/iu)
  assert.deepEqual(calls, [])
  const capability = await runner.probe()
  assert.equal(capability.adapter, "systemd-cgroup-v2")
  assert.deepEqual(await runner.runCommand("node", ["probe.mjs"], { cwd: "/tmp" }), {
    stdout: "ok",
    stderr: "",
  })
  assert.equal(calls[0], "probe")
  assert.equal(calls[1].command, "node")
})

test("unsupported hosts refuse before spawning a capability workload", async () => {
  let spawned = false
  const containment = createSystemdCgroupContainment({
    platform: "darwin",
    async spawnClient() {
      spawned = true
      throw new Error("must not spawn")
    },
  })
  await assert.rejects(containment.probe(), /linux|unsupported/iu)
  assert.equal(spawned, false)
})

test("probe rejects missing cgroup v2 or mutable privileged executables before spawning", async () => {
  for (const [configuration, expected] of [
    [{ mountInfo: "" }, /cgroup v2/iu],
    [{ executableStatus: fileStatus({ mode: 0o100755, uid: 1_000 }) }, /root-owned/iu],
    [{ executableStatus: fileStatus({ mode: 0o100775, uid: 0 }) }, /root-owned|immutable/iu],
  ]) {
    const harness = systemdHarness(configuration)
    await assert.rejects(harness.containment.probe(), expected)
    assert.deepEqual(harness.calls, [])
  }
})

test("privileged control output overflow terminates and reaps its bounded client", async () => {
  const harness = systemdHarness({ controlOutputOverflow: true })
  await assert.rejects(harness.containment.probe(), /output limit/iu)
  assert.equal(harness.controlReapCalls, 1)
})

test("production smoke modules expose no generic command-runner override", async () => {
  const lanes = [
    ["published-harness", runPublishedHarnessSmoke],
    ["runtime-targets", runRuntimeTargetsSmoke],
    ["scaffold", runScaffoldSmoke],
    ["storage", runStorageSmoke],
  ]
  const options = {
    version: "0.8.22",
    commitSha: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    manifest: "/inputs/manifest.json",
    result: "/results/result.json",
  }
  for (const [lane, runLane] of lanes) {
    await assert.rejects(runLane(options, { async runCommand() {} }), /strictRunner/iu, lane)
  }

  for (const relativePath of [
    "scripts/release/smoke/published-harness.mjs",
    "scripts/release/smoke/runtime-targets.mjs",
    "scripts/release/smoke/scaffold.mjs",
    "scripts/release/smoke/storage.mjs",
  ]) {
    const source = await readFile(path.resolve(relativePath), "utf8")
    assert.match(source, /createStrictSmokeProcessRunner\(\)/u, relativePath)
    const helperImport = source.match(
      /import \{([\s\S]*?)\} from "\.\.\/\.\.\/lib\/published-artifacts\.mjs"/u,
    )
    assert.ok(helperImport, `${relativePath} must use the shared public npm boundary`)
    assert.doesNotMatch(helperImport[1], /(?:^|,)\s*run\s*(?:,|$)/u, relativePath)
  }
})

test("every release smoke lane records capability refusal as its first check without a workload", async () => {
  const lanes = [
    ["published-harness", runPublishedHarnessSmoke],
    ["runtime-targets", runRuntimeTargetsSmoke],
    ["scaffold", runScaffoldSmoke],
    ["storage", runStorageSmoke],
  ]
  for (const [lane, runLane] of lanes) {
    let workloadCalls = 0
    let receipt
    await assert.rejects(
      runLane(
        {
          version: "0.8.22",
          commitSha: "a".repeat(40),
          manifestSha256: "b".repeat(64),
          manifest: "/inputs/manifest.json",
          result: `/results/${lane}.json`,
        },
        {
          env: {
            GITHUB_RUN_ID: "901",
            GITHUB_RUN_ATTEMPT: "1",
            ImageOS: "ubuntu24",
            ImageVersion: "unsupported",
          },
          now: fixedClock(),
          strictRunner: {
            async probe() {
              throw new Error("strict containment unsupported")
            },
            async runCommand() {
              workloadCalls += 1
              throw new Error("must not run")
            },
          },
          async writeFile(_filePath, bytes) {
            receipt = parseSmokeResult(bytes)
          },
          async mkdir() {},
        },
      ),
      /strict containment unsupported/iu,
      lane,
    )
    assert.equal(workloadCalls, 0, lane)
    assert.equal(receipt.lane, lane)
    assert.deepEqual(
      receipt.checks.map(({ name, conclusion }) => ({ name, conclusion })),
      [{ name: "containment", conclusion: "failure" }],
    )
  }
})

test("command shim cannot spawn the requested process until the controller opens its gate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dawn-shim-test-"))
  const descriptorPath = path.join(root, "command.json")
  const readyPath = path.join(root, "ready")
  const gatePath = path.join(root, "gate")
  const workloadPath = path.join(root, "workload.txt")
  const descriptor = {
    schemaVersion: 1,
    command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(workloadPath)}, "started\\n")`],
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    readyPath,
    gatePath,
  }
  await writeFile(descriptorPath, canonicalSmokeCommandDescriptor(descriptor), { mode: 0o600 })
  assert.deepEqual(parseSmokeCommandDescriptor(await readFile(descriptorPath)), descriptor)
  const child = spawn(process.execPath, [
    path.resolve("scripts/release/smoke-command-shim.mjs"),
    descriptorPath,
  ])
  try {
    await waitForFile(readyPath)
    await assert.rejects(readFile(workloadPath), (error) => error?.code === "ENOENT")
    await writeFile(gatePath, "go\n", { flag: "wx", mode: 0o600 })
    const exit = await new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise)
      child.once("close", (code, signal) => resolvePromise({ code, signal }))
    })
    assert.deepEqual(exit, { code: 0, signal: null })
    assert.equal(await readFile(workloadPath, "utf8"), "started\n")
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await rm(root, { recursive: true, force: true })
  }
})

test("timeout, abort, output, success, and nonzero paths preserve cleanup failures", async () => {
  for (const reason of ["timeout", "abort", "output", "success", "nonzero"]) {
    const primary = reason === "success" ? undefined : new Error(reason)
    const cleanup = new Error(`${reason}-cleanup`)
    const containment = {
      async probe() {
        return { adapter: "systemd-cgroup-v2", imageOS: "ubuntu24", imageVersion: "test" }
      },
      async runContained() {
        if (primary === undefined) {
          throw new AggregateError([cleanup], "strict containment cleanup failed")
        }
        throw new AggregateError([primary, cleanup], "workload and cleanup failed")
      },
    }
    const runner = createStrictSmokeProcessRunner({ containment })
    await runner.probe()
    await assert.rejects(runner.runCommand("node", ["probe.mjs"]), (error) => {
      assert.equal(error instanceof AggregateError, true)
      assert.equal(error.errors.includes(cleanup), true)
      if (primary !== undefined) assert.equal(error.errors.includes(primary), true)
      return true
    })
  }
})

test("systemd cleanup hard-kills and verifies detached descendants on every outcome", async () => {
  for (const scenario of ["success", "nonzero", "timeout", "abort", "output"]) {
    const harness = systemdHarness()
    const runner = createStrictSmokeProcessRunner({ containment: harness.containment })
    await runner.probe()
    harness.scenario = scenario
    const controller = new AbortController()
    const promise = runner.runCommand("node", ["probe.mjs"], {
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin" },
      maxOutputBytes: 1_024,
      timeoutMs: scenario === "timeout" ? 5 : 5_000,
      ...(scenario === "abort" ? { signal: controller.signal } : {}),
    })
    if (scenario === "abort") setTimeout(() => controller.abort(), 5)
    if (scenario === "success") {
      assert.deepEqual(await promise, { stdout: "ok", stderr: "" })
    } else {
      const expected = {
        nonzero: /exit code 2/iu,
        timeout: /timed out/iu,
        abort: /aborted/iu,
        output: /output limit/iu,
      }[scenario]
      await assert.rejects(promise, expected)
    }
    assert.equal(harness.descendantAlive, false, scenario)
    assert.equal(
      harness.calls.some(
        ({ args, input }) =>
          args?.includes("/usr/bin/tee") &&
          args?.at(-1)?.endsWith("/cgroup.kill") &&
          input === "1\n",
      ),
      true,
      scenario,
    )
    assert.equal(harness.workloadReaped, true, scenario)
  }
})

test("cleanup accepts exact cached cgroup ENOENT after systemd garbage collection", async () => {
  const harness = systemdHarness({ garbageCollectProbeUnit: true })
  const capability = await harness.containment.probe()
  assert.equal(capability.adapter, "systemd-cgroup-v2")
  assert.equal(harness.clientReapCalls, 1)
  assert.equal(
    harness.calls.some(({ args }) => args?.includes("stop") || args?.includes("reset-failed")),
    false,
  )
})

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(filePath)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

function systemdHarness({
  controlOutputOverflow = false,
  executableStatus = fileStatus({ mode: 0o100755, uid: 0 }),
  garbageCollectProbeUnit = false,
  mountInfo = "36 25 0:32 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n",
} = {}) {
  const files = new Map()
  const units = new Map()
  let nonce = 0
  const harness = {
    calls: [],
    clientReapCalls: 0,
    controlReapCalls: 0,
    descendantAlive: false,
    scenario: "success",
    workloadReaped: false,
  }
  const fileSystem = {
    async chmod() {},
    async lstat(filePath) {
      if (Object.values(PATHS).includes(filePath)) {
        return executableStatus
      }
      if (
        filePath === "/sys/fs/cgroup/cgroup.controllers" ||
        filePath.endsWith("/cgroup.events") ||
        filePath.endsWith("/cgroup.kill")
      ) {
        return fileStatus({ mode: 0o100644, uid: 0 })
      }
      if (files.has(filePath)) return fileStatus({ mode: 0o100600, uid: 1_000 })
      throw fileError("ENOENT")
    },
    async mkdtemp() {
      nonce += 1
      return `/tmp/dawn-smoke-control-${nonce}`
    },
    async readFile(filePath) {
      if (filePath === "/proc/self/mountinfo") {
        return mountInfo
      }
      if (filePath.endsWith("/cgroup.events")) {
        const unit = path.basename(path.dirname(filePath))
        const state = units.get(unit)
        if (state?.removed) throw fileError("ENOENT")
        return `populated ${state?.populated ?? 0}\nfrozen 0\n`
      }
      if (!files.has(filePath)) throw fileError("ENOENT")
      return files.get(filePath)
    },
    async rm(root) {
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${root}/`)) files.delete(key)
      }
    },
    async writeFile(filePath, value) {
      files.set(filePath, Buffer.isBuffer(value) ? Buffer.from(value) : String(value))
      if (filePath.endsWith("/gate")) {
        const descriptor = JSON.parse(
          String(files.get(path.join(path.dirname(filePath), "command.json"))),
        )
        const state = [...units.values()].find(
          (candidate) => candidate.descriptor.gatePath === descriptor.gatePath,
        )
        if (state === undefined) throw new Error("missing fake workload unit")
        if (descriptor.command === "/usr/bin/true") {
          state.activeState = "inactive"
          state.populated = 0
          state.removed = garbageCollectProbeUnit
          state.resolve({ stdout: "", stderr: "", exitCode: 0, signal: null })
          return
        }
        harness.descendantAlive = true
        state.populated = 1
        if (harness.scenario === "success" || harness.scenario === "nonzero") {
          state.activeState = "inactive"
          state.resolve({
            stdout: harness.scenario === "success" ? "ok" : "",
            stderr: harness.scenario === "nonzero" ? "failed" : "",
            exitCode: harness.scenario === "nonzero" ? 2 : 0,
            signal: null,
          })
        } else if (harness.scenario === "output") {
          const error = new Error("contained output limit")
          error.code = "EOUTPUTLIMIT"
          state.outputLimitResolve(error)
        }
      }
    },
  }

  harness.containment = createSystemdCgroupContainment({
    environment: { ImageOS: "ubuntu24", ImageVersion: "20260818.1" },
    fileSystem,
    gid: 1_000,
    nodePath: process.execPath,
    platform: "linux",
    randomUUID() {
      return `00000000-0000-0000-0000-${String(++nonce).padStart(12, "0")}`
    },
    shimPath: path.resolve("scripts/release/smoke-command-shim.mjs"),
    sleep: async () => {},
    uid: 1_000,
    spawnClient(input) {
      harness.calls.push(input)
      const systemdIndex = input.args.indexOf("/usr/bin/systemd-run")
      if (systemdIndex !== -1 && input.args[systemdIndex + 1] === "--version") {
        if (controlOutputOverflow) {
          const outputError = new Error("privileged control output limit")
          outputError.code = "EOUTPUTLIMIT"
          return {
            done: new Promise((resolvePromise) =>
              setTimeout(
                () => resolvePromise({ stdout: "", stderr: "", exitCode: 0, signal: null }),
                1,
              ),
            ),
            outputLimit: Promise.resolve(outputError),
            async terminateAndReap() {
              harness.controlReapCalls += 1
            },
          }
        }
        return completedClient({ stdout: "systemd 255 (255.4-1ubuntu8)\n" })
      }
      if (systemdIndex !== -1) {
        const systemdArgs = input.args.slice(systemdIndex + 1)
        const unit = systemdArgs[systemdArgs.indexOf("--unit") + 1]
        const descriptorPath = systemdArgs.at(-1)
        const descriptor = JSON.parse(String(files.get(descriptorPath)))
        let resolve
        const done = new Promise((resolvePromise) => {
          resolve = resolvePromise
        })
        let outputLimitResolve
        const outputLimit = new Promise((resolvePromise) => {
          outputLimitResolve = resolvePromise
        })
        const state = {
          activeState: "active",
          descriptor,
          done,
          outputLimitResolve,
          populated: 1,
          resolve,
        }
        units.set(unit, state)
        files.set(descriptor.readyPath, "ready\n")
        return {
          done,
          outputLimit,
          async terminateAndReap() {
            harness.clientReapCalls += 1
            if (state.activeState !== "inactive") {
              state.activeState = "inactive"
              state.populated = 0
              harness.descendantAlive = false
              state.resolve({ stdout: "", stderr: "terminated", exitCode: 143, signal: "SIGTERM" })
            }
            await done
            harness.workloadReaped = descriptor.command !== "/usr/bin/true"
          },
        }
      }
      const executable = input.args[5]
      const args = input.args.slice(6)
      if (executable === "/usr/bin/systemctl") {
        const unit = args.at(-1)
        const state = units.get(unit)
        if (state?.removed) {
          return completedClient({ stderr: `Unit ${unit} could not be found.\n`, exitCode: 1 })
        }
        if (args[0] === "show" && args.includes("--value")) {
          return completedClient({ stdout: `${state.activeState}\n` })
        }
        if (args[0] === "show") {
          return completedClient({ stdout: liveProperties(unit) })
        }
        if (args[0] === "kill") return completedClient()
        if (args[0] === "stop") {
          state.activeState = "inactive"
          return completedClient()
        }
        if (args[0] === "reset-failed") {
          state.removed = true
          return completedClient()
        }
      }
      if (executable === "/usr/bin/tee") {
        const unit = path.basename(path.dirname(args.at(-1)))
        const state = units.get(unit)
        state.populated = 0
        state.activeState = "inactive"
        harness.descendantAlive = false
        state.resolve({ stdout: "", stderr: "", exitCode: 143, signal: "SIGKILL" })
        return completedClient({ stdout: input.input ?? "" })
      }
      throw new Error(`unexpected fake client ${executable} ${args.join(" ")}`)
    },
  })
  return harness
}

function completedClient({ stdout = "", stderr = "", exitCode = 0 } = {}) {
  return {
    done: Promise.resolve({ stdout, stderr, exitCode, signal: null }),
    outputLimit: new Promise(() => {}),
    async terminateAndReap() {},
  }
}

function liveProperties(unit) {
  return `${[
    "ActiveState=active",
    "SubState=running",
    `ControlGroup=/system.slice/${unit}`,
    "Type=exec",
    "KillMode=control-group",
    "NoNewPrivileges=yes",
    "RestrictSUIDSGID=yes",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "Delegate=no",
    "ProtectControlGroups=yes",
    "UMask=0077",
  ].join("\n")}\n`
}

function fileStatus({ mode, uid }) {
  return { mode, nlink: 1, uid, isFile: () => true }
}

function fileError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fixedClock() {
  const values = [new Date("2026-08-25T12:00:00.000Z"), new Date("2026-08-25T12:00:01.000Z")]
  return () => values.shift() ?? new Date("2026-08-25T12:00:01.000Z")
}
