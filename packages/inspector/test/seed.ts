import type { MemoryKind, MemoryRecord, MemoryStatus } from "@dawn-ai/memory"
import type { BrowseSortEntry } from "@dawn-ai/memory/browse"

/** The Inspector's request window (design §11 "default window / page size"). A PROPOSAL
 *  until tasks 18 and 21 measure it; pinned here so a change to it is a deliberate edit
 *  rather than a drift. */
export const BROWSE_PAGE_SIZE = 200
/** The client-side resident cap (design §11, likewise proposed), deliberately equal to
 *  BROWSE_MAX_LIMIT. */
export const BROWSE_RESIDENT_CAP = 1000
/** Six-and-a-quarter windows: proves paging, proves the cap, and leaves 250 records
 *  the client can never hold at once. */
export const BROWSE_SEED_COUNT = 1250

/** The one record whose content is unique, placed beyond the first default window so a
 *  content filter that finds it can only have been applied server-side. */
export const NEEDLE_ID = "mem-0900"
export const NEEDLE_TERM = "zephyr-needle"

const KINDS: readonly MemoryKind[] = ["semantic", "episodic", "procedural", "reflection"]
const STATUSES: readonly MemoryStatus[] = ["candidate", "active", "superseded"]
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0)
/** Coprime with BROWSE_SEED_COUNT (= 2·5⁴), so `step * EMIT_STRIDE % COUNT` visits every
 *  index exactly once. Emitting out of id order is load-bearing, not cosmetic: sorts are
 *  stable and rows reach the store in emission order, so an id-ordered fixture hands back
 *  id-ordered ties from a comparator — or a store — that has no `id ASC` terminator at
 *  all, and the determinism this whole fixture exists to prove would be an artifact of
 *  the input rather than a property of the query. */
const EMIT_STRIDE = 617

/** `route=/notes-archive` exists ONLY so an exact `route=/notes` can prove it excludes
 *  prefix siblings (dogfood scenario 4). */
function namespaceFor(index: number): string {
  if (index % 5 === 0) return "route=/notes-archive"
  if (index % 3 === 0) return "route=/chat"
  return "route=/notes"
}

function seedRecord(index: number): MemoryRecord {
  const id = `mem-${String(index).padStart(4, "0")}`
  // Ten records share each updatedAt: the id tie-break then decides order INSIDE
  // every window, not only at a page seam that a single walk might never hit.
  const minute = Math.floor(index / 10)
  return {
    id,
    kind: KINDS[index % KINDS.length] as MemoryKind,
    namespace: namespaceFor(index),
    content:
      id === NEEDLE_ID ? `${NEEDLE_TERM} beyond the first window` : `acme threshold ${index}`,
    data: {},
    source: { type: "eval", id: "seed" },
    // 25 records per distinct value: a confidence window is far narrower than the tie it
    // sits inside, so its contents are decided by the id terminator and not by the key.
    confidence: (index % 50) / 50,
    tags: [],
    status: STATUSES[index % STATUSES.length] as MemoryStatus,
    // Always before updatedAt — nothing is updated before it exists — but on a different
    // cycle, so `createdAt` order is NOT `updatedAt` order. With the two equal, every
    // downstream "this is the documented `updatedAt DESC` default" assertion would hold
    // just as well against a server that had sorted by createdAt.
    createdAt: new Date(BASE_MS + (minute - (index % 7) - 1) * 60_000).toISOString(),
    updatedAt: new Date(BASE_MS + minute * 60_000).toISOString(),
  }
}

/**
 * The fixture, as data. Pure and stable: every expectation in the verification lane is
 * computed from this array rather than transcribed, so a seed change moves the
 * expectations with it instead of reddening forty assertions at once.
 */
export function browseSeedRecords(): readonly MemoryRecord[] {
  const records: MemoryRecord[] = []
  for (let step = 0; step < BROWSE_SEED_COUNT; step += 1) {
    records.push(seedRecord((step * EMIT_STRIDE) % BROWSE_SEED_COUNT))
  }
  return records
}

/** SQLite's BINARY collation, which is the order both stores sort text in —
 *  `browse-order.ts` marks `namespace` `collateC` precisely to hold Postgres to it.
 *  `localeCompare` is ICU order instead, which puts "A" before "a" where BINARY puts it
 *  after. JS compares UTF-16 code units and SQLite compares UTF-8 bytes; those agree on
 *  everything below U+E000, which is every character this fixture uses. */
function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareBy(entries: readonly BrowseSortEntry[]) {
  return (a: MemoryRecord, b: MemoryRecord): number => {
    for (const entry of entries) {
      const left = a[entry.field]
      const right = b[entry.field]
      // Numbers compare as numbers. No confidence in [0, 1] can demonstrate that —
      // decimal strings there happen to sort exactly like their values — so
      // seed.test.ts pins this branch with out-of-domain values instead.
      const delta =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : compareBinary(String(left), String(right))
      if (delta !== 0) return entry.dir === "desc" ? -delta : delta
    }
    // The store's terminator, mirrored: id ASC, always, whatever the sort. Because the
    // fixture arrives out of id order, removing this line changes the answer.
    return compareBinary(a.id, b.id)
  }
}

/** The documented default order: `updatedAt DESC, id ASC`. */
export function seedIdsInDefaultOrder(
  records: readonly MemoryRecord[] = browseSeedRecords(),
): string[] {
  return seedIdsSortedBy([{ field: "updatedAt", dir: "desc" }], records)
}

export function seedIdsSortedBy(
  entries: readonly BrowseSortEntry[],
  records: readonly MemoryRecord[] = browseSeedRecords(),
): string[] {
  return [...records].sort(compareBy(entries)).map((record) => record.id)
}

export interface SeedPredicate {
  readonly namespace?: string
  readonly namespacePrefix?: string
  readonly status?: readonly MemoryStatus[]
  readonly kind?: readonly MemoryKind[]
  readonly contentContains?: string
  readonly confidenceGte?: number
}

/** SQLite's `lower()` without ICU folds ASCII and nothing else — `sqlite-browse-sql.ts`
 *  documents it: `lower('CAFÉ')` is `'cafÉ'` there and `'café'` in Postgres. JS
 *  `toLowerCase()` is full-Unicode and so models neither store; this models the one the
 *  verification lane actually queries. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase())
}

/** The predicate semantics of `BrowseQuery`, as a pure filter over the fixture. */
export function seedRecordsMatching(
  predicate: SeedPredicate,
  records: readonly MemoryRecord[] = browseSeedRecords(),
): readonly MemoryRecord[] {
  return records.filter((record) => {
    if (predicate.namespace !== undefined && record.namespace !== predicate.namespace) return false
    if (
      predicate.namespacePrefix !== undefined &&
      !record.namespace.startsWith(predicate.namespacePrefix)
    )
      return false
    if (predicate.status !== undefined && !predicate.status.includes(record.status)) return false
    if (predicate.kind !== undefined && !predicate.kind.includes(record.kind)) return false
    if (
      predicate.contentContains !== undefined &&
      !asciiLower(record.content).includes(asciiLower(predicate.contentContains))
    )
      return false
    if (predicate.confidenceGte !== undefined && record.confidence < predicate.confidenceGte)
      return false
    return true
  })
}
