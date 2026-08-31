import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"

import {
  createReleasePreparationRunner,
  PREPARATION_OVERALL_TIMEOUT_MS,
} from "../process-runner.mjs"

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
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "dawn-runner-tree-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const pidPath = path.join(temporary, "descendant.pid")
  const source = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))`,
    "setInterval(() => {}, 1000)",
  ].join(";")
  const run = createReleasePreparationRunner({
    commandTimeoutMs: 100,
    overallTimeoutMs: 2_000,
  })

  await assert.rejects(run(process.execPath, ["-e", source], { cwd: temporary }), /timed out/iu)
  const descendantPid = Number(await readFile(pidPath, "utf8"))
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

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error?.code === "ESRCH") return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`descendant process ${pid} survived the runner timeout`)
}
