import type { DawnPlanActivityContent } from "@dawn-ai/ag-ui"
import { type DawnActivityClassNames, PlanActivityCard } from "@dawn-ai/ag-ui/react"

/**
 * The workbench's plan card: SP1's component, customized through the ladder.
 *
 * Rung 1 (palette) is applied globally in `app/theme.css`. This adds rung 2 —
 * Tailwind utilities per part. Nothing here reimplements the card, so the
 * validation and the bounded-content rules stay where they are tested.
 *
 * Every class below sets a property the package stylesheet does NOT set on
 * that same element. That is a hard constraint, not a style preference: the
 * package sheet is unlayered and Tailwind's utilities live in
 * `@layer utilities`, so unlayered wins on any shared property no matter how
 * specific the utility is. See the report for the properties this rules out.
 */
const planClassNames: DawnActivityClassNames = {
  // letter-spacing — unset by the package, and it inherits, so one class gives
  // the whole card the workbench's tight tracking.
  root: "tracking-tight",
  // font-weight — the package's 600 lives on `__header` and is unreachable, but
  // nothing sets font-weight on the title itself, so 500 applies here. Crisp
  // neutral wants a title that is distinct from, not heavier than, the body.
  title: "font-medium",
  // font-variant-numeric — "1/2 complete" must not jitter as the counter moves.
  meta: "tabular-nums",
  // width + text-align — a fixed glyph column so ○ ◐ ✓ (different advance
  // widths) all leave labels starting at the same x. No display utility: the
  // glyph is a flex item of `__item`, so its `display` is blockified and any
  // `inline-*` class would be inert.
  itemGlyph: "w-4 text-center",
  // line-height — unset by the package; 20px on 13px text keeps wrapped todos
  // readable without the airy default.
  itemLabel: "leading-5",
  // white-space — keeps "in progress" on one line so it reads as a status chip
  // rather than a second line of prose.
  itemStatus: "whitespace-nowrap",
  // font-variant-numeric — "+3 more" shares the counter treatment.
  overflow: "tabular-nums",
}

export function PlanCard({ content }: { content: DawnPlanActivityContent }) {
  return <PlanActivityCard content={content} classNames={planClassNames} />
}
