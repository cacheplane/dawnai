import type { DawnPlanActivityContent } from "@dawn-ai/ag-ui"

const statusPresentation = {
  pending: { glyph: "○", label: "pending" },
  in_progress: { glyph: "◐", label: "in progress" },
  completed: { glyph: "✓", label: "completed" },
} as const

export function ActivityChecklist({
  todos,
  limit = 8,
}: {
  todos: DawnPlanActivityContent["todos"]
  limit?: number
}) {
  const visibleTodos = todos.slice(0, limit)
  const overflow = todos.length - visibleTodos.length

  return (
    <div style={{ marginTop: 8 }}>
      {/* biome-ignore lint/a11y/noRedundantRoles: Markerless lists need explicit list semantics. */}
      <ol role="list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {visibleTodos.map((todo, index) => {
          const presentation = statusPresentation[todo.status]
          return (
            <li
              key={
                // biome-ignore lint/suspicious/noArrayIndexKey: Activity todos intentionally expose no stable runtime IDs.
                `${todo.content}:${index}`
              }
              style={{ display: "flex", gap: 8, alignItems: "baseline", marginTop: 4 }}
            >
              <span aria-hidden="true">{presentation.glyph}</span>
              <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{todo.content}</span>
              <span style={{ color: "#666", fontSize: 11 }}>{presentation.label}</span>
            </li>
          )
        })}
      </ol>
      {overflow > 0 ? (
        <div style={{ color: "#666", fontSize: 12, marginTop: 5 }}>+{overflow} more</div>
      ) : null}
    </div>
  )
}
