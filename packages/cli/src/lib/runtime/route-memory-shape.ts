/**
 * The `node:`-free half of `load-memory.ts`: the descriptor shape and its
 * validator, shared by the disk loader and `buildStaticRouteModule`. Split out
 * so the `@dawn-ai/cli/fetch` graph never reaches the tsx-backed loader.
 */

/**
 * Structural shape of a memory definition's default export. Kept local (rather
 * than importing `DefinedMemory` from `@dawn-ai/sdk`) to avoid any potential
 * build-graph cycle — the same cycle-avoidance pattern used in load-evals.ts.
 */
export interface LoadedRouteMemory {
  readonly kind: "semantic" | "episodic" | "procedural" | "reflection"
  readonly scope: readonly string[]
  readonly schema: unknown // a zod schema; validated structurally at use sites
  readonly identity?: readonly string[]
}

/**
 * The validating core of {@link loadRouteMemory}: check an already-imported
 * memory module's default export. Exported so the static-modules runtime
 * helper (`buildStaticRouteModule`) applies the exact same descriptor rules to
 * statically-imported `memory.ts` modules.
 */
export function normalizeRouteMemoryExport(def: unknown, memoryFile: string): LoadedRouteMemory {
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
