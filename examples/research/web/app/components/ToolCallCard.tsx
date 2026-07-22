"use client"
import { useRenderTool } from "@copilotkit/react-core/v2"

// Notes (verified against installed @copilotkit/react-core@1.62.3 types —
// examples/research/web/node_modules/@copilotkit/react-core/dist/copilotkit-Bp6BD8xe.d.mts):
//
// - The registration hook is `useRenderTool` (NOT `useRenderToolCall` — that
//   one takes no args and returns a `({toolCall, toolMessage}) => ReactElement`
//   render *function* used internally by CopilotKit's own message view; it is
//   not a registration API). `useRenderTool` is called under `<CopilotKit>`.
// - Wildcard registration: pass `{ name: "*", render, agentId? }` — the "*"
//   overload is documented as "used as a fallback when no exact name-matched
//   renderer is registered for a tool call" (src/v2/hooks/use-render-tool.d.ts).
//   `WildcardToolCallRender`/`defineToolCallRenderer` are the analogous
//   *prop*-based API (for `<CopilotKit renderToolCalls={[...]}>`), not needed
//   here since the hook form matches the rest of this app's components.
// - Render prop field names for `useRenderTool`'s wildcard overload are
//   `{ name, toolCallId, parameters, status, result }` — note the args field
//   is called `parameters` here (not `args`; `args` is only the field name on
//   the sibling `ReactToolCallRenderer`/`defineToolCallRenderer` types used by
//   the prop-based API).
// - `status` is the string union `"inProgress" | "executing" | "complete"`
//   (plain string literals) for `useRenderTool` — NOT the `ToolCallStatus`
//   enum (`InProgress`/`Executing`/`Complete`), which belongs to the
//   prop-based `ReactToolCallRenderer<T>` render props instead.
// - `result` is `string | undefined`, populated only once `status === "complete"`.
//
// With no agentId, this binds to CopilotKit's default agent id ("default"),
// which the runtime route registers as our Dawn /research agent — same as
// MemoryCandidates.tsx.
/**
 * Dawn delivers tool args as a JSON *string* under `input` (that's how the
 * agent-adapter serializes them), so `parameters` arrives as
 * `{ input: '{"path":"corpus/x.md"}' }`. Unwrap it so the card can show the
 * real argument instead of double-encoded JSON.
 */
function parseArgs(parameters: unknown): Record<string, unknown> {
  const p = (parameters ?? {}) as Record<string, unknown>
  if (typeof p.input === "string") {
    try {
      const inner = JSON.parse(p.input)
      if (inner && typeof inner === "object") return inner as Record<string, unknown>
    } catch {
      // Not JSON — fall through and show the raw string.
    }
  }
  return p
}

/**
 * Tool results arrive as a serialized LangChain `ToolMessage`
 * (`{ lc, type, id: [...], kwargs: { content } }`). Pull out the content so the
 * card shows the actual output rather than LangChain internals.
 */
function parseResult(result: string | undefined): string | undefined {
  if (!result) return undefined
  try {
    const parsed = JSON.parse(result) as { kwargs?: { content?: unknown } }
    const content = parsed?.kwargs?.content
    if (typeof content === "string") return content
    if (content != null) return JSON.stringify(content, null, 2)
  } catch {
    // Not JSON — show it as-is.
  }
  return result
}

function summarizeArgs(name: string, parameters: unknown): string {
  const p = parseArgs(parameters)
  switch (name) {
    case "searchCorpus":
      return typeof p.query === "string" ? p.query : JSON.stringify(p)
    case "readDoc":
      return typeof p.path === "string" ? p.path : JSON.stringify(p)
    case "runBash":
      return typeof p.command === "string" ? p.command : JSON.stringify(p)
    case "task":
      return typeof p.subagent === "string" ? `→ ${p.subagent}` : JSON.stringify(p)
    default:
      return JSON.stringify(p)
  }
}

export function ToolCallCard() {
  useRenderTool(
    {
      name: "*",
      render: ({ name, status, parameters, result }) => (
        <div
          style={{
            border: "1px solid #e5e5e5",
            borderRadius: 8,
            padding: "8px 10px",
            margin: "6px 0",
            fontSize: 13,
          }}
        >
          <span
            style={{
              display: "inline-block",
              fontWeight: 600,
              background: "#f2f2f2",
              borderRadius: 4,
              padding: "1px 6px",
            }}
          >
            {name}
          </span>
          <span style={{ color: "#888", marginLeft: 6 }}>
            {status === "complete" ? "done" : status === "executing" ? "running…" : "preparing…"}
          </span>
          <div style={{ color: "#555", marginTop: 4, wordBreak: "break-word" }}>
            {summarizeArgs(name, parameters)}
          </div>
          {status === "complete" &&
            (() => {
              const content = parseResult(result)
              if (!content) return null
              return (
                <pre
                  style={{
                    margin: "6px 0 0",
                    whiteSpace: "pre-wrap",
                    color: "#444",
                    maxHeight: 120,
                    overflow: "auto",
                  }}
                >
                  {content.slice(0, 400)}
                </pre>
              )
            })()}
        </div>
      ),
    },
    [],
  )
  return null
}
