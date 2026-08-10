// Compile-time tripwire: @dawn-ai/core's structural MemoryStoreLike (config-facing)
// and @dawn-ai/memory's MemoryStore (runtime contract) must stay in lockstep. Core
// cannot import memory (node:sqlite barrel), so the duplicated literal unions live in
// both packages — this file is where drift fails LOCALLY and legibly instead of as an
// assignability wall in resolve-memory.ts.
import type {
  BrowsePageLike,
  BrowseQueryLike,
  MemoryKindLike,
  MemoryRecordLike,
  MemorySourceTypeLike,
  MemoryStatusLike,
  MemoryStoreLike,
} from "@dawn-ai/core"
import type {
  BrowsePage,
  BrowseQuery,
  MemoryKind,
  MemoryRecord,
  MemorySource,
  MemoryStatus,
  MemoryStore,
} from "@dawn-ai/memory"

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

/**
 * Invariant TYPE IDENTITY, for the shapes that must match EXACTLY rather than merely
 * interoperate: the browse query/page and the record they carry.
 *
 * Assignability is too weak for those, twice over. First, `browse(q?: …)` is a METHOD,
 * and TypeScript checks method parameters bivariantly — so the
 * `Mutual<MemoryStore, MemoryStoreLike>` check below stays green even when the mirror
 * forgets a union member, which is exactly how #432's status/kind sets rotted unseen.
 * Second, mutual assignability is blind to an ADDED OPTIONAL property at all, because
 * `{a?: X}` and `{a?: X; b?: Y}` are assignable in BOTH directions (the extra key is
 * permitted going one way and may be absent going the other) — and `BrowseQuery` is
 * optional properties almost end to end, so "someone adds one filter field to one
 * side" would sail straight past `Mutual`. This deferred-conditional trick compares A
 * and B by TypeScript's internal identity relation instead, which is sensitive to key
 * sets, optionality and modifiers. Verified to fire: adding a single optional field to
 * one side alone — say a hypothetical `readonly tripwireProbe?: never` on
 * `BrowseQuery` — fails this file.
 *
 * `MemoryStore`/`MemoryStoreLike` themselves are DELIBERATELY non-identical (e.g. the
 * mirror's `search` takes `vector?: unknown` where the real query takes
 * `VectorRankingOptions`), so they stay on `Mutual`.
 */
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : never

const kind: Mutual<MemoryKind, MemoryKindLike> = true
const status: Mutual<MemoryStatus, MemoryStatusLike> = true
const sourceType: Mutual<MemorySource["type"], MemorySourceTypeLike> = true
const store: Mutual<MemoryStore, MemoryStoreLike> = true
// Asserted on its own line rather than left to `browsePage`'s deep comparison: the
// page pins the record transitively, but a record-only drift then fails on the PAGE,
// naming neither type — and the obvious way to quiet that is to loosen the page.
const record: Identical<MemoryRecord, MemoryRecordLike> = true
const browseQuery: Identical<BrowseQuery, BrowseQueryLike> = true
const browsePage: Identical<BrowsePage, BrowsePageLike> = true

void kind
void status
void sourceType
void store
void record
void browseQuery
void browsePage
