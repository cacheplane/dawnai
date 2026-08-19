import type { DawnPlanActivityContent } from "../activities.js"
import { ActivityChecklist } from "./ActivityChecklist.js"

export function PlanActivityCard({ content }: { content: DawnPlanActivityContent }) {
  const completedCount = content.todos.filter((todo) => todo.status === "completed").length
  const hasActiveTodo = content.todos.some((todo) => todo.status === "in_progress")

  return (
    <details
      open={hasActiveTodo}
      style={{
        border: "1px solid #e5e5e5",
        borderRadius: 8,
        padding: "8px 10px",
        margin: "6px 0",
        fontSize: 13,
      }}
    >
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        Plan · {completedCount}/{content.todos.length} complete
      </summary>
      <ActivityChecklist todos={content.todos} limit={8} />
    </details>
  )
}
