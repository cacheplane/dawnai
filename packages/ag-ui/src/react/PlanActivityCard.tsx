import type { DawnPlanActivityContent } from "../activities.js"
import { ActivityChecklist } from "./ActivityChecklist.js"
import { cx, type DawnActivityClassNames, type DawnActivityComponents } from "./parts.js"

export function PlanActivityCard({
  content,
  classNames,
  components,
}: {
  content: DawnPlanActivityContent
  classNames?: DawnActivityClassNames
  components?: DawnActivityComponents
}) {
  const completedCount = content.todos.filter((todo) => todo.status === "completed").length
  const hasActiveTodo = content.todos.some((todo) => todo.status === "in_progress")

  return (
    <details open={hasActiveTodo} className={cx("dawn-activity", classNames?.root)}>
      <summary className={cx("dawn-activity__header", classNames?.header)}>
        {/* `aria-hidden`: `<details>` already announces its own expanded state, and
            the glyph would otherwise land in the summary's accessible name. */}
        <span aria-hidden="true" className={cx("dawn-activity__marker", classNames?.marker)}>
          ▸
        </span>
        <span className={cx("dawn-activity__title", classNames?.title)}>Plan</span>
        <span className={cx("dawn-activity__meta", classNames?.meta)}>
          {" "}
          · {completedCount}/{content.todos.length} complete
        </span>
      </summary>
      <ActivityChecklist
        todos={content.todos}
        limit={8}
        {...(classNames ? { classNames } : {})}
        {...(components ? { components } : {})}
      />
    </details>
  )
}
