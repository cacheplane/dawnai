import { basename, join } from "node:path"
import type { MemoryContext, MemoryStoreLike } from "@dawn-ai/core"
import { loadDawnConfig } from "@dawn-ai/core"
import { serializeNamespace, sqliteMemoryStore } from "@dawn-ai/memory"
import type { LoadedRouteMemory } from "./load-memory.js"

/**
 * Resolves the MemoryStore for the given appRoot.
 *
 * Uses `config.memory.store` if the user's `dawn.config.ts` provides one;
 * otherwise falls back to the default SQLite-backed store at
 * `<appRoot>/.dawn/memory.sqlite`.
 */
export async function resolveMemoryStore(appRoot: string): Promise<MemoryStoreLike> {
  try {
    const loaded = await loadDawnConfig({ appRoot })
    if (loaded.config.memory?.store) return loaded.config.memory.store as MemoryStoreLike
  } catch {
    // no dawn.config.ts / unreadable — use default
  }
  return sqliteMemoryStore({
    path: join(appRoot, ".dawn", "memory.sqlite"),
  }) as unknown as MemoryStoreLike
}

/**
 * Resolves the memory write-governance mode for the given appRoot.
 *
 * Defaults to `"candidate"` when no config is present.
 */
export async function resolveMemoryWrites(appRoot: string): Promise<"off" | "candidate" | "auto"> {
  try {
    const loaded = await loadDawnConfig({ appRoot })
    return loaded.config.memory?.writes ?? "candidate"
  } catch {
    return "candidate"
  }
}

/** Build the per-request memory capability context for a route with a memory.ts. */
export function buildMemoryContext(args: {
  defined: LoadedRouteMemory
  store: MemoryContext["store"]
  writes: "off" | "candidate" | "auto"
  appRoot: string
  routePath: string
  now: string
  indexMaxEntries?: number
  extraScope?: Record<string, string>
}): MemoryContext {
  const { defined } = args
  // Build all available dimensions from known sources.
  const allDims: Record<string, string> = {
    workspace: basename(args.appRoot) || "app",
    route: args.routePath,
    ...(args.extraScope ?? {}),
  }
  // Restrict to only the dimensions this route declared in scope.
  // serializeNamespace accepts the MemoryScopeTuple keys (workspace, route, tenant, user, agent).
  const tuple: Record<string, string> = {}
  for (const dim of defined.scope) {
    if (allDims[dim] !== undefined) tuple[dim] = allDims[dim]
  }
  const namespace = serializeNamespace(
    tuple as import("@dawn-ai/memory").MemoryScopeTuple & Record<string, string>,
  )
  const schema = defined.schema as {
    safeParse(d: unknown): { success: boolean; data?: unknown; error?: { message: string } }
  }
  return {
    store: args.store,
    namespace,
    writes: args.writes,
    defined: {
      kind: defined.kind,
      scope: defined.scope,
      ...(defined.identity ? { identity: defined.identity } : {}),
    },
    validate: (data: unknown) => {
      const r = schema.safeParse(data)
      return r.success
        ? { ok: true as const, value: (r.data ?? {}) as Record<string, unknown> }
        : { ok: false as const, errors: r.error?.message ?? "memory data failed schema validation" }
    },
    now: args.now,
    ...(args.indexMaxEntries !== undefined ? { indexMaxEntries: args.indexMaxEntries } : {}),
  }
}
