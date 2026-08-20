import type { DawnPlanActivityContent } from "../activities.js"
import { cx, type DawnActivityClassNames, type DawnActivityComponents } from "./parts.js"

const statusPresentation = {
  pending: { glyph: "○", label: "pending" },
  in_progress: { glyph: "◐", label: "in progress" },
  completed: { glyph: "✓", label: "completed" },
} as const

export function ActivityChecklist({
  todos,
  limit = 8,
  classNames,
  components,
}: {
  todos: DawnPlanActivityContent["todos"]
  limit?: number
  classNames?: DawnActivityClassNames
  components?: DawnActivityComponents
}) {
  const visibleTodos = todos.slice(0, limit)
  const overflow = todos.length - visibleTodos.length
  const TodoRow = components?.TodoRow

  return (
    <div className="dawn-activity__section">
      {/* biome-ignore lint/a11y/noRedundantRoles: Markerless lists need explicit list semantics. */}
      <ol role="list" className={cx("dawn-activity__list", classNames?.list)}>
        {visibleTodos.map((todo, index) => {
          const presentation = statusPresentation[todo.status]
          const itemClass = cx(
            `dawn-activity__item dawn-activity__item--${todo.status}`,
            classNames?.item,
          )
          if (TodoRow) {
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: Activity todos intentionally expose no stable runtime IDs.
                key={`${todo.content}:${index}`}
                className={itemClass}
              >
                <TodoRow
                  content={todo.content}
                  status={todo.status}
                  glyph={presentation.glyph}
                  label={presentation.label}
                />
              </li>
            )
          }
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: Activity todos intentionally expose no stable runtime IDs.
              key={`${todo.content}:${index}`}
              className={itemClass}
            >
              <span
                aria-hidden="true"
                className={cx("dawn-activity__item-glyph", classNames?.itemGlyph)}
              >
                {presentation.glyph}
              </span>
              <span className={cx("dawn-activity__item-label", classNames?.itemLabel)}>
                {todo.content}
              </span>
              <span className={cx("dawn-activity__item-status", classNames?.itemStatus)}>
                {presentation.label}
              </span>
            </li>
          )
        })}
      </ol>
      {overflow > 0 ? (
        <div className={cx("dawn-activity__overflow", classNames?.overflow)}>+{overflow} more</div>
      ) : null}
    </div>
  )
}
