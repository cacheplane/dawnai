import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
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
      const routeSlug =
        route.id.replace(/^\//, "").replace(/\//g, "-").replace(/\[/g, "").replace(/\]/g, "") ||
        "index"
      const entryFilePath = join(buildDir, `${routeSlug}.ts`)
      const relativeRoutePath = relative(dirname(entryFilePath), route.routeDir)
      const routeImportPath = `${relativeRoutePath}/index.js`

      let entryContent: string

      if (route.kind === "agent") {
        const relativeRouteFile = relative(dirname(entryFilePath), route.entryFile)
          .replaceAll("\\", "/")
          .replace(/\.ts$/, ".js")
        entryContent = [
          `import { fileURLToPath } from "node:url"`,
          `import { materializeResolvedRouteGraph } from "@dawn-ai/cli/runtime"`,
          ``,
          `const appRoot = fileURLToPath(new URL("../..", import.meta.url))`,
          ``,
          `export const graph = await materializeResolvedRouteGraph({`,
          `  appRoot,`,
          `  routeFile: fileURLToPath(new URL(${JSON.stringify(relativeRouteFile)}, import.meta.url)),`,
          `  routeId: ${JSON.stringify(route.id)},`,
          `  routePath: ${JSON.stringify(route.pathname)},`,
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
