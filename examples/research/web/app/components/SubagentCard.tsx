import {
  type DawnActivityClassNames,
  SubagentActivityCard,
  type SubagentActivityContentOutput,
} from "@dawn-ai/ag-ui/react"

/**
 * The workbench's subagent card — the plan card's treatment plus the parts only
 * this card has: the depth badge, the section labels, and the failure message.
 *
 * Same class-selection rule as `PlanCard`, and for the same reason: see
 * `activity-renderers.tsx`.
 *
 * One `classNames` object serves every list this card renders — the plan
 * checklist and the tools list — and `section` additionally lands on both the
 * outer `<section>` and the checklist's own inner wrapper nested inside it. So
 * anything box-like (a divider, padding) would draw twice, which is why the
 * separators this look wants are absent below.
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
  // width + flex-shrink + text-align — fixed glyph column across both lists.
  // `shrink-0` keeps the glyph from absorbing overflow that belongs to the
  // label; no display utility, since a flex item is blockified anyway.
  itemGlyph: "w-4 shrink-0 text-center",
  // line-height — tool names and todos share one rhythm; 20px on 13px text
  // stays readable when a long tool name wraps.
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
