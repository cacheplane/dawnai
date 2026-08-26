/**
 * Rungs 2 and 3 of the customization ladder.
 *
 * `classNames` entries are APPENDED to the package defaults, never substituted.
 * Appending is not the same as winning, though: `styles.css` is unlayered, so a
 * consumer class only takes effect on a property that sheet leaves unset on the
 * same element. Anything the sheet does claim is reachable at rung 1 instead,
 * through the `--dawn-activity-*` tokens. Slot components replace a leaf's
 * rendering while the card keeps ownership of validation, ordering, and the
 * bounded-content rules.
 */
import type { ReactNode } from "react"

/** Structural parts every activity surface can expose. */
export interface DawnActivityClassNames {
  readonly root?: string
  readonly header?: string
  /** The disclosure triangle: an `aria-hidden` span, first child of the header. */
  readonly marker?: string
  readonly title?: string
  readonly meta?: string
  readonly badge?: string
  /** A card's labelled region. Not rendered by `PlanActivityCard`. */
  readonly section?: string
  readonly sectionLabel?: string
  /**
   * `ActivityChecklist`'s own wrapper. Distinct from `section` because the
   * subagent card renders the checklist INSIDE a labelled region, and one key
   * for both landed a consumer class on a nested pair.
   */
  readonly checklist?: string
  readonly list?: string
  readonly item?: string
  readonly itemGlyph?: string
  readonly itemLabel?: string
  readonly itemStatus?: string
  readonly overflow?: string
  readonly error?: string
}

export interface DawnTodoRowProps {
  readonly content: string
  readonly status: "pending" | "in_progress" | "completed"
  readonly glyph: string
  readonly label: string
}

export interface DawnToolRowProps {
  readonly name: string
  readonly status: "running" | "completed" | "incomplete"
  readonly glyph: string
  readonly label: string
}

/** Leaf components a consumer may replace. */
export interface DawnActivityComponents {
  readonly TodoRow?: (props: DawnTodoRowProps) => ReactNode
  readonly ToolRow?: (props: DawnToolRowProps) => ReactNode
}

/** Join a package default with an optional consumer class. */
export function cx(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base
}
