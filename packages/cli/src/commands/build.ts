import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import { discoverRoutes } from "@dawn-ai/core"
import type { Command } from "commander"
import { type CommandIo, writeLine } from "../lib/output.js"
import { discoverToolDefinitions } from "../lib/runtime/tool-discovery.js"

interface BuildOptions {
  readonly clean?: boolean
  readonly cwd?: string
}

export function registerBuildCommand(program: Command, io: CommandIo): void {
  program
    .command("build")
    .description("Generate deployment artifacts for LangGraph Platform")
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

  const buildDir = resolve(manifest.appRoot, ".dawn", "build")

  if (options.clean) {
    await rm(buildDir, { recursive: true, force: true })
  }

  await mkdir(buildDir, { recursive: true })

  const graphs: Record<string, string> = {}

  for (const route of manifest.routes) {
    const tools = await discoverToolDefinitions({
      appRoot: manifest.appRoot,
      routeDir: route.routeDir,
    })

    const entryFileName = route.id
      .replace(/^\//, "")
      .replace(/\//g, "-")
      .replace(/\[/g, "")
      .replace(/\]/g, "")

    const entryFilePath = join(buildDir, `${entryFileName}.ts`)
    const relativeRoutePath = relative(dirname(entryFilePath), route.routeDir)
    const routeImportPath = `${relativeRoutePath}/index.js`

    let entryContent: string

    if (route.kind === "agent" && tools.length > 0) {
      const toolImports = tools.map((tool) => {
        const relToolPath = relative(dirname(entryFilePath), dirname(tool.filePath))
        const toolFileName =
          tool.filePath.split("/").pop()?.replace(/\.ts$/, ".js") ?? `${tool.name}.js`
        return `import ${tool.name} from "${relToolPath}/${toolFileName}"`
      })

      const toolBindings = tools.map(
        (tool) =>
          `const ${tool.name}Tool = tool(${tool.name}, {\n  name: "${tool.name}",\n  description: "${tool.description ?? ""}",\n  schema: z.record(z.string(), z.unknown()),\n})`,
      )

      const toolNames = tools.map((tool) => `${tool.name}Tool`)

      entryContent = [
        `import { agent } from "${routeImportPath}"`,
        ...toolImports,
        `import { tool } from "@langchain/core/tools"`,
        `import { z } from "zod"`,
        ``,
        ...toolBindings,
        ``,
        `export const graph = agent.bindTools([${toolNames.join(", ")}])`,
        ``,
      ].join("\n")
    } else {
      const exportName = route.kind
      entryContent = [
        `import { ${exportName} } from "${routeImportPath}"`,
        ``,
        `export const graph = ${exportName}`,
        ``,
      ].join("\n")
    }

    await writeFile(entryFilePath, entryContent, "utf8")

    const assistantId = `${route.id}#${route.kind}`
    const relativeEntryPath = `./${relative(manifest.appRoot, entryFilePath)}`
    graphs[assistantId] = `${relativeEntryPath}:graph`
  }

  const userLanggraphPath = resolve(manifest.appRoot, "langgraph.json")
  let userConfig: Record<string, unknown> = {}

  try {
    const raw = await readFile(userLanggraphPath, "utf8")
    userConfig = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // No user langgraph.json — start with empty config
  }

  const mergedConfig = {
    ...userConfig,
    graphs,
  }

  const outputLanggraphPath = join(buildDir, "langgraph.json")
  await writeFile(outputLanggraphPath, `${JSON.stringify(mergedConfig, null, 2)}\n`, "utf8")

  writeLine(io.stdout, `Build complete: ${relative(process.cwd(), buildDir)}`)
  writeLine(io.stdout, `  ${Object.keys(graphs).length} route(s) compiled`)
  writeLine(
    io.stdout,
    `  langgraph.json written to ${relative(process.cwd(), outputLanggraphPath)}`,
  )
}
