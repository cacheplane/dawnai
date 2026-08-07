import type { RouteDefinition, RouteManifest } from "@dawn-ai/core"
import { inferProvider, isDawnAgent } from "@dawn-ai/sdk"

import { type NormalizedRouteModule, normalizeRouteModule } from "./load-route-kind.js"

/** A route whose module could not be imported, so its provider is unknown. */
export interface RouteProviderLoadFailure {
  readonly route: RouteDefinition
  readonly error: unknown
}

/** Providers found, plus the routes that could not be asked. */
export interface RouteProviderScan {
  /** The deduped providers of every agent route that DID load. */
  readonly providers: readonly string[]
  /**
   * Routes whose module threw on import. Their providers are missing from
   * `providers` — a caller that needs an EXHAUSTIVE set (a bundler's static
   * import map, say) must treat a non-empty list as a failure rather than
   * quietly shipping a narrower map than the app actually uses.
   */
  readonly loadFailures: readonly RouteProviderLoadFailure[]
  /**
   * Agent routes that loaded but whose provider could not be determined —
   * no explicit `provider`, and a `model` id `inferProvider` does not
   * recognize. Same consequence as a load failure for an exhaustive caller:
   * a package the app will reach for is missing from the set.
   */
  readonly unresolved: readonly RouteDefinition[]
}

/**
 * Scan the app's agent routes for the model providers they use, reporting
 * load failures instead of swallowing them.
 *
 * Each route's provider is its explicit `provider`, else inferred from its
 * `model` id (the same `inferProvider` the model-id validation uses).
 */
export async function scanRouteProviders(manifest: RouteManifest): Promise<RouteProviderScan> {
  const providers = new Set<string>()
  const loadFailures: RouteProviderLoadFailure[] = []
  const unresolved: RouteDefinition[] = []
  for (const route of manifest.routes) {
    if (route.kind !== "agent") continue
    let normalized: NormalizedRouteModule
    try {
      normalized = await normalizeRouteModule(route.entryFile, manifest.appRoot)
    } catch (error) {
      loadFailures.push({ route, error })
      continue
    }
    if (!isDawnAgent(normalized.entry)) continue
    const provider = normalized.entry.provider ?? inferProvider(normalized.entry.model)
    if (provider) providers.add(provider)
    else unresolved.push(route)
  }
  return { providers: [...providers], loadFailures, unresolved }
}

/**
 * The deduped set of model providers the app's agent routes actually use.
 * Feeds verify's provider-derived API-key check. Load failures are skipped —
 * they are surfaced by the discovery/typegen checks, not this advisory
 * derivation.
 *
 * ADVISORY on purpose: a narrower-than-reality answer only under-reports which
 * API keys to check. Callers for which a missing provider is a correctness bug
 * must use {@link scanRouteProviders} and act on `loadFailures`.
 */
export async function collectRouteProviders(manifest: RouteManifest): Promise<readonly string[]> {
  return (await scanRouteProviders(manifest)).providers
}
