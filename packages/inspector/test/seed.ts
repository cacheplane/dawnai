import { join } from "node:path"
import type { MemoryKind, MemoryRecord, MemoryStatus } from "@dawn-ai/memory"
import { sqliteMemoryStore } from "@dawn-ai/memory"
import type { BrowseSortEntry } from "@dawn-ai/memory/browse"

/** The Inspector's request window (design §11 "default window / page size"). */
export const BROWSE_PAGE_SIZE = 200
/** The client-side resident cap (design §11), deliberately equal to BROWSE_MAX_LIMIT. */
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

/** `route=/notes-archive` exists ONLY so an exact `route=/notes` can prove it excludes
 *  prefix siblings (dogfood scenario 4). */
function namespaceFor(index: number): string {
  if (index % 5 === 0) return "route=/notes-archive"
  if (index % 3 === 0) return "route=/chat"
  return "route=/notes"
}

/**
 * The fixture, as data. Pure and stable: every expectation in the verification lane is
 * computed from this array rather than transcribed, so a seed change moves the
 * expectations with it instead of reddening forty assertions at once.
 */
export function browseSeedRecords(): MemoryRecord[] {
  const records: MemoryRecord[] = []
  for (let index = 0; index < BROWSE_SEED_COUNT; index += 1) {
    // Ten records share each timestamp: the id tie-break then decides order INSIDE
    // every window, not only at a page seam that a single walk might never hit.
    const stamp = new Date(BASE_MS + Math.floor(index / 10) * 60_000).toISOString()
    records.push({
      id: `mem-${String(index).padStart(4, "0")}`,
      kind: KINDS[index % KINDS.length] as MemoryKind,
      namespace: namespaceFor(index),
      content: index === 900 ? `${NEEDLE_TERM} beyond the first window` : `acme threshold ${index}`,
      data: {},
      source: { type: "eval", id: "seed" },
      // 25 records per distinct value: a confidence window is deterministic only
      // because the store terminates every sort with `id ASC`.
      confidence: (index % 50) / 50,
      tags: [],
      status: STATUSES[index % STATUSES.length] as MemoryStatus,
      createdAt: stamp,
      updatedAt: stamp,
    })
  }
  return records
}

function compareBy(entries: readonly BrowseSortEntry[]) {
  return (a: MemoryRecord, b: MemoryRecord): number => {
    for (const entry of entries) {
      const left = a[entry.field]
      const right = b[entry.field]
      let delta = 0
      if (typeof left === "number" && typeof right === "number") delta = left - right
      else delta = String(left).localeCompare(String(right))
      if (delta !== 0) return entry.dir === "desc" ? -delta : delta
    }
    // The store's terminator, mirrored: id ASC, always, whatever the sort.
    return a.id.localeCompare(b.id)
  }
}

/** The documented default order: `updatedAt DESC, id ASC`. */
export function seedIdsInDefaultOrder(records = browseSeedRecords()): string[] {
  return seedIdsSortedBy([{ field: "updatedAt", dir: "desc" }], records)
}

export function seedIdsSortedBy(
  entries: readonly BrowseSortEntry[],
  records = browseSeedRecords(),
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

/** The predicate semantics of `BrowseQuery`, as a pure filter over the fixture. */
export function seedRecordsMatching(
  predicate: SeedPredicate,
  records = browseSeedRecords(),
): MemoryRecord[] {
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
      !record.content.toLowerCase().includes(predicate.contentContains.toLowerCase())
    )
      return false
    if (predicate.confidenceGte !== undefined && record.confidence < predicate.confidenceGte)
      return false
    return true
  })
}

/** Write the fixture into `<appRoot>/.dawn/memory.sqlite`. Node-only. */
export async function writeBrowseSeed(appRoot: string): Promise<void> {
  const store = sqliteMemoryStore({ path: join(appRoot, ".dawn", "memory.sqlite") })
  for (const record of browseSeedRecords()) {
    await store.put(record)
  }
}
