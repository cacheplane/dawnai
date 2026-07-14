"use client"
import { useAgent } from "@copilotkit/react-core/v2"
import { useCallback, useEffect, useState } from "react"

type Candidate = {
  id: string
  content: string
  data: unknown
  confidence: number
  tags: string[]
  status: string
  namespace: string
  createdAt: string
}

// Slice C: lists memory candidates written by the research agent's `remember()`
// tool (status:"candidate") and lets a human approve/reject them, replacing the
// CLI `dawn memory approve` flow for this demo. Backed by the Slice B dev-server
// endpoints (GET/POST /memory/candidates...) via the same-origin proxy at
// app/api/memory/[...path]/route.ts.
//
// Refetch trigger: `agent.subscribe({ onRunFinishedEvent })` — verified against
// the installed @ag-ui/client@0.0.57 types (dist/index.d.ts), which define
// `AgentSubscriber.onRunFinishedEvent` distinctly from the generic `onEvent`.
// A finished run is when `remember()` calls (if any) have already landed in
// the store, so this is the right moment to refetch.
export function MemoryCandidates() {
  const { agent } = useAgent()
  const [candidates, setCandidates] = useState<Candidate[]>([])

  const refetch = useCallback(() => {
    fetch("/api/memory/candidates")
      .then((r) => r.json())
      .then((d) => setCandidates((d.candidates ?? []) as Candidate[]))
      .catch(() => setCandidates([]))
  }, [])

  useEffect(() => {
    refetch()
  }, [refetch])

  useEffect(() => {
    const sub = agent.subscribe({
      onRunFinishedEvent: () => {
        refetch()
      },
    })
    return () => sub.unsubscribe()
  }, [agent, refetch])

  const approve = (id: string) => {
    fetch(`/api/memory/candidates/${id}/approve`, { method: "POST" })
      .catch(() => undefined)
      .finally(refetch)
  }
  const reject = (id: string) => {
    fetch(`/api/memory/candidates/${id}/reject`, { method: "POST" })
      .catch(() => undefined)
      .finally(refetch)
  }

  if (candidates.length === 0) return null
  return (
    <aside style={{ padding: 16, borderRight: "1px solid #eee", minWidth: 240 }}>
      <h2 style={{ fontSize: 14, textTransform: "uppercase", color: "#666" }}>Memory candidates</h2>
      <ul style={{ listStyle: "none", padding: 0, fontSize: 13 }}>
        {candidates.map((c) => (
          <li key={c.id} style={{ padding: "6px 0", borderBottom: "1px solid #f2f2f2" }}>
            <p style={{ margin: 0 }}>{c.content}</p>
            <p style={{ margin: "2px 0", fontSize: 11, color: "#888" }}>
              {c.tags.join(", ")}
              {c.tags.length > 0 ? " · " : ""}
              confidence {c.confidence}
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button type="button" onClick={() => approve(c.id)}>
                Approve
              </button>
              <button type="button" onClick={() => reject(c.id)}>
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  )
}
