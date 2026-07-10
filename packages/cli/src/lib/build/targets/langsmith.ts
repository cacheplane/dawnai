import { existsSync, readFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { discoverToolDefinitions, injectGeneratedSchemas } from "../../runtime/tool-discovery.js"
import { extractDeploymentConfig } from "../deployment-config.js"
import type { BuildEmitContext, BuildTarget } from "./index.js"

/**
 * The LangSmith deploy target. Emits the per-route materialized graph entry
 * files plus a merged `langgraph.json`. This is the original `dawn build`
 * behavior, moved verbatim behind the target seam.
 */
export const langsmithTarget: BuildTarget = {
  name: "langsmith",
  async emit({ appRoot, buildDir, manifest }: BuildEmitContext) {
    const artifacts: string[] = []
    const graphs: Record<string, string> = {}

    for (const route of manifest.routes) {
      const discoveredTools = await discoverToolDefinitions({
        appRoot,
        routeDir: route.routeDir,
      })

      // Inject codegen-generated schemas (same as runtime path)
      const routeSlug =
        route.id.replace(/^\//, "").replace(/\//g, "-").replace(/\[/g, "").replace(/\]/g, "") ||
        "index"
      const schemaManifestPath = join(appRoot, ".dawn", "routes", routeSlug, "tools.json")
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
      artifacts.push(entryFilePath)

      const assistantId = `${route.id}#${route.kind}`
      const relativeEntryPath = `./${relative(appRoot, entryFilePath)}`
      graphs[assistantId] = `${relativeEntryPath}:graph`
    }

    const userLanggraphPath = resolve(appRoot, "langgraph.json")
    let userConfig: Record<string, unknown> = {}

    try {
      const raw = await readFile(userLanggraphPath, "utf8")
      userConfig = JSON.parse(raw) as Record<string, unknown>
    } catch {
      // No user langgraph.json — start with empty config
    }

    const deployment = extractDeploymentConfig(appRoot)

    const mergedConfig = {
      ...userConfig,
      graphs,
      dependencies: deployment.dependencies,
      env: deployment.env,
      node_version: deployment.node_version,
    }

    const outputLanggraphPath = join(buildDir, "langgraph.json")
    await writeFile(outputLanggraphPath, `${JSON.stringify(mergedConfig, null, 2)}\n`, "utf8")
    artifacts.push(outputLanggraphPath)

    return { artifacts }
  },
}
