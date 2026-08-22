import {
  type DawnActivityClassNames,
  SubagentActivityCard,
  type SubagentActivityContentOutput,
} from "@dawn-ai/ag-ui/react"

/**
 * The workbench's subagent card — the plan card's treatment plus the parts only
 * this card has: the depth badge, the section labels, and the failure message.
 *
 * Same constraint as `PlanCard`: every class sets a property the package sheet
 * leaves unset on that element, because unlayered package rules beat Tailwind's
 * `@layer utilities` output regardless of specificity.
 *
 * `classNames` is passed WHOLE into the card's two checklists, so `section`,
 * `list`, `item*` and friends apply to the plan list and the tools list alike —
 * and `section` lands on both the outer `<section>` and the checklist's own
 * inner wrapper. Anything box-like (a divider, padding) would therefore double
 * up, which is why the separators this look wants are absent below.
 */
const subagentClassNames: DawnActivityClassNames = {
  // letter-spacing — inherited by every part, same as the plan card.
  root: "tracking-tight",
  // font-weight — the subagent's name, at 500 rather than the header's 600.
  title: "font-medium",
  // font-variant-numeric — the " · N tools" counter.
  meta: "tabular-nums",
  // text-transform + letter-spacing — the "nested" chip reads as a label, not a
  // word. (Its background and font-size belong to the package and cannot be
  // changed from here.)
  badge: "uppercase tracking-wide",
  // text-transform + letter-spacing — "Plan"/"Tools" as small-caps eyebrows,
  // the one piece of structure the card exposes above the lists.
  sectionLabel: "uppercase tracking-[0.08em]",
  // width + text-align — fixed glyph column, shared by the plan checklist and
  // the tools list. No display utility: a flex item of `__item` is blockified,
  // so `inline-*` would be inert.
  itemGlyph: "w-4 text-center",
  // line-height.
  itemLabel: "leading-5",
  // white-space — "completed"/"incomplete" stay on one line.
  itemStatus: "whitespace-nowrap",
  // font-variant-numeric — "+N more".
  overflow: "tabular-nums",
  // border-left-width + padding-left — a failure gets a rule down its edge. No
  // border-color class: the package sets `color: var(--dawn-activity-failed)` on
  // this element and an unspecified border-color resolves to `currentColor`, so
  // the rule already tracks the failure color (and any theme override of it) for
  // free. Naming the token here would only duplicate that.
  error: "border-l-2 pl-2",
}

export function SubagentCard({ content }: { content: SubagentActivityContentOutput }) {
  return <SubagentActivityCard content={content} classNames={subagentClassNames} />
}
