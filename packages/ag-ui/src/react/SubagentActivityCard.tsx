import type { DawnSubagentActivityContent } from "../activities.js"
import { ActivityChecklist } from "./ActivityChecklist.js"

const toolStatusPresentation = {
  running: { glyph: "◐", label: "running" },
  completed: { glyph: "✓", label: "completed" },
  incomplete: { glyph: "!", label: "incomplete" },
} as const

export function SubagentActivityCard({ content }: { content: DawnSubagentActivityContent }) {
  return (
    <details
      open={content.status === "running"}
      style={{
        border: "1px solid #e5e5e5",
        borderRadius: 8,
        padding: "8px 10px",
        margin: "6px 0",
        fontSize: 13,
      }}
    >
      <summary style={{ cursor: "pointer" }}>
        <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>
          {content.name}
        </span>
        <span style={{ color: "#666" }}> · {content.status}</span>
        <span style={{ color: "#666" }}> · {content.totalToolCount} tools</span>
        {content.depth > 1 ? (
          <span
            style={{
              background: "#f2f2f2",
              borderRadius: 4,
              fontSize: 11,
              marginLeft: 6,
              padding: "1px 5px",
            }}
          >
            nested
          </span>
        ) : null}
      </summary>

      {content.todos !== undefined ? (
        <section aria-label="Subagent plan" style={{ marginTop: 8 }}>
          <div style={{ color: "#666", fontSize: 11, fontWeight: 600 }}>Plan</div>
          <ActivityChecklist todos={content.todos} limit={8} />
        </section>
      ) : null}

      {content.tools.length > 0 ? (
        <section aria-label="Subagent tools" style={{ marginTop: 8 }}>
          <div style={{ color: "#666", fontSize: 11, fontWeight: 600 }}>Tools</div>
          {/* biome-ignore lint/a11y/noRedundantRoles: Markerless lists need explicit list semantics. */}
          <ul role="list" style={{ listStyle: "none", margin: "4px 0 0", padding: 0 }}>
            {content.tools.map((tool, index) => {
              const presentation = toolStatusPresentation[tool.status]
              return (
                <li
                  key={
                    // biome-ignore lint/suspicious/noArrayIndexKey: Activity tools intentionally expose no stable runtime IDs.
                    `${tool.name}:${index}`
                  }
                  style={{ display: "flex", gap: 8, alignItems: "baseline", marginTop: 4 }}
                >
                  <span aria-hidden="true">{presentation.glyph}</span>
                  <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                    {tool.name}
                  </span>
                  <span style={{ color: "#666", fontSize: 11 }}>{presentation.label}</span>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {content.status === "failed" ? (
        <div role="alert" style={{ color: "#9f1239", marginTop: 8, overflowWrap: "anywhere" }}>
          {content.error}
        </div>
      ) : null}
    </details>
  )
}
