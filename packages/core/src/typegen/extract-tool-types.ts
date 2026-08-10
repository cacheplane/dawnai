import { extractToolArtifactsForRoute } from "../compiler/index.js"
import type { ExtractedToolType } from "../types.js"

export interface ExtractToolTypesOptions {
  readonly routeDir: string
  readonly sharedToolsDir: string | undefined
  /** Declaration location used as the base for emitted type references. */
  readonly typeReferenceFileName?: string
}

export async function extractToolTypesForRoute(
  options: ExtractToolTypesOptions,
): Promise<readonly ExtractedToolType[]> {
  return extractToolArtifactsForRoute(options).types
}
