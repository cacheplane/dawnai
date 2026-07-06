"use client"

import { useState } from "react"

function newThreadId(): string {
  return `t-${Math.random().toString(36).slice(2, 10)}`
}

type RouteId = "chat" | "coordinator"

type PendingInterrupt = {
  interruptId: string
  type: string
  kind: "command" | "path" | "tool"
  detail: {
    command?: string
    operation?: string
    path?: string
    toolName?: string
    argsPreview?: string
    suggestedPattern: string
  }
}

/**
 * Reads SSE lines from a ReadableStreamDefaultReader and pipes them into
 * setEvents. Also detects interrupt events and calls setPendingInterrupt.
 * Returns when the stream is exhausted.
 */
async function readSseInto(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  setEvents: React.Dispatch<React.SetStateAction<string[]>>,
  setPendingInterrupt: React.Dispatch<React.SetStateAction<PendingInterrupt | null>>,
): Promise<void> {
  const decoder = new TextDecoder()
  let buf = ""
  let nextLineIsInterruptData = false

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      if (line === "event: interrupt") {
        nextLineIsInterruptData = true
        setEvents((e) => [...e, line])
        continue
      }
      if (nextLineIsInterruptData && line.startsWith("data: ")) {
        try {
          const payload = JSON.parse(line.slice("data: ".length)) as PendingInterrupt
          setPendingInterrupt({
            interruptId: payload.interruptId,
            type: payload.type,
            kind: payload.kind,
            detail: payload.detail,
          })
        } catch {
          /* ignore parse errors */
        }
        nextLineIsInterruptData = false
      }
      setEvents((e) => [...e, line])
    }
  }
  if (buf.trim()) setEvents((e) => [...e, buf])
}

export default function Page() {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [input, setInput] = useState("")
  const [events, setEvents] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [route, setRoute] = useState<RouteId>("chat")
  const [pendingInterrupt, setPendingInterrupt] = useState<PendingInterrupt | null>(null)

  async function resolveInterrupt(decision: "once" | "always" | "deny") {
    if (!pendingInterrupt || !threadId) return
    setPendingInterrupt(null)
    setBusy(true)

    const res = await fetch("/api/permission-resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        interruptId: pendingInterrupt.interruptId,
        decision,
      }),
    })

    if (!res.body) {
      setEvents((e) => [...e, `✖ resume error: no response body (status ${res.status})`])
      setBusy(false)
      return
    }

    const reader = res.body.getReader()
    await readSseInto(reader, setEvents, setPendingInterrupt)
    setEvents((e) => [...e, "■ done"])
    setBusy(false)
  }

  function switchRoute(next: RouteId) {
    if (next === route) return
    setRoute(next)
    // New conversation when switching routes — each route has its own thread.
    setThreadId(null)
    setEvents([])
  }

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
      body: JSON.stringify({ threadId: tid, message: msg, route }),
    })

    if (!res.body) {
      setEvents((e) => [...e, `✖ error: no response body`])
      setBusy(false)
      return
    }

    const reader = res.body.getReader()
    await readSseInto(reader, setEvents, setPendingInterrupt)
    setEvents((e) => [...e, "■ done"])
    setBusy(false)
  }

  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Dawn chat — smoke test</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        Disposable. Streams raw SSE events from <code>/api/chat</code>. See <code>README.md</code> for context.
      </p>
      <div
        role="radiogroup"
        aria-label="Route"
        style={{ display: "flex", gap: "0.5rem", margin: "0.5rem 0", fontSize: "0.9rem" }}
      >
        <label style={{ cursor: "pointer" }}>
          <input
            type="radio"
            name="route"
            value="chat"
            checked={route === "chat"}
            onChange={() => switchRoute("chat")}
            disabled={busy}
          />{" "}
          /chat <span style={{ color: "#888" }}>(planning + skills + workspace tools)</span>
        </label>
        <label style={{ cursor: "pointer" }}>
          <input
            type="radio"
            name="route"
            value="coordinator"
            checked={route === "coordinator"}
            onChange={() => switchRoute("coordinator")}
            disabled={busy}
          />{" "}
          /coordinator <span style={{ color: "#888" }}>(dispatches to research + summarizer)</span>
        </label>
      </div>
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
      {pendingInterrupt && (
        <div
          style={{
            border: "2px solid #f0ad4e",
            background: "#fdf7e7",
            padding: "1rem",
            marginTop: "0.5rem",
            borderRadius: "4px",
          }}
        >
          <strong>⚠️ Permission request</strong>
          <p style={{ margin: "0.5rem 0" }}>
            {pendingInterrupt.kind === "command"
              ? "The agent wants to run command:"
              : pendingInterrupt.kind === "tool"
                ? `The agent wants to call tool ${pendingInterrupt.detail.toolName}:`
                : `The agent wants to ${pendingInterrupt.detail.operation}:`}
          </p>
          <code
            style={{
              display: "block",
              background: "#fff",
              padding: "0.5rem",
              border: "1px solid #ddd",
              fontFamily: "monospace",
              fontSize: 13,
            }}
          >
            {pendingInterrupt.kind === "command"
              ? pendingInterrupt.detail.command
              : pendingInterrupt.kind === "tool"
                ? pendingInterrupt.detail.argsPreview
                : pendingInterrupt.detail.path}
          </code>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <button onClick={() => resolveInterrupt("once")} style={{ padding: "0.5rem 1rem" }}>
              Allow once
            </button>
            <button onClick={() => resolveInterrupt("always")} style={{ padding: "0.5rem 1rem" }}>
              Allow always for `{pendingInterrupt.detail.suggestedPattern}`
            </button>
            <button
              onClick={() => resolveInterrupt("deny")}
              style={{ padding: "0.5rem 1rem", background: "#f5c6cb" }}
            >
              Deny
            </button>
          </div>
        </div>
      )}
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
