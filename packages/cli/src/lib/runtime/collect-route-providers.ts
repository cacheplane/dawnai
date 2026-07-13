import type { RouteManifest } from "@dawn-ai/core"
import { inferProvider, isDawnAgent } from "@dawn-ai/sdk"

import { type NormalizedRouteModule, normalizeRouteModule } from "./load-route-kind.js"

/**
 * The deduped set of model providers the app's agent routes actually use.
 * Each route's provider is its explicit `provider`, else inferred from its
 * `model` id (the same `inferProvider` the model-id validation uses). Feeds
 * verify's provider-derived API-key check. Load failures are skipped — they are
 * surfaced by the discovery/typegen checks, not this advisory derivation.
 */
export async function collectRouteProviders(manifest: RouteManifest): Promise<readonly string[]> {
  const providers = new Set<string>()
  for (const route of manifest.routes) {
    if (route.kind !== "agent") continue
    let normalized: NormalizedRouteModule
    try {
      normalized = await normalizeRouteModule(route.entryFile, manifest.appRoot)
    } catch {
      continue
    }
    if (!isDawnAgent(normalized.entry)) continue
    const provider = normalized.entry.provider ?? inferProvider(normalized.entry.model)
    if (provider) providers.add(provider)
  }
  return [...providers]
}
