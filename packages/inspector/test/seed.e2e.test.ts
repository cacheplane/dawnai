import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowseQuery, BrowseSortEntry, MemoryStore } from "@dawn-ai/memory"
import { sqliteMemoryStore } from "@dawn-ai/memory"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  BROWSE_SEED_COUNT,
  browseSeedRecords,
  NEEDLE_ID,
  NEEDLE_TERM,
  seedIdsInDefaultOrder,
  seedIdsSortedBy,
  seedRecordsMatching,
} from "./seed"
import { writeBrowseSeed } from "./seed-store"

/**
 * `seed.ts` models the store's ordering and filtering in TypeScript, and every
 * expectation in the verification lane is read out of that model. This file is the only
 * place the model is held against the thing it models: without it, a model that is wrong
 * in the same direction as a downstream assertion is green all the way down.
 *
 * It talks to the store directly rather than through the Inspector's HTTP layer — a
 * server would only add a way for the comparison to fail for reasons that are not about
 * the fixture.
 */

let appRoot: string
let store: MemoryStore

beforeAll(async () => {
  appRoot = mkdtempSync(join(tmpdir(), "dawn-browse-seed-"))
  await writeBrowseSeed(appRoot)
  store = sqliteMemoryStore({ path: join(appRoot, ".dawn", "memory.sqlite") })
})

afterAll(() => {
  rmSync(appRoot, { recursive: true, force: true })
})

/** Walk every page of a query, so an assertion covers the whole order and not just the
 *  head of it — the id tie-break decides seams as well as windows. */
async function browseAllIds(query: BrowseQuery = {}): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null = null
  for (;;) {
    const page = await store.browse(
      cursor === null ? { ...query, limit: 500 } : { ...query, limit: 500, cursor },
    )
    ids.push(...page.records.map((record) => record.id))
    if (!page.continuation) return ids
    cursor = page.continuation
  }
}

const SORTS: readonly (readonly BrowseSortEntry[])[] = [
  [{ field: "updatedAt", dir: "desc" }],
  [{ field: "updatedAt", dir: "asc" }],
  [{ field: "createdAt", dir: "desc" }],
  [{ field: "createdAt", dir: "asc" }],
  [{ field: "confidence", dir: "desc" }],
  [{ field: "confidence", dir: "asc" }],
  [{ field: "namespace", dir: "asc" }],
  [{ field: "namespace", dir: "desc" }],
  [{ field: "kind", dir: "asc" }],
  [{ field: "status", dir: "desc" }],
  [
    { field: "namespace", dir: "asc" },
    { field: "confidence", dir: "desc" },
  ],
]

describe("browse seed fixture against the real store", () => {
  it("writes every record verbatim", async () => {
    const page = await store.browse({ limit: 1 })
    expect(page.total).toBe(BROWSE_SEED_COUNT)
    const model = new Map(browseSeedRecords().map((record) => [record.id, record]))
    for (const id of [NEEDLE_ID, "mem-0000", "mem-1249"]) {
      expect(await store.get(id), id).toEqual(model.get(id))
    }
  })

  it("returns the model's default order when asked for no order at all", async () => {
    expect(await browseAllIds()).toEqual(seedIdsInDefaultOrder())
  })

  it("agrees with the model on every order the lane sorts by", async () => {
    for (const orderBy of SORTS) {
      const name = orderBy.map((entry) => `${entry.field} ${entry.dir}`).join(", ")
      expect(await browseAllIds({ orderBy }), name).toEqual(seedIdsSortedBy(orderBy))
    }
  })

  it("agrees with the model on every predicate the lane filters by", async () => {
    const cases: readonly {
      readonly name: string
      readonly query: BrowseQuery
      readonly expected: readonly string[]
    }[] = [
      {
        name: "status in [superseded]",
        query: { filters: [{ field: "status", op: "in", values: ["superseded"] }] },
        expected: seedIdsInDefaultOrder(seedRecordsMatching({ status: ["superseded"] })),
      },
      {
        name: "kind in [episodic]",
        query: { filters: [{ field: "kind", op: "in", values: ["episodic"] }] },
        expected: seedIdsInDefaultOrder(seedRecordsMatching({ kind: ["episodic"] })),
      },
      {
        name: "namespace equals route=/notes",
        query: { namespace: "route=/notes" },
        expected: seedIdsInDefaultOrder(seedRecordsMatching({ namespace: "route=/notes" })),
      },
      {
        name: "namespace prefix route=/notes",
        query: { namespacePrefix: "route=/notes" },
        expected: seedIdsInDefaultOrder(seedRecordsMatching({ namespacePrefix: "route=/notes" })),
      },
      {
        name: "content contains the needle",
        query: { filters: [{ field: "content", op: "contains", value: NEEDLE_TERM }] },
        expected: [NEEDLE_ID],
      },
      {
        name: "content contains the needle, upper-cased",
        query: {
          filters: [{ field: "content", op: "contains", value: NEEDLE_TERM.toUpperCase() }],
        },
        expected: [NEEDLE_ID],
      },
      {
        name: "confidence >= 0.5",
        query: { filters: [{ field: "confidence", op: "gte", value: 0.5 }] },
        expected: seedIdsInDefaultOrder(seedRecordsMatching({ confidenceGte: 0.5 })),
      },
    ]
    for (const { name, query, expected } of cases) {
      expect(await browseAllIds(query), name).toEqual(expected)
      expect((await store.browse({ ...query, limit: 1 })).total, name).toBe(expected.length)
    }
  })
})
