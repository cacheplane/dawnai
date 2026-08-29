#!/usr/bin/env node

import { mkdir, readFile } from "node:fs/promises"
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

export async function runScaffoldSmoke(options, overrides = {}) {
  if (overrides.runCommand !== undefined || overrides.probeContainment !== undefined) {
    throw new TypeError("Scaffold smoke command execution requires a strictRunner")
  }
  const strictRunner = overrides.strictRunner ?? createStrictSmokeProcessRunner()
  const dependencies = {
    makeTempDir,
    mkdir: (directory) => mkdir(directory, { recursive: true }),
    removeDir,
    verifyExactScaffold,
    ...overrides,
    runCommand: (command, args, runOptions) =>
      strictRunner.runCommand(command, args, productionCommandOptions(runOptions)),
    probeContainment: strictRunner.probe,
  }

  return executeSmokeLane(
    { lane: "scaffold", ...options },
    async ({ check, deferCleanup }) => {
      await check(
        "containment",
        strictContainmentReceiptDetail(dependencies.env),
        dependencies.probeContainment,
      )
      const root = await check("temporary-project", "clean temporary project created", () =>
        dependencies.makeTempDir("dawn-published-scaffold-"),
      )
      deferCleanup("cleanup", "clean scaffold project removed", () => dependencies.removeDir(root))
      const installer = path.join(root, "installer")
      const scaffold = path.join(root, "app")
      await dependencies.mkdir(installer)

      await check("scaffolder-install", "exact public scaffolder installed", async () => {
        await dependencies.runCommand("npm", ["init", "-y"], {
          cwd: installer,
        })
        await dependencies.runCommand(
          "npm",
          [
            "install",
            "--ignore-scripts",
            "--save-exact",
            "--package-lock=false",
            `create-dawn-ai-app@${options.version}`,
          ],
          { cwd: installer },
        )
      })

      await check("scaffold-create", "basic scaffold created with exact Dawn specifiers", () =>
        dependencies.runCommand(
          path.join(installer, "node_modules", ".bin", "create-dawn-ai-app"),
          [scaffold, "--template", "basic", "--dist-tag", options.version],
          { cwd: installer },
        ),
      )
      await check("dependency-install", "scaffold dependencies installed from public npm", () =>
        dependencies.runCommand("npm", ["install", "--package-lock=false"], {
          cwd: scaffold,
        }),
      )
      await check(
        "exact-versions",
        "all scaffold Dawn dependencies resolved to the exact version",
        () => dependencies.verifyExactScaffold(scaffold, options.version),
      )
      await check("typecheck", "scaffold typecheck passed", () =>
        dependencies.runCommand("npm", ["run", "typecheck"], { cwd: scaffold }),
      )
      await check("build", "scaffold build passed", () =>
        dependencies.runCommand("npm", ["run", "build"], { cwd: scaffold }),
      )
      await check("runtime", "representative scaffold runtime test passed", () =>
        dependencies.runCommand("npm", ["test", "--", "--run"], {
          cwd: scaffold,
        }),
      )
    },
    overrides,
  )
}

export async function verifyExactScaffold(root, version) {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  }
  const dawnPackages = Object.entries(declared).filter(
    ([name]) => name.startsWith("@dawn-ai/") || name === "create-dawn-ai-app",
  )
  if (dawnPackages.length === 0) throw new Error("Scaffold declares no Dawn packages")
  for (const [name, specifier] of dawnPackages) {
    if (specifier !== version) {
      throw new Error(`${name} uses ${specifier}, expected exact ${version}`)
    }
    const installed = JSON.parse(
      await readFile(path.join(root, "node_modules", ...name.split("/"), "package.json"), "utf8"),
    )
    if (installed.name !== name || installed.version !== version) {
      throw new Error(
        `${name} installed as ${installed.name}@${installed.version}, expected ${version}`,
      )
    }
  }
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
  await runScaffoldSmoke(parseSmokeLaneArgs(process.argv.slice(2)))
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error(`SCAFFOLD SMOKE FAIL ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
