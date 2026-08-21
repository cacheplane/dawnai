/**
 * Rungs 2 and 3 of the customization ladder.
 *
 * `classNames` entries are APPENDED to the package defaults, never substituted,
 * so a consumer can layer utility classes without fighting specificity. Slot
 * components replace a leaf's rendering while the card keeps ownership of
 * validation, ordering, and the bounded-content rules.
 */
import type { ReactNode } from "react"

/** Structural parts every activity surface can expose. */
export interface DawnActivityClassNames {
  readonly root?: string
  readonly header?: string
  readonly title?: string
  readonly meta?: string
  readonly badge?: string
  readonly section?: string
  readonly sectionLabel?: string
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
