import type { MemoryRecord } from "@dawn-ai/memory"
import {
  BROWSE_PAGE_SIZE,
  BROWSE_SEED_COUNT,
  browseSeedRecords,
  seedIdsInDefaultOrder,
} from "../test/seed"
import { expect, test } from "./fixtures"
import { grid, openBrowse, rowIds } from "./helpers"

/** Pretable's group row id, mirrored: `__group__:<columnId>=s:<value>` with `%`, `/`
 *  and `=` percent-escaped (grid-core `makeGroupId`/`escapeGroupKey`). */
function groupRowId(namespace: string): string {
  const escaped = namespace.replace(/%/g, "%25").replace(/\//g, "%2F").replace(/=/g, "%3D")
  return `__group__:namespace=s:${escaped}`
}

/** Pretable orders group siblings with an `Intl.Collator`, not by byte — the three
 *  seeded namespaces are lowercase ASCII, where the two agree, but mirroring the real
 *  comparator keeps that a fact about the fixture rather than an assumption. */
const collator = new Intl.Collator()

/**
 * What the browse grid actually renders for the first server window.
 *
 * NOT the flat default order: `list-page` passes `groupByNamespace={namespace ===
 * undefined}`, so the unscoped browse — which is what `/memory` opens on — groups the
 * window by namespace. The engine emits one `__group__:` row per namespace, groups
 * ascending by key, rows inside a group still in the order the server returned them.
 * So this projection pins BOTH the server's `updatedAt DESC, id ASC` window and the
 * grouping applied over it; a server that returned a different window, or an id
 * tie-break that had drifted, moves rows across and within these buckets.
 */
function groupedFirstWindow(): string[] {
  const records: readonly MemoryRecord[] = browseSeedRecords()
  const namespaceOf = new Map(records.map((record) => [record.id, record.namespace]))
  const buckets = new Map<string, string[]>()
  for (const id of seedIdsInDefaultOrder(records).slice(0, BROWSE_PAGE_SIZE)) {
    const namespace = namespaceOf.get(id) as string
    const bucket = buckets.get(namespace)
    if (bucket) bucket.push(id)
    else buckets.set(namespace, [id])
  }
  const out: string[] = []
  for (const namespace of [...buckets.keys()].sort(collator.compare)) {
    out.push(groupRowId(namespace))
    out.push(...(buckets.get(namespace) as string[]))
  }
  return out
}

test("the standalone server serves the seeded browse dataset", async ({ page, consoleErrors }) => {
  void consoleErrors
  await openBrowse(page)
  await expect(grid(page)).toBeVisible()
  const ids = await rowIds(page)
  expect(ids.length).toBeGreaterThan(0)
  expect(ids.length).toBeLessThanOrEqual(BROWSE_PAGE_SIZE)
  // The head of the documented default order as the grid draws it, not an arbitrary
  // slice: this one assertion is what makes every later "beyond the window" claim mean
  // something. The slice is by rendered count because the grid virtualizes — only the
  // rows that fit the viewport are in the document, so this covers the head of the
  // window and not all BROWSE_PAGE_SIZE of it.
  expect(ids).toEqual(groupedFirstWindow().slice(0, ids.length))
  expect(BROWSE_SEED_COUNT).toBe(1250)
})
