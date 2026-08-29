import assert from "node:assert/strict"
import test from "node:test"
import { runRuntimeTargetsSmoke } from "../smoke/runtime-targets.mjs"
import { parseSmokeResult } from "../smoke-result.mjs"

const options = Object.freeze({
  version: "0.8.22",
  commitSha: "a".repeat(40),
  manifestSha256: "b".repeat(64),
  result: "/results/runtime-targets.json",
})

test("installs exact public packages and runs Node plus edge-target bundle/import probes", async () => {
  const commands = []
  let cleaned = false
  let receipt
  await runRuntimeTargetsSmoke(options, {
    env: releaseEnv("701", "1"),
    now: clock(),
    async makeTempDir() {
      return "/tmp/runtime-targets"
    },
    async removeDir() {
      cleaned = true
    },
    async writeProbeFiles() {},
    strictRunner: fakeStrictRunner(async (command, args, runOptions) => {
      commands.push({ command, args, cwd: runOptions.cwd })
      return { stdout: "", stderr: "" }
    }),
    async writeFile(_path, bytes) {
      receipt = parseSmokeResult(bytes)
    },
    async mkdir() {},
  })

  const install = commands.find(({ command, args }) => command === "npm" && args[0] === "install")
  assert.equal(install.args.includes("@dawn-ai/sdk@0.8.22"), true)
  assert.equal(install.args.includes("@dawn-ai/postgres-storage@0.8.22"), true)
  assert.equal(
    install.args.some((arg) => /workspace:|file:/u.test(arg)),
    false,
  )
  assert.equal(
    commands.some(({ command, args }) => command === "node" && args[0] === "node-runtime.mjs"),
    true,
  )
  assert.equal(
    commands.some(
      ({ command, args }) =>
        command === "npm" &&
        args.includes("esbuild") &&
        args.includes("--platform=browser") &&
        args.includes("--bundle"),
    ),
    true,
  )
  assert.equal(
    commands.some(({ command, args }) => command === "node" && args[0] === "edge-import.mjs"),
    true,
  )
  assert.equal(cleaned, true)
  assert.equal(receipt.conclusion, "success")
  assert.equal(receipt.lane, "runtime-targets")
  assert.equal(receipt.checks[0].name, "containment")
})

test("writes the failed edge receipt and cleans the consumer", async () => {
  const events = []
  let receipt
  await assert.rejects(
    runRuntimeTargetsSmoke(options, {
      env: releaseEnv("702", "2"),
      now: clock(),
      async makeTempDir() {
        return "/tmp/runtime-targets-failure"
      },
      async removeDir() {
        events.push("cleanup")
      },
      async writeProbeFiles() {},
      strictRunner: fakeStrictRunner(async (command, args) => {
        if (command === "npm" && args.includes("esbuild")) throw new Error("edge bundle failed")
        return { stdout: "", stderr: "" }
      }),
      async writeFile(_path, bytes) {
        events.push("receipt")
        receipt = parseSmokeResult(bytes)
      },
      async mkdir() {},
    }),
    /edge bundle failed/,
  )

  assert.deepEqual(events, ["cleanup", "receipt"])
  assert.equal(receipt.conclusion, "failure")
  assert.equal(
    receipt.checks.some(({ name }) => name === "edge-bundle"),
    true,
  )
})

function clock() {
  const values = [new Date("2026-08-25T12:00:00.000Z"), new Date("2026-08-25T12:00:01.000Z")]
  return () => values.shift() ?? new Date("2026-08-25T12:00:01.000Z")
}

function fakeStrictRunner(runCommand) {
  return {
    async probe() {
      return { adapter: "systemd-cgroup-v2", imageOS: "ubuntu24", imageVersion: "test" }
    },
    runCommand,
  }
}

function releaseEnv(runId, attempt) {
  return {
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: attempt,
    ImageOS: "ubuntu24",
    ImageVersion: "test",
  }
}
