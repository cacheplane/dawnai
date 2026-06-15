import type { RouteManifest } from "@dawn-ai/core"
import { isDawnAgent, validateModelId } from "@dawn-ai/sdk"

import { type NormalizedRouteModule, normalizeRouteModule } from "./load-route-kind.js"

/**
 * Advisory pass: warn (never fail) when an agent route's model id is not in
 * the curated list for its resolved provider. Returns the warning lines so
 * callers control where they surface.
 */
export async function collectUnknownModelIdWarnings(
  manifest: RouteManifest,
): Promise<readonly string[]> {
  const warnings: string[] = []
  for (const route of manifest.routes) {
    if (route.kind !== "agent") continue
    let normalized: NormalizedRouteModule
    try {
      normalized = await normalizeRouteModule(route.entryFile, manifest.appRoot)
    } catch {
      continue // load failures are surfaced by discovery paths, not this advisory pass
    }
    if (!isDawnAgent(normalized.entry)) continue
    const verdict = validateModelId({
      model: normalized.entry.model,
      ...(normalized.entry.provider ? { provider: normalized.entry.provider } : {}),
    })
    if (!verdict.ok) {
      const suggestions = verdict.suggestions.map((s) => `"${s}"`).join(", ")
      warnings.push(
        `⚠ ${route.pathname}: model "${normalized.entry.model}" is not a known ${verdict.provider} model id.` +
          (suggestions ? ` Did you mean ${suggestions}?` : "") +
          `\n  Known-id lists are advisory — new or proxy model ids work if your provider accepts them.`,
      )
    }
  }
  return warnings
}
