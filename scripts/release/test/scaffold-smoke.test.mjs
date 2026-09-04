import assert from "node:assert/strict"
import test from "node:test"
import { runScaffoldSmoke } from "../smoke/scaffold.mjs"
import { assertStrictSmokeCommandOptions } from "../smoke-process-runner.mjs"
import { parseSmokeResult } from "../smoke-result.mjs"

const options = Object.freeze({
  version: "0.8.22",
  commitSha: "a".repeat(40),
  manifestSha256: "b".repeat(64),
  result: "/results/scaffold.json",
})

test("scaffolds, installs, typechecks, builds, and runs at the exact public version", async () => {
  const events = []
  let receipt
  await runScaffoldSmoke(options, {
    env: releaseEnv("501", "2"),
    now: clock(),
    async makeTempDir() {
      events.push("temp")
      return "/tmp/clean-scaffold"
    },
    async mkdir() {},
    async removeDir(path) {
      events.push(`cleanup:${path}`)
    },
    strictRunner: fakeStrictRunner(async (command, args, runOptions) => {
      events.push({ command, args, cwd: runOptions.cwd })
      assert.equal(args.includes("workspace:*"), false)
      assert.equal(args.includes("file:../"), false)
      return { stdout: "", stderr: "" }
    }),
    async verifyExactScaffold(_root, version) {
      events.push(`verify:${version}`)
    },
    async writeFile(_path, bytes) {
      receipt = parseSmokeResult(bytes)
    },
  })

  const commands = events.filter((event) => typeof event === "object")
  assert.equal(
    commands.some(({ args }) => args.includes(`create-dawn-ai-app@${options.version}`)),
    true,
  )
  assert.equal(
    commands.some(({ args }) => args.includes("--dist-tag") && args.includes(options.version)),
    true,
  )
  assert.deepEqual(
    commands.filter(({ command }) => command === "npm").map(({ args }) => args.slice(0, 2)),
    [
      ["init", "-y"],
      ["install", "--ignore-scripts"],
      ["install", "--package-lock=false"],
      ["run", "typecheck"],
      ["run", "build"],
      ["test", "--"],
    ],
  )
  assert.equal(events.at(-1), "cleanup:/tmp/clean-scaffold")
  assert.equal(receipt.conclusion, "success")
  assert.equal(receipt.lane, "scaffold")
  assert.equal(receipt.checks[0].name, "containment")
})

test("writes a failure receipt and removes the clean scaffold after a command fails", async () => {
  const events = []
  let receipt
  await assert.rejects(
    runScaffoldSmoke(options, {
      env: releaseEnv("502", "1"),
      now: clock(),
      async makeTempDir() {
        return "/tmp/failed-scaffold"
      },
      async mkdir() {},
      async removeDir() {
        events.push("cleanup")
      },
      strictRunner: fakeStrictRunner(async (_command, args) => {
        if (args[0] === "run" && args[1] === "build") throw new Error("build failed")
        return { stdout: "", stderr: "" }
      }),
      async verifyExactScaffold() {},
      async writeFile(_path, bytes) {
        events.push("receipt")
        receipt = parseSmokeResult(bytes)
      },
    }),
    /build failed/,
  )

  assert.deepEqual(events, ["cleanup", "receipt"])
  assert.equal(receipt.conclusion, "failure")
  assert.equal(
    receipt.checks.some(({ name }) => name === "build"),
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
    async runCommand(command, args, options = {}) {
      assertStrictSmokeCommandOptions(options)
      return await runCommand(command, args, options)
    },
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
