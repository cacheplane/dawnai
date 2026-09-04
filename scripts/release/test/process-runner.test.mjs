import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"

import {
  createReleasePreparationRunner,
  PREPARATION_OVERALL_TIMEOUT_MS,
} from "../process-runner.mjs"

const DESCENDANT_POLL_MS = 20
// Process-tree teardown on a saturated CI runner legitimately outlasts the old 2s budget.
const DESCENDANT_EXIT_TIMEOUT_MS = 10_000
const DESCENDANT_READY_TIMEOUT_MS = 15_000

test("the production runner deadline stays inside the 30-minute workflow ceiling", () => {
  assert.equal(PREPARATION_OVERALL_TIMEOUT_MS, 25 * 60_000)
})

test("the production preparation runner does not inherit unrelated job secrets", async (t) => {
  const secretName = "RELEASE_RUNNER_SECRET"
  const previous = Reflect.get(process.env, secretName)
  Reflect.set(process.env, secretName, "must-not-leak")
  t.after(() => {
    if (previous === undefined) Reflect.deleteProperty(process.env, secretName)
    else Reflect.set(process.env, secretName, previous)
  })
  const run = createReleasePreparationRunner({
    commandTimeoutMs: 1_000,
    overallTimeoutMs: 2_000,
  })

  const result = await run(
    process.execPath,
    ["-e", "process.stdout.write(process.env.RELEASE_RUNNER_SECRET ?? '')"],
    { cwd: process.cwd() },
  )

  assert.equal(result.stdout, "")
})

test("the production preparation runner enforces a per-command deadline", async () => {
  const run = createReleasePreparationRunner({
    commandTimeoutMs: 30,
    overallTimeoutMs: 1_000,
  })

  await assert.rejects(
    run(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { cwd: process.cwd() }),
    /preparation command.*timed out/iu,
  )
})

test("the production preparation runner enforces one overall deadline", async () => {
  let currentTimeMs = 0
  const run = createReleasePreparationRunner({
    commandTimeoutMs: 1_000,
    overallTimeoutMs: 2_000,
    now: () => currentTimeMs,
  })
  await run(process.execPath, ["-e", ""], { cwd: process.cwd() })
  currentTimeMs = 2_001

  await assert.rejects(
    run(process.execPath, ["-e", "setTimeout(() => {}, 1_000)"], { cwd: process.cwd() }),
    /overall.*deadline|timed out/iu,
  )
})

test("the production preparation runner bounds combined stdout and stderr", async () => {
  const run = createReleasePreparationRunner({
    commandTimeoutMs: 1_000,
    overallTimeoutMs: 2_000,
    maxOutputBytes: 32,
  })

  await assert.rejects(
    run(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(24)); process.stderr.write('y'.repeat(24))"],
      { cwd: process.cwd() },
    ),
    /preparation command.*output limit/iu,
  )
})

test("the production preparation runner accepts only explicitly allowed nonzero exits", async () => {
  const run = createReleasePreparationRunner({
    commandTimeoutMs: 1_000,
    overallTimeoutMs: 2_000,
  })

  const accepted = await run(
    process.execPath,
    ["-e", "process.stdout.write('structured audit'); process.exitCode = 1"],
    { cwd: process.cwd(), acceptedExitCodes: [0, 1] },
  )
  assert.equal(accepted.exitCode, 1)
  assert.equal(accepted.stdout, "structured audit")

  await assert.rejects(
    run(process.execPath, ["-e", "process.exitCode = 2"], {
      cwd: process.cwd(),
      acceptedExitCodes: [0, 1],
    }),
    /exited unsuccessfully/iu,
  )
  assert.throws(
    () =>
      run(process.execPath, ["-e", ""], {
        cwd: process.cwd(),
        acceptedExitCodes: [0, 0],
      }),
    /accepted exit codes/iu,
  )
})

