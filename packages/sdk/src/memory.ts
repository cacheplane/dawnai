import type { z } from "zod"

export type MemoryScopeDimension = "workspace" | "route" | "tenant" | "user" | "agent"

export interface DefinedMemory<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly kind: "semantic" | "episodic" | "procedural" | "reflection"
  readonly scope: readonly MemoryScopeDimension[]
  readonly schema: S
  /** Identity keys for write reconciliation; defaults to ["subject","predicate"] for semantic. */
  readonly identity?: readonly string[]
}

/** Declare a route's typed long-term memory. Place in `memory.ts` next to index.ts. */
export function defineMemory<S extends z.ZodTypeAny>(def: {
  kind: DefinedMemory["kind"]
  scope: readonly MemoryScopeDimension[]
  schema: S
  identity?: readonly string[]
}): DefinedMemory<S> {
  return {
    kind: def.kind,
    scope: def.scope,
    schema: def.schema,
    ...(def.identity ? { identity: def.identity } : {}),
  }
}
