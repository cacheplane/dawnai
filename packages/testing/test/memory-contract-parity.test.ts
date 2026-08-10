// Compile-time tripwire: @dawn-ai/core's structural MemoryStoreLike (config-facing)
// and @dawn-ai/memory's MemoryStore (runtime contract) must stay mutually
// assignable. Core cannot import memory (node:sqlite barrel), so the duplicated
// literal unions live in both packages — this file is where drift fails LOCALLY
// and legibly instead of as an assignability wall in resolve-memory.ts.
import type {
  BrowsePageLike,
  BrowseQueryLike,
  MemoryKindLike,
  MemorySourceTypeLike,
  MemoryStatusLike,
  MemoryStoreLike,
} from "@dawn-ai/core"
import type {
  BrowsePage,
  BrowseQuery,
  MemoryKind,
  MemorySource,
  MemoryStatus,
  MemoryStore,
} from "@dawn-ai/memory"
import { expect, it } from "vitest"

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

/**
 * Invariant TYPE IDENTITY, for shapes that must match exactly rather than merely
 * interoperate. `Mutual` is not strong enough for those: mutual assignability is
 * blind to an ADDED OPTIONAL property, because `{a?: X}` and `{a?: X; b?: Y}` are
 * assignable in BOTH directions (the extra key is permitted going one way and may
 * be absent going the other). `BrowseQuery` is optional properties almost end to
 * end, so the single most likely drift — someone adds a new optional filter field
 * to one side — would sail past a `Mutual` check. This deferred-conditional trick
 * compares A and B by TypeScript's internal identity relation instead, which is
 * sensitive to key sets, optionality and modifiers. Verified to fire: adding
 * `readonly namespace?: string` to `BrowseQuery` alone fails this file.
 *
 * Reserved for the browse types. `MemoryStore`/`MemoryStoreLike` are DELIBERATELY
 * non-identical (e.g. the mirror's `search` takes `vector?: unknown` where the real
 * query takes `VectorRankingOptions`), so they stay on `Mutual`.
 */
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : never

const kind: Mutual<MemoryKind, MemoryKindLike> = true
const status: Mutual<MemoryStatus, MemoryStatusLike> = true
const sourceType: Mutual<MemorySource["type"], MemorySourceTypeLike> = true
const store: Mutual<MemoryStore, MemoryStoreLike> = true
// The store-level check above is NOT enough on its own: `browse(q?: …)` is a method,
// and TypeScript checks method parameters bivariantly — a mirror that forgot a union
// member (as it did for #432's status/kind sets) stays assignable. Comparing the query
// and page types DIRECTLY, and by identity rather than assignability, is what makes
// drift fail here instead of in production. See `Identical` for why not `Mutual`.
const browseQuery: Identical<BrowseQuery, BrowseQueryLike> = true
const browsePage: Identical<BrowsePage, BrowsePageLike> = true

it("memory/core store contracts are mutually assignable (compile-time)", () => {
  expect([kind, status, sourceType, store, browseQuery, browsePage]).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
  ])
})
