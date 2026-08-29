#!/usr/bin/env node

import { writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { makeTempDir, publicNpmEnvironment, removeDir } from "../../lib/published-artifacts.mjs"
import {
  createStrictSmokeProcessRunner,
  strictContainmentReceiptDetail,
} from "../smoke-process-runner.mjs"
import { executeSmokeLane, parseSmokeLaneArgs } from "../smoke-result.mjs"

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024
const ESBUILD_VERSION = "0.28.1"

export async function runRuntimeTargetsSmoke(options, overrides = {}) {
  if (overrides.runCommand !== undefined || overrides.probeContainment !== undefined) {
    throw new TypeError("Runtime-target smoke command execution requires a strictRunner")
  }
  const strictRunner = overrides.strictRunner ?? createStrictSmokeProcessRunner()
  const dependencies = {
    makeTempDir,
    removeDir,
    writeProbeFiles,
    ...overrides,
    runCommand: (command, args, runOptions) =>
      strictRunner.runCommand(command, args, productionCommandOptions(runOptions)),
    probeContainment: strictRunner.probe,
  }

  return executeSmokeLane(
    { lane: "runtime-targets", ...options },
    async ({ check, deferCleanup }) => {
      await check(
        "containment",
        strictContainmentReceiptDetail(dependencies.env),
        dependencies.probeContainment,
      )
      const root = await check("temporary-project", "clean runtime-target consumer created", () =>
        dependencies.makeTempDir("dawn-published-runtime-targets-"),
      )
      deferCleanup("cleanup", "runtime-target consumer removed", () => dependencies.removeDir(root))

      await check(
        "exact-install",
        "exact Node and edge packages installed from public npm",
        async () => {
          await dependencies.runCommand("npm", ["init", "-y"], { cwd: root })
          await dependencies.runCommand(
            "npm",
            [
              "install",
              "--save-exact",
              "--package-lock=false",
              `@dawn-ai/sdk@${options.version}`,
              `@dawn-ai/core@${options.version}`,
              `@dawn-ai/langgraph@${options.version}`,
              `@dawn-ai/ag-ui@${options.version}`,
              `@dawn-ai/postgres-storage@${options.version}`,
              `esbuild@${ESBUILD_VERSION}`,
            ],
            { cwd: root },
          )
        },
      )
      await check("probe-files", "runtime-target probes created", () =>
        dependencies.writeProbeFiles(root),
      )
      await check("node-runtime", "Node imports and representative runtime passed", () =>
        dependencies.runCommand("node", ["node-runtime.mjs"], { cwd: root }),
      )
      await check("edge-bundle", "edge target bundled without Node builtins", () =>
        dependencies.runCommand(
          "npm",
          [
            "exec",
            "--",
            "esbuild",
            "edge-entry.mjs",
            "--bundle",
            "--platform=browser",
            "--format=esm",
            "--outfile=edge-bundle.mjs",
          ],
          { cwd: root },
        ),
      )
      await check("edge-import", "bundled edge target imported and executed", () =>
        dependencies.runCommand("node", ["edge-import.mjs"], { cwd: root }),
      )
    },
    overrides,
  )
}

export async function writeProbeFiles(root) {
  await Promise.all([
    writeFile(path.join(root, "node-runtime.mjs"), nodeRuntimeProbeSource(), "utf8"),
    writeFile(path.join(root, "edge-entry.mjs"), edgeEntryProbeSource(), "utf8"),
    writeFile(path.join(root, "edge-import.mjs"), edgeImportProbeSource(), "utf8"),
  ])
}

export function nodeRuntimeProbeSource() {
  return `import assert from "node:assert/strict"
import { agent } from "@dawn-ai/sdk"
import { discoverRoutes } from "@dawn-ai/core/node"
import { graphAdapter } from "@dawn-ai/langgraph"
import { toAguiEvents } from "@dawn-ai/ag-ui"

for (const [name, value] of Object.entries({ agent, discoverRoutes, graphAdapter, toAguiEvents })) {
  assert.equal(typeof value, "function", name + " must be a function")
}
`
}

export function edgeEntryProbeSource() {
  return `import { agent } from "@dawn-ai/sdk/pure"
import { createPostgresThreadsStore } from "@dawn-ai/postgres-storage"

export function edgeSurface() {
  return [typeof agent, typeof createPostgresThreadsStore]
}
`
}

export function edgeImportProbeSource() {
  return `import assert from "node:assert/strict"
import { edgeSurface } from "./edge-bundle.mjs"
assert.deepEqual(edgeSurface(), ["function", "function"])
`
}

function productionCommandOptions(options = {}) {
  return {
    ...options,
    env: publicNpmEnvironment({ home: options.cwd ?? process.cwd(), extra: options.env }),
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: COMMAND_OUTPUT_BYTES,
  }
}

async function main() {
  await runRuntimeTargetsSmoke(parseSmokeLaneArgs(process.argv.slice(2)))
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error(
      `RUNTIME TARGETS SMOKE FAIL ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
