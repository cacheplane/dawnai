import { extractToolArtifactsForRoute } from "../compiler/index.js"
import type { ExtractedToolSchema } from "../types.js"

export interface ExtractToolSchemasOptions {
  readonly routeDir: string
  readonly sharedToolsDir: string | undefined
}

export async function extractToolSchemasForRoute(
  options: ExtractToolSchemasOptions,
): Promise<readonly ExtractedToolSchema[]> {
  return extractToolArtifactsForRoute(options).schemas
}
