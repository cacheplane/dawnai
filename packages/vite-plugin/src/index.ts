import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { RouteToolTypes } from "@dawn-ai/core"
import {
  discoverRoutes,
  extractToolTypesForRoute,
  findDawnApp,
  renderDawnTypes,
} from "@dawn-ai/core"

import { extractJsDoc } from "./jsdoc-extractor.js"
import { extractParameterType } from "./type-extractor.js"
import { generateZodSchema } from "./zod-generator.js"

// Keep all existing re-exports
export { extractJsDoc, type JsDocInfo } from "./jsdoc-extractor.js"
export { extractParameterType } from "./type-extractor.js"
export { generateZodSchema } from "./zod-generator.js"

const TOOLS_DIR_PATTERN = /\/tools\/[^/]+\.ts$/
const OUTPUT_FILE = "dawn.generated.d.ts"

export interface DawnPluginOptions {
  readonly appRoot?: string
}

export function dawnToolSchemaPlugin(options?: DawnPluginOptions): {
  name: string
  configureServer?(server: {
    readonly watcher: {
      on(event: string, callback: (path: string) => void): void
    }
  }): void | Promise<void>
  buildStart?(): void | Promise<void>
  transform(code: string, id: string): { code: string } | null
} {
  return {
    name: "dawn-tool-schema",

    async configureServer(server) {
      // Run typegen once on startup
      await runTypegen(options?.appRoot)

      // Debounce helper
      let debounceTimer: ReturnType<typeof setTimeout> | undefined

      const scheduleTypegen = () => {
        clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          void runTypegen(options?.appRoot)
        }, 300)
      }

      // Watch tool files for changes
      server.watcher.on("change", (path) => {
        if (TOOLS_DIR_PATTERN.test(path)) {
          scheduleTypegen()
        }
      })
      server.watcher.on("add", (path) => {
        if (TOOLS_DIR_PATTERN.test(path)) {
          scheduleTypegen()
        }
      })
      server.watcher.on("unlink", (path) => {
        if (TOOLS_DIR_PATTERN.test(path)) {
          scheduleTypegen()
        }
      })
    },

    async buildStart() {
      await runTypegen(options?.appRoot)
    },

    transform(code: string, id: string): { code: string } | null {
      if (!TOOLS_DIR_PATTERN.test(id)) {
        return null
      }

      const transformed = transformToolSource(code, id)

      if (!transformed) {
        return null
      }

      return { code: transformed }
    },
  }
}

async function runTypegen(appRoot?: string): Promise<void> {
  try {
    const app = await findDawnApp(appRoot ? { appRoot } : {})
    const manifest = await discoverRoutes(appRoot ? { appRoot } : {})

    const sharedToolsDir = join(app.appRoot, "src")
    const toolTypesPerRoute: RouteToolTypes[] = []
    for (const route of manifest.routes) {
      const tools = await extractToolTypesForRoute({
        routeDir: route.routeDir,
        sharedToolsDir,
      })
      toolTypesPerRoute.push({ pathname: route.pathname, tools })
    }

    const content = renderDawnTypes(manifest, toolTypesPerRoute)
    const outputPath = join(app.dawnDir, OUTPUT_FILE)

    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, content, "utf-8")
  } catch {
    // Silently catch errors — typegen during dev should not crash the server
  }
}

export function transformToolSource(source: string, fileName: string): string | null {
  const hasExistingDescription = /export\s+const\s+description\s*=/.test(source)
  const hasExistingSchema = /export\s+const\s+schema\s*=/.test(source)

  // If both already exist, nothing to inject
  if (hasExistingDescription && hasExistingSchema) {
    return null
  }

  const jsDoc = extractJsDoc(source, fileName)
  const typeInfo = extractParameterType(source, fileName)

  const needsDescription = !hasExistingDescription && jsDoc.description !== undefined
  const needsSchema = !hasExistingSchema && typeInfo !== null && typeInfo.kind !== "unknown"

  if (!needsDescription && !needsSchema) {
    return null
  }

  const injections: string[] = []

  if (needsDescription) {
    injections.push(`export const description = ${JSON.stringify(jsDoc.description)}`)
  }

  if (needsSchema && typeInfo) {
    // Merge JSDoc @param descriptions into TypeInfo properties
    const paramDescriptions = new Map(Object.entries(jsDoc.params))
    if (typeInfo.kind === "object") {
      for (const prop of typeInfo.properties) {
        const desc = paramDescriptions.get(prop.name)
        if (desc && !prop.description) {
          // PropertyInfo is readonly, so we need to work around it
          ;(prop as { description?: string }).description = desc
        }
      }
    }
    const zodCode = generateZodSchema(typeInfo, paramDescriptions)
    injections.push(`import { z } from "zod"`)
    injections.push(`export const schema = ${zodCode}`)
  }

  return `${injections.join("\n")}\n${source}`
}