test("the production preparation runner terminates descendants on timeout", {
  skip: process.platform === "win32",
  timeout: 30_000,
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "dawn-runner-tree-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const pidPath = path.join(temporary, "descendant.pid")
  // The helper renames a fully written temporary file into place so the runner can never
  // observe a half-written pid, however the termination signal interleaves with the write.
  const source = [
    "const { spawn } = require('node:child_process')",
    "const { renameSync, writeFileSync } = require('node:fs')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    `writeFileSync(${JSON.stringify(`${pidPath}.tmp`)}, String(child.pid))`,
    `renameSync(${JSON.stringify(`${pidPath}.tmp`)}, ${JSON.stringify(pidPath)})`,
    "setInterval(() => {}, 1000)",
  ].join(";")
  let descendantPid
  const run = createReleasePreparationRunner({
    commandTimeoutMs: 100,
    overallTimeoutMs: 2_000,
    spawnImpl(command, args, options) {
      const child = spawn(command, args, options)
      // The runner arms its deadline as soon as this returns, so the descendant has to
      // exist first. Otherwise the 100ms budget races helper startup instead of proving
      // that termination reaches the whole process tree, and a loaded machine kills the
      // helper before it ever records its child.
      try {
        descendantPid = awaitDescendantPid(pidPath)
      } catch (error) {
        // The runner only ever cleans up a child it was handed, so a wrapper that throws
        // owns the tree it already started; leaking it would hang the test run.
        killProcessGroup(child)
        throw error
      }
      return child
    },
  })

  await assert.rejects(run(process.execPath, ["-e", source], { cwd: temporary }), /timed out/iu)
  await waitForProcessExit(descendantPid)
})

test("the production preparation runner uses taskkill for a Windows process tree", async () => {
  const child = new EventEmitter()
  child.pid = 4242
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  const taskkills = []
  const run = createReleasePreparationRunner({
    commandTimeoutMs: 10,
    overallTimeoutMs: 1_000,
    platform: "win32",
    spawnImpl: () => child,
    async runTaskkill(pid, timeoutMs) {
      taskkills.push({ pid, timeoutMs })
      child.emit("close", null, "SIGKILL")
    },
  })

  await assert.rejects(run("command.exe", [], { cwd: "C:\\fixture" }), /timed out/iu)
  assert.deepEqual(taskkills, [{ pid: 4242, timeoutMs: 2_000 }])
})

test("descendant pid readiness rejects every incomplete file", () => {
  for (const incomplete of [
    "",
    " ",
    "\n",
    "0",
    "-1",
    "01",
    "1\n",
    "not-a-pid",
    "9007199254740992",
  ]) {
    assert.equal(
      readDescendantPid("unused", () => incomplete),
      null,
      `expected ${JSON.stringify(incomplete)} to read as an incomplete pid`,
    )
  }
  assert.equal(
    readDescendantPid("unused", () => "12345"),
    12345,
  )

  const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
  assert.equal(
    readDescendantPid("unused", () => {
      throw missing
    }),
    null,
  )
  const denied = Object.assign(new Error("denied"), { code: "EACCES" })
  assert.throws(
    () =>
      readDescendantPid("unused", () => {
        throw denied
      }),
    (error) => error === denied,
  )
})

test("waiting on a descendant rejects a pid that was never recorded", async () => {
  // Signal 0 addressed to pid 0 targets the caller's own process group, which always
  // exists, so an unvalidated pid would poll until its deadline and then report the
  // descendant as a survivor. Every invalid pid has to fail as what it is instead.
  for (const invalid of [0, -1, Number.NaN, 1.5]) {
    await assert.rejects(waitForProcessExit(invalid), (error) => {
      assert.match(error.message, /is not a recorded descendant pid/u)
      assert.doesNotMatch(error.message, /survived/u)
      return true
    })
  }
})

async function waitForProcessExit(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error(`${pid} is not a recorded descendant pid`)
  }
  const deadline = Date.now() + DESCENDANT_EXIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error?.code === "ESRCH") return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, DESCENDANT_POLL_MS))
  }
  assert.fail(`descendant process ${pid} survived the runner timeout`)
}

// Blocks the caller until the helper has recorded a complete pid. This runs inside
// spawnImpl, before the runner starts its own clock, so waiting here costs the command
// deadline nothing and no amount of load can turn a slow helper into a phantom survivor.
function awaitDescendantPid(target, timeoutMs = DESCENDANT_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  const idle = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    const pid = readDescendantPid(target)
    if (pid !== null) return pid
    if (Date.now() >= deadline) {
      throw new Error(`Descendant pid was not recorded in ${target} within ${timeoutMs}ms`)
    }
    Atomics.wait(idle, 0, 0, DESCENDANT_POLL_MS)
  }
}

function killProcessGroup(child) {
  if (!Number.isSafeInteger(child?.pid) || child.pid < 1) return
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch (error) {
    if (error?.code !== "ESRCH") throw error
  }
}

function readDescendantPid(target, read = readFileSync) {
  try {
    const source = read(target, "utf8")
    if (!/^[1-9]\d*$/u.test(source)) return null
    const pid = Number(source)
    return Number.isSafeInteger(pid) ? pid : null
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}
