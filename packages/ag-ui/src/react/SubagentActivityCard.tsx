import { ActivityChecklist } from "./ActivityChecklist.js"
import { cx, type DawnActivityClassNames, type DawnActivityComponents } from "./parts.js"
import type { SubagentActivityContentOutput } from "./schemas.js"

const toolStatusPresentation = {
  running: { glyph: "◐", label: "running" },
  completed: { glyph: "✓", label: "completed" },
  incomplete: { glyph: "!", label: "incomplete" },
} as const

export function SubagentActivityCard({
  content,
  classNames,
  components,
}: {
  content: SubagentActivityContentOutput
  classNames?: DawnActivityClassNames
  components?: DawnActivityComponents
}) {
  const ToolRow = components?.ToolRow

  return (
    <details open={content.status === "running"} className={cx("dawn-activity", classNames?.root)}>
      <summary className={cx("dawn-activity__header", classNames?.header)}>
        <span className={cx("dawn-activity__title", classNames?.title)}>{content.name}</span>
        <span className={cx("dawn-activity__meta", classNames?.meta)}> · {content.status}</span>
        <span className={cx("dawn-activity__meta", classNames?.meta)}>
          {" "}
          · {content.totalToolCount} tools
        </span>
        {content.depth > 1 ? (
          <span className={cx("dawn-activity__badge", classNames?.badge)}>nested</span>
        ) : null}
      </summary>

      {content.todos !== undefined ? (
        <section
          aria-label="Subagent plan"
          className={cx("dawn-activity__section", classNames?.section)}
        >
          <div className={cx("dawn-activity__section-label", classNames?.sectionLabel)}>Plan</div>
          <ActivityChecklist
            todos={content.todos}
            limit={8}
            {...(classNames ? { classNames } : {})}
            {...(components ? { components } : {})}
          />
        </section>
      ) : null}

      {content.tools.length > 0 ? (
        <section
          aria-label="Subagent tools"
          className={cx("dawn-activity__section", classNames?.section)}
        >
          <div className={cx("dawn-activity__section-label", classNames?.sectionLabel)}>Tools</div>
          {/* biome-ignore lint/a11y/noRedundantRoles: Markerless lists need explicit list semantics. */}
          <ul role="list" className={cx("dawn-activity__list", classNames?.list)}>
            {content.tools.map((tool, index) => {
              const presentation = toolStatusPresentation[tool.status]
              const itemClass = cx(
                `dawn-activity__item dawn-activity__item--${tool.status}`,
                classNames?.item,
              )
              if (ToolRow) {
                return (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: Activity tools intentionally expose no stable runtime IDs.
                    key={`${tool.name}:${index}`}
                    className={itemClass}
                  >
                    <ToolRow
                      name={tool.name}
                      status={tool.status}
                      glyph={presentation.glyph}
                      label={presentation.label}
                    />
                  </li>
                )
              }
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: Activity tools intentionally expose no stable runtime IDs.
                  key={`${tool.name}:${index}`}
                  className={itemClass}
                >
                  <span
                    aria-hidden="true"
                    className={cx("dawn-activity__item-glyph", classNames?.itemGlyph)}
                  >
                    {presentation.glyph}
                  </span>
                  <span className={cx("dawn-activity__item-label", classNames?.itemLabel)}>
                    {tool.name}
                  </span>
                  <span className={cx("dawn-activity__item-status", classNames?.itemStatus)}>
                    {presentation.label}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {content.status === "failed" ? (
        <div role="alert" className={cx("dawn-activity__error", classNames?.error)}>
          {content.error}
        </div>
      ) : null}
    </details>
  )
}
