"use client"
import { useAgent } from "@copilotkit/react-core/v2"
import { useEffect, useState } from "react"

type SubagentEvent = { name: string; call_id?: string; subagent?: string; depth?: number }

// Dawn's subagent dispatcher relays child agent activity as CUSTOM
// `dawn.subagent.<type>` events (see @dawn-ai/ag-ui's translate.ts, which maps
// StreamChunks of type "subagent.*" to CUSTOM{name:`dawn.${chunk.type}`,
// value: chunk.data}). This panel subscribes directly to the agent's raw
// event stream (rather than `agent.state`, which only carries plan/report
// snapshots) to surface subagent dispatch/tool-call/completion activity as
// it streams in.
export function SubagentActivity() {
  const { agent } = useAgent()
  const [events, setEvents] = useState<SubagentEvent[]>([])
  useEffect(() => {
    const sub = agent.subscribe({
      onCustomEvent: ({ event }: { event: { name?: string; value?: unknown } }) => {
        if (typeof event.name === "string" && event.name.startsWith("dawn.subagent.")) {
          const v = (event.value ?? {}) as { call_id?: string; subagent?: string; depth?: number }
          setEvents((prev) => [...prev, { name: event.name as string, ...v }])
        }
      },
    })
    return () => sub.unsubscribe()
  }, [agent])
  if (events.length === 0) return null
  return (
    <aside style={{ padding: 16, borderRight: "1px solid #eee", minWidth: 240 }}>
      <h2 style={{ fontSize: 14, textTransform: "uppercase", color: "#666" }}>Subagents</h2>
      <ul style={{ listStyle: "none", padding: 0, fontSize: 13 }}>
        {events.map((e, i) => (
          <li key={i} style={{ padding: "3px 0" }}>
            <code>{e.name.replace("dawn.subagent.", "")}</code>
            {e.subagent ? ` · ${e.subagent}` : ""}
            {e.call_id ? ` (${e.call_id})` : ""}
          </li>
        ))}
      </ul>
    </aside>
  )
}
