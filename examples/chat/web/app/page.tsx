"use client"

import { useState } from "react"

function newThreadId(): string {
  return `t-${Math.random().toString(36).slice(2, 10)}`
}

export default function Page() {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [input, setInput] = useState("")
  const [events, setEvents] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  async function send() {
    const tid = threadId ?? newThreadId()
    if (!threadId) setThreadId(tid)

    setBusy(true)
    setEvents((e) => [...e, `▶ user: ${input}`])
    const msg = input
    setInput("")

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: tid, message: msg }),
    })

    if (!res.body) {
      setEvents((e) => [...e, `✖ error: no response body`])
      setBusy(false)
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (line.trim()) setEvents((e) => [...e, line])
      }
    }
    if (buf.trim()) setEvents((e) => [...e, buf])
    setEvents((e) => [...e, "■ done"])
    setBusy(false)
  }

  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Dawn chat — smoke test</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        Disposable. Streams raw SSE events from <code>/api/chat</code>. See <code>README.md</code> for context.
      </p>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={4}
        placeholder="Ask the agent to list the workspace, write a file, run a command…"
        style={{ width: "100%", boxSizing: "border-box", fontFamily: "inherit", padding: "0.5rem" }}
        disabled={busy}
      />
      <button
        onClick={send}
        disabled={busy || input.trim().length === 0}
        style={{ marginTop: "0.5rem", padding: "0.5rem 1rem" }}
      >
        {busy ? "Streaming…" : "Send"}
      </button>
      <pre
        data-testid="event-log"
        style={{
          marginTop: "1rem",
          padding: "0.75rem",
          background: "#111",
          color: "#eee",
          minHeight: 200,
          fontSize: 12,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        {events.length === 0 ? "(no events yet)" : events.join("\n")}
      </pre>
    </main>
  )
}
