import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

import type { AnalyzedTool } from "./model.js"
import { analyzeToolFiles } from "./typescript-backend.js"

export interface AnalyzeRouteToolsOptions {
  readonly routeDir: string
  readonly sharedToolsDir: string | undefined
  /** Declaration location used as the base for emitted type references. */
  readonly typeReferenceFileName?: string
}

export function createAnalyzeRouteTools(
  analyzeEffectiveToolFiles: (
    toolFiles: ReadonlyMap<string, string>,
    typeReferenceFileName?: string,
  ) => readonly AnalyzedTool[],
): (options: AnalyzeRouteToolsOptions) => readonly AnalyzedTool[] {
  return (options) => {
    const routeToolFiles = discoverToolFiles(join(options.routeDir, "tools"))
    const sharedToolFiles = options.sharedToolsDir
      ? discoverToolFiles(join(options.sharedToolsDir, "tools"))
      : new Map<string, string>()

    const effectiveToolFiles = new Map(sharedToolFiles)
    for (const [name, filePath] of routeToolFiles) {
      effectiveToolFiles.set(name, filePath)
    }

    const sortedToolFiles = new Map(
      [...effectiveToolFiles].sort(([left], [right]) => left.localeCompare(right)),
    )
    return analyzeEffectiveToolFiles(sortedToolFiles, options.typeReferenceFileName)
  }
}

const analyzeRouteToolsWithBackend = createAnalyzeRouteTools(analyzeToolFiles)

export function analyzeRouteTools(options: AnalyzeRouteToolsOptions): readonly AnalyzedTool[] {
  return analyzeRouteToolsWithBackend(options)
}

function discoverToolFiles(toolsDir: string): Map<string, string> {
  const files = new Map<string, string>()
  if (!existsSync(toolsDir)) return files

  for (const entry of readdirSync(toolsDir)) {
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue
    files.set(entry.slice(0, -".ts".length), join(toolsDir, entry))
  }

  return files
}
