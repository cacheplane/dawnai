import type { Page } from "@playwright/test"
import { BROWSE_PAGE_SIZE } from "../test/seed"
import { expect, test } from "./fixtures"
import {
  DRAWN_FIRST_WINDOW,
  DRAWN_FIRST_WINDOW_AFTER_SCENARIO_9,
  grid,
  MIN_RENDERED_ROWS,
  n,
  openBrowse,
  status,
  total,
} from "./helpers"

/** One `__group__:` header per namespace present in the first window. Derived from the
 *  projection rather than counted off the seed, and checked below against the projection
 *  the post-scenario-9 store produces, so the number holds whichever fixture state this
 *  run met (see `matchingPopulation` in scenario 10 for why there are two). */
const NAMESPACE_GROUPS = DRAWN_FIRST_WINDOW.length - BROWSE_PAGE_SIZE

/**
 * Every group heading in the loaded model — label → child-count text — gathered by
 * sweeping the viewport.
 *
 * The grid virtualizes, so exactly one of the headings is in the document at rest: a
 * claim about "the group counts" cannot be read off one screenful, and a spec that
 * asserted only what it could see would be asserting one third of the model. The step is
 * a third of a viewport, so no heading can fall between two samples, and each step
 * scrolls and reads inside ONE page evaluation — a driver round trip between the two
 * would let a poll tick re-render the rows in the gap and drop a heading from the sweep.
 */
async function sweepGroupHeadings(page: Page): Promise<Map<string, string>> {
  const headings = new Map<string, string>()
  const { max, step } = await grid(page).evaluate((node) => ({
    max: node.scrollHeight - node.clientHeight,
    step: Math.max(Math.floor(node.clientHeight / 3), 1),
  }))
  for (let top = 0; top <= max + step; top += step) {
    const found = await grid(page).evaluate(
      async (node, offset) => {
        node.scrollTop = offset
        // Three frames: the scroll handler sets React state, the re-render commits, and
        // the browser paints. A sample taken earlier answers the PREVIOUS window — which
        // the overlapping step would recover from, but silently and one sample later.
        for (let frame = 0; frame < 3; frame += 1) {
          await new Promise(requestAnimationFrame)
        }
        return Array.from(node.querySelectorAll("[data-pretable-group-row]")).map((row) => ({
          label: row.querySelector("[data-pretable-group-label]")?.textContent ?? "",
          count: row.querySelector("[data-pretable-group-count]")?.textContent ?? "",
        }))
      },
      Math.min(top, max),
    )
    for (const { label, count } of found) headings.set(label, count)
  }
  return headings
}

// D1-COUNT-04. Grouping over a partial window is permitted but MARKED: child counts are
// rendered loaded-scoped and the grid downgrades its ARIA counts to the loaded model.
// Presenting a loaded-children count as a population count is what this bans.
//
// The plan wrote this scenario as a branch — "either the prototype is off for a partial
// result, or it is loaded-scoped" — because both are conformant. The shipped disposition
// is known and is not a branch: `list-page.tsx` passes `groupByNamespace={namespace ===
// undefined}`, so the unscoped browse this opens on is ALWAYS grouped. Pinning that
// disposition is the stronger claim; a branch would let grouping silently switch off and
// still report green over an arm that never ran.
test.describe("scenario 11 — partial grouping honesty", () => {
  test.setTimeout(90_000)

  test("grouping over a partial window is loaded-scoped, and ARIA downgrades with it", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    // The premise: the window IS partial. Read off the page because two fixture states
    // reach this file (scenario 9 forgets a record when the whole suite runs), and the
    // claim is the RELATION — a grid holding everything makes every line below vacuous.
    await expect(status(page)).toContainText(`${n(BROWSE_PAGE_SIZE)} loaded of `)
    const matching = Number((await total(page).innerText()).replaceAll(",", ""))
    expect(BROWSE_PAGE_SIZE).toBeLessThan(matching)

    // Grouped, and saying so in the role. `treegrid` is also what makes the ARIA
    // downgrade below the correct answer rather than a missing feature.
    await expect(grid(page)).toHaveAttribute("role", "treegrid")
    const drawn = await grid(page).locator("[data-pretable-row-id]").count()
    expect(drawn).toBeGreaterThanOrEqual(MIN_RENDERED_ROWS)
    await expect(
      grid(page).locator('[data-pretable-group-row][aria-expanded="true"]').first(),
    ).toBeVisible()

    // The two fixture states agree on how many namespaces the first window covers, which
    // is what lets the constant be a constant.
    expect(DRAWN_FIRST_WINDOW_AFTER_SCENARIO_9.length - BROWSE_PAGE_SIZE).toBe(NAMESPACE_GROUPS)

    // Retried as a whole: the sweep drives the scroll box while a 2 s poll re-renders
    // underneath it, so a heading missed at one step is re-gathered rather than reported.
    await expect(async () => {
      const headings = await sweepGroupHeadings(page)
      expect(headings.size, "group headings found in the loaded model").toBe(NAMESPACE_GROUPS)
      let children = 0
      for (const [label, count] of headings) {
        // The honesty marker itself: `groupChildCountLabel` is called with
        // `scope: "loaded"`, so every heading reads "(N loaded)". A bare "(N)" is the
        // shape this scenario exists to reject — it makes a claim about the population.
        expect(count, `group "${label}"`).toMatch(/^\(\d+ loaded\)$/)
        const digits = /\d+/.exec(count)
        if (digits === null) throw new Error(`group "${label}" has no child count: ${count}`)
        children += Number(digits[0])
      }
      // …and the counts add up to what is LOADED, not to what MATCHES. This is the
      // assertion D1-COUNT-04 reduces to: group counts sourced from the population would
      // sum to `matching` here, and the word "loaded" above would be a label over the
      // wrong number.
      expect(children, "children summed over every group heading").toBe(BROWSE_PAGE_SIZE)
    }).toPass({ timeout: 30_000 })

    // Design §4.5: grouping destroys the loaded-index → dataset-position mapping, so
    // `aria-rowcount` REVERTS to the loaded model — the records, one heading each, and
    // the header row — and the population honesty moves to the status chrome asserted
    // above. Pinned exactly rather than bounded: `toBeLessThan(matching + 1)` is also
    // satisfied by a grid that published a single row.
    await expect(grid(page)).toHaveAttribute(
      "aria-rowcount",
      String(BROWSE_PAGE_SIZE + NAMESPACE_GROUPS + 1),
    )
    // Stated separately anyway, because it is the prohibition rather than the value: the
    // population is NOT what a grouped grid publishes as its row count.
    expect(BROWSE_PAGE_SIZE + NAMESPACE_GROUPS + 1).toBeLessThan(matching + 1)
  })
})
