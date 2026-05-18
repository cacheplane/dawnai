import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import { discoverRoutes } from "@dawn-ai/core"
import type { Command } from "commander"
import { extractDeploymentConfig } from "../lib/build/deployment-config.js"
import { type CommandIo, writeLine } from "../lib/output.js"
import { discoverToolDefinitions, injectGeneratedSchemas } from "../lib/runtime/tool-discovery.js"
import { runTypegen } from "../lib/typegen/run-typegen.js"

interface BuildOptions {
  readonly clean?: boolean
  readonly cwd?: string
}

export function registerBuildCommand(program: Command, io: CommandIo): void {
  program
    .command("build")
    .description("Generate deployment artifacts for LangSmith")
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

  const graphs: Record<string, string> = {}

  for (const route of manifest.routes) {
    const discoveredTools = await discoverToolDefinitions({
      appRoot: manifest.appRoot,
      routeDir: route.routeDir,
    })

    // Inject codegen-generated schemas (same as runtime path)
    const routeSlug =
      route.id.replace(/^\//, "").replace(/\//g, "-").replace(/\[/g, "").replace(/\]/g, "") ||
      "index"
    const schemaManifestPath = join(manifest.appRoot, ".dawn", "routes", routeSlug, "tools.json")
    let tools = discoveredTools
    if (existsSync(schemaManifestPath)) {
      try {
        const schemaManifest = JSON.parse(readFileSync(schemaManifestPath, "utf-8")) as Record<
          string,
          unknown
        >
        tools = injectGeneratedSchemas(discoveredTools, schemaManifest)
      } catch {
        // Best-effort — fall through on parse errors
      }
    }

    const entryFilePath = join(buildDir, `${routeSlug}.ts`)
    const relativeRoutePath = relative(dirname(entryFilePath), route.routeDir)
    const routeImportPath = `${relativeRoutePath}/index.js`

    let entryContent: string

    if (route.kind === "agent") {
      const toolImports = tools.map((tool, index) => {
        const relToolPath = relative(dirname(entryFilePath), dirname(tool.filePath))
        const toolFileName =
          tool.filePath.split("/").pop()?.replace(/\.ts$/, ".js") ?? `${tool.name}.js`
        return `import tool${index} from "${relToolPath}/${toolFileName}"`
      })

      const toolBindings = tools.map((tool, index) => {
        const schema =
          tool.schema === undefined ? "undefined" : JSON.stringify(tool.schema, null, 2)
        return `const tool${index}Definition = {\n  name: ${JSON.stringify(tool.name)},\n  description: ${JSON.stringify(tool.description ?? "")},\n  schema: ${schema},\n  run: typeof tool${index} === "function" ? tool${index} : tool${index}.run,\n}`
      })

      const toolNames = tools.map((_, index) => `tool${index}Definition`)

      entryContent = [
        `import agentDescriptor from "${routeImportPath}"`,
        ...toolImports,
        `import { materializeAgentGraph } from "@dawn-ai/langchain"`,
        ``,
        ...toolBindings,
        ``,
        `export const graph = await materializeAgentGraph({`,
        `  descriptor: agentDescriptor,`,
        `  tools: [${toolNames.join(", ")}],`,
        `})`,
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

  const deployment = extractDeploymentConfig(manifest.appRoot)

  const mergedConfig = {
    ...userConfig,
    graphs,
    dependencies: deployment.dependencies,
    env: deployment.env,
    node_version: deployment.node_version,
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
