import { pathToFileURL } from "node:url"

import { registerTsxLoader } from "./register-tsx-loader.js"
import { type LoadedRouteMemory, normalizeRouteMemoryExport } from "./route-memory-shape.js"

export { type LoadedRouteMemory, normalizeRouteMemoryExport } from "./route-memory-shape.js"

export async function loadRouteMemory(memoryFile: string): Promise<LoadedRouteMemory> {
  await registerTsxLoader()
  const mod = (await import(pathToFileURL(memoryFile).href)) as { default?: unknown }
  return normalizeRouteMemoryExport(mod.default, memoryFile)
}
