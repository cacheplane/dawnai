import { mkdir, rm } from "node:fs/promises"
import { relative, resolve } from "node:path"

import { discoverRoutes, loadDawnConfig } from "@dawn-ai/core"
import type { Command } from "commander"
import {
  type BuildEmitContext,
  buildTargets,
  DEFAULT_BUILD_TARGETS,
  knownTargetNames,
} from "../lib/build/targets/index.js"
import { CliError, type CommandIo, writeLine } from "../lib/output.js"
import { runTypegen } from "../lib/typegen/run-typegen.js"

interface BuildOptions {
  readonly clean?: boolean
  readonly cwd?: string
}

export function registerBuildCommand(program: Command, io: CommandIo): void {
  program
    .command("build")
    .description("Generate deployment artifacts (node + langsmith targets)")
    .option("--clean", "Remove .dawn/build/ before generating")
    .option("--cwd <path>", "Path to the Dawn app root")
    .action(async (options: BuildOptions) => {
      await runBuildCommand(options, io)
    })
}

export async function runBuildCommand(options: BuildOptions, io: CommandIo): Promise<void> {
  const manifest = await discoverRoutes({
    ...(options.cwd ? { appRoot: options.cwd } : {}),
  })

  // Run typegen as pre-step to produce .dawn/routes/<id>/tools.json and .dawn/dawn.generated.d.ts
  await runTypegen({ appRoot: manifest.appRoot, manifest })

  const buildDir = resolve(manifest.appRoot, ".dawn", "build")

  if (options.clean) {
    await rm(buildDir, { recursive: true, force: true })
  }

  await mkdir(buildDir, { recursive: true })

  let targetNames: readonly string[] = DEFAULT_BUILD_TARGETS
  try {
    const loaded = await loadDawnConfig({ appRoot: manifest.appRoot })
    if (loaded.config.build?.targets) {
      targetNames = loaded.config.build.targets
    }
  } catch {
    // No / invalid config — fall back to default targets.
  }

  // Validate the ENTIRE target list up front, before emitting anything — an
  // unknown target must fail fast, not after earlier targets already wrote
  // files to disk.
  for (const name of targetNames) {
    if (!buildTargets[name]) {
      throw new CliError(
        `Unknown build target "${name}". Known targets: ${knownTargetNames().join(", ")}.`,
      )
    }
  }

  if (targetNames.length === 0) {
    writeLine(io.stderr, "no build targets configured; nothing emitted")
    return
  }

  const ctx: BuildEmitContext = {
    appRoot: manifest.appRoot,
    buildDir,
    io,
    manifest,
  }

  const emitted: string[] = []
  for (const name of targetNames) {
    // Presence guaranteed by the up-front validation above.
    const target = buildTargets[name] as (typeof buildTargets)[string]
    const { artifacts } = await target.emit(ctx)
    emitted.push(...artifacts)
  }

  writeLine(io.stdout, `Build complete: ${relative(process.cwd(), buildDir)}`)
  writeLine(io.stdout, `  ${manifest.routes.length} route(s) compiled`)
  writeLine(io.stdout, `  targets: ${targetNames.join(", ")}`)
  for (const artifact of emitted) {
    writeLine(io.stdout, `  wrote ${relative(process.cwd(), artifact)}`)
  }
}
