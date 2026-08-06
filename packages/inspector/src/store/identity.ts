import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { importCore, importCoreNode, importMemory } from "./runtime-imports"

export interface ResolvedIdentity {
  readonly keys: readonly string[]
  readonly fallback: boolean
}

/**
 * Structural shape of a route memory definition's default export. Kept local
 * (rather than importing from `@dawn-ai/sdk`) to avoid a build-graph cycle —
 * same pattern as the CLI's load-memory.ts.
 */
interface LoadedRouteMemory {
  readonly kind: "semantic" | "episodic" | "procedural" | "reflection"
  readonly scope: readonly string[]
  readonly schema: unknown
  readonly identity?: readonly string[]
}

/**
 * Resolve the identity keys governing supersede reconciliation for a record's
 * namespace: find the route whose namespace key matches, load its memory.ts,
 * and use its declared `identity`. Falls back to [subject, predicate] when the
 * route (or its memory.ts) cannot be resolved.
 */
// mirrored in packages/cli/src/commands/memory.ts — keep in sync
export async function resolveIdentityKeys(
  appRoot: string,
  namespace: string,
): Promise<ResolvedIdentity> {
  const DEFAULT = ["subject", "predicate"] as const
  const { parseNamespace, routeNamespaceKey } = await importMemory()
  const { registerTsxLoader } = await importCore()
  const { discoverRoutes } = await importCoreNode()
  const routeKey = parseNamespace(namespace).route
  if (!routeKey) return { keys: DEFAULT, fallback: true }
  let manifest: Awaited<ReturnType<typeof discoverRoutes>>
  try {
    manifest = await discoverRoutes({ appRoot })
  } catch {
    // No dawn.config.ts / unreadable app — fall back to the default.
    return { keys: DEFAULT, fallback: true }
  }
  for (const route of manifest.routes) {
    if (routeNamespaceKey(route.pathname) !== routeKey) continue
    const memoryFile = join(route.routeDir, "memory.ts")
    if (!existsSync(memoryFile)) break
    // A memory.ts that EXISTS but fails to load must NOT silently fall back to
    // the default identity keys — wrong keys could miss or mis-target a
    // supersede. Surface the load failure instead.
    try {
      const def = await loadRouteMemory(memoryFile, registerTsxLoader)
      return { keys: def.identity ?? DEFAULT, fallback: false }
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`Failed to load ${memoryFile}: ${reason}`, { cause })
    }
  }
  return { keys: DEFAULT, fallback: true }
}

async function loadRouteMemory(
  memoryFile: string,
  registerTsxLoader: () => Promise<void>,
): Promise<LoadedRouteMemory> {
  // resolveStore()'s config load registers the tsx loader only when a
  // dawn.config.ts exists; register explicitly so memory.ts (TS source) loads
  // deterministically in the no-config case too.
  await registerTsxLoader()
  // Fully-dynamic runtime import of a user file — the ignore comments keep
  // Next's bundlers from trying to trace it (same rule as runtime-imports.ts).
  // Module-cache staleness (mirror of resolve.ts's dawn.config.ts note): the
  // ESM cache holds this memory.ts for the life of the process — and Node
  // caches FAILED evaluations too — so an edited (or fixed) memory.ts needs an
  // inspector restart to take effect.
  const mod = (await import(
    /* turbopackIgnore: true */ /* webpackIgnore: true */ pathToFileURL(memoryFile).href
  )) as { default?: unknown }
  const def = mod.default
  if (!def || typeof def !== "object") {
    throw new Error(`Memory file ${memoryFile} must default-export defineMemory(...)`)
  }
  const d = def as Record<string, unknown>
  if (typeof d.kind !== "string" || !Array.isArray(d.scope) || !d.schema) {
    throw new Error(
      `Memory file ${memoryFile} default export is not a valid defineMemory descriptor`,
    )
  }
  return d as unknown as LoadedRouteMemory
}
