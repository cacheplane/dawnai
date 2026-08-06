import { existsSync } from "node:fs"
import { join } from "node:path"
import { discoverRoutes } from "@dawn-ai/core"
import { parseNamespace, routeNamespaceKey } from "@dawn-ai/memory/namespace"
import { CliError, formatErrorMessage } from "../output.js"
import { loadRouteMemory } from "./load-memory.js"

/**
 * Resolve the identity keys governing supersede reconciliation for a record's
 * namespace: find the route whose namespace key matches, load its memory.ts,
 * and use its declared `identity`. Falls back to [subject, predicate] when the
 * route (or its memory.ts) cannot be resolved. Shared by `dawn memory approve`
 * and the dev server's POST /memory/candidates/:id/approve endpoint.
 */
// mirrored in packages/inspector/src/store/identity.ts — keep in sync
export async function resolveIdentityKeys(
  appRoot: string,
  namespace: string,
): Promise<{ keys: readonly string[]; fallback: boolean }> {
  const DEFAULT = ["subject", "predicate"] as const
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
      const def = await loadRouteMemory(memoryFile)
      return { keys: def.identity ?? DEFAULT, fallback: false }
    } catch (cause) {
      throw new CliError(`Failed to load ${memoryFile}: ${formatErrorMessage(cause)}`, 1, { cause })
    }
  }
  return { keys: DEFAULT, fallback: true }
}
