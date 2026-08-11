import type { MemoryRecord } from "@dawn-ai/memory"
import {
  BROWSE_PAGE_SIZE,
  BROWSE_SEED_COUNT,
  browseSeedRecords,
  seedIdsInDefaultOrder,
} from "../test/seed"
import { expect, test } from "./fixtures"
import { grid, openBrowse, rowIds, status, statusText } from "./helpers"

/** Pretable's group row id, mirrored: `__group__:<columnId>=s:<value>` with `%`, `/`
 *  and `=` percent-escaped (grid-core `makeGroupId`/`escapeGroupKey`). */
function groupRowId(namespace: string): string {
  const escaped = namespace.replace(/%/g, "%25").replace(/\//g, "%2F").replace(/=/g, "%3D")
  return `__group__:namespace=s:${escaped}`
}

/** Pretable orders group siblings with these exact options (grid-core `sortSiblings`),
 *  ascending unless the active sort targets the grouped column — which the browse
 *  default, `updatedAt DESC`, does not. Constructed the same way here so this really is
 *  the shipped comparator, and not a lookalike that happens to agree on three
 *  lowercase-ASCII namespaces. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** A floor on how much of the window the virtualizer has to actually draw. The grid caps
 *  its viewport height, so only a fraction of the 200 loaded rows is ever in the
 *  document — but without a floor, `slice(0, ids.length)` lets the value under test
 *  choose its own coverage, and a regression that collapsed the grid to a single row
 *  would still satisfy both `toBeVisible` and the order assertion. Well under the ~19
 *  the capped viewport currently fits, because that count is a rendering detail and this
 *  is a floor, not a pin. */
const MIN_RENDERED_ROWS = 15

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
  // Naming the fixture is what subscribes to it; the console-error gate runs in its
  // teardown, so the unused-looking parameter IS the subscription.
  void consoleErrors
  await openBrowse(page)
  await expect(grid(page)).toBeVisible()

  // The window and the population, both read off the page: `loaded` is the page size the
  // server actually returned and `total` the count it matched over the whole store. The
  // only claim here that does not depend on how much of the window the grid draws — the
  // row assertion below sees 18 records of the 200.
  await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT))

  // Re-read inside the retry rather than once before it: the rendered set can still
  // change a frame after the phase reads `idle` (see `rowIds`), and a floor over a single
  // snapshot would convert that into a flake.
  await expect(async () => {
    const ids = await rowIds(page)
    expect(ids.length).toBeGreaterThanOrEqual(MIN_RENDERED_ROWS)
    expect(ids.length).toBeLessThanOrEqual(BROWSE_PAGE_SIZE)
    // The head of the documented default order as the grid DRAWS it, not an arbitrary
    // slice: this one assertion is what makes every later "beyond the window" claim mean
    // something. Sliced by rendered count because the grid virtualizes.
    expect(ids).toEqual(groupedFirstWindow().slice(0, ids.length))
    // Bounded well under the test timeout: a genuinely wrong window would otherwise
    // retry for the full 60 s and report as a timeout rather than as a diff.
  }).toPass({ timeout: 15_000 })
})
