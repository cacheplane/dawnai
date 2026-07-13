"use client"
import { UseAgentUpdate, useAgent } from "@copilotkit/react-core/v2"

type Todo = { content?: string; status?: string }
type ResearchState = { todos?: Todo[] }

// NOTE: v2 has no `useCoAgent` (that's a v1-only hook). The v2 equivalent is
// `useAgent`, which returns the live `AbstractAgent` instance; shared/coagent
// state lives on `agent.state`. With no agentId, it binds to CopilotKit's
// default agent id ("default") — which the runtime route registers as our
// Dawn /research agent.
export function PlanPanel() {
  const { agent } = useAgent({ updates: [UseAgentUpdate.OnStateChanged] })
  const state = (agent.state ?? {}) as ResearchState
  const todos = state.todos ?? []
  if (todos.length === 0) return null
  return (
    <aside style={{ padding: 16, borderRight: "1px solid #eee", minWidth: 240 }}>
      <h2 style={{ fontSize: 14, textTransform: "uppercase", color: "#666" }}>Plan</h2>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {todos.map((t, i) => (
          <li key={i} style={{ padding: "4px 0" }}>
            <span>{t.status === "completed" ? "☑" : "☐"}</span> {t.content ?? ""}
          </li>
        ))}
      </ul>
    </aside>
  )
}
