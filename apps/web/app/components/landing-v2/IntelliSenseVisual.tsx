import { highlightLight } from "../../../lib/shiki/highlight-light"
import { CodeFrame } from "../ui/CodeFrame"

const CODE = `import { z } from "zod"

// state.ts — single source of truth
export default z.object({
  tenant: z.string(),
  question: z.string(),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })),
})

// inside a tool handler — state.history is inferred end-to-end
async function summarize({ state }) {
  return state.history.map((m) => \`\${m.role}: \${m.content}\`).join("\\n")
}`

export async function IntelliSenseVisual() {
  const html = await highlightLight(CODE, "typescript")

  return (
    <div className="relative">
      <CodeFrame label="state.ts → tools/*.ts">
        <div
          className="px-4 py-4 text-sm font-mono leading-[22px] overflow-x-auto"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is sanitized
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </CodeFrame>

      {/* IntelliSense popover — positioned over the .history member access */}
      <div
        className="absolute hidden md:block left-[58%] top-[68%] w-[320px] rounded-lg border border-divider bg-page text-left z-10"
        role="tooltip"
        aria-label="Inferred TypeScript type for state.history"
        style={{
          boxShadow:
            "0 4px 10px rgba(20,17,13,0.06), 0 16px 40px -12px rgba(20,17,13,0.18)",
        }}
      >
        <div className="px-3 py-2 border-b border-divider bg-surface-sunk">
          <p className="text-[11px] font-mono text-ink-dim uppercase tracking-[0.06em]">
            <span className="text-accent-saas">●</span> property
          </p>
          <p className="text-sm font-mono text-ink mt-0.5">
            (property) history
          </p>
        </div>
        <div className="px-3 py-2.5 space-y-2">
          <pre className="text-xs font-mono text-ink leading-[18px] whitespace-pre-wrap">
{`{
  role: "user" | "assistant"
  content: string
}[]`}
          </pre>
          <p className="text-xs text-ink-muted leading-[18px]">
            Inferred from <span className="font-mono text-ink">z.array(z.object(...))</span> in <span className="font-mono text-ink">state.ts</span>.
          </p>
        </div>
      </div>
    </div>
  )
}
