import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { nodeRuntimeProbeSource, runRuntimeTargetsSmoke } from "../smoke/runtime-targets.mjs"
import { assertStrictSmokeCommandOptions } from "../smoke-process-runner.mjs"
import { parseSmokeResult } from "../smoke-result.mjs"

const options = Object.freeze({
  version: "0.8.22",
  commitSha: "a".repeat(40),
  manifestSha256: "b".repeat(64),
  result: "/results/runtime-targets.json",
})

const execFileAsync = promisify(execFile)

async function writeStubPackage(root, name, source, exportsMap) {
  const dir = join(root, "node_modules", ...name.split("/"))
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "0.0.0", type: "module", exports: exportsMap }),
    "utf8",
  )
  await writeFile(join(dir, "index.js"), source, "utf8")
}

async function runNodeRuntimeProbe(graphAdapterSource) {
  const root = await mkdtemp(join(tmpdir(), "dawn-runtime-probe-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8")
    await writeStubPackage(root, "@dawn-ai/sdk", "export const agent = () => {}", "./index.js")
    await writeStubPackage(root, "@dawn-ai/ag-ui", "export const toAguiEvents = () => {}", {
      ".": "./index.js",
    })
    await writeStubPackage(root, "@dawn-ai/core", "export const discoverRoutes = () => {}", {
      "./node": "./index.js",
    })
    await writeStubPackage(root, "@dawn-ai/langgraph", graphAdapterSource, "./index.js")
    await writeFile(join(root, "node-runtime.mjs"), nodeRuntimeProbeSource(), "utf8")
    await execFileAsync(process.execPath, ["node-runtime.mjs"], { cwd: root })
    return { ok: true, stderr: "" }
  } catch (error) {
    return { ok: false, stderr: String(error.stderr ?? error.message) }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("node runtime probe accepts the shipped backend-adapter shape of graphAdapter", async () => {
  const shipped = await runNodeRuntimeProbe(
    'export const graphAdapter = { kind: "graph", execute: async () => {}, stream: async function* () {} }',
  )
  assert.equal(shipped.ok, true, shipped.stderr)
})

test("node runtime probe rejects a graphAdapter that loses its backend-adapter contract", async () => {
  const asFunction = await runNodeRuntimeProbe("export const graphAdapter = () => {}")
  assert.equal(asFunction.ok, false)
  assert.match(asFunction.stderr, /graphAdapter must be a backend adapter object/u)

  const wrongKind = await runNodeRuntimeProbe(
    'export const graphAdapter = { kind: "workflow", execute: async () => {}, stream: async function* () {} }',
  )
  assert.equal(wrongKind.ok, false)
  assert.match(wrongKind.stderr, /graphAdapter must declare the graph backend kind/u)

  const missingStream = await runNodeRuntimeProbe(
    'export const graphAdapter = { kind: "graph", execute: async () => {} }',
  )
  assert.equal(missingStream.ok, false)
  assert.match(missingStream.stderr, /graphAdapter\.stream must be a function/u)
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
