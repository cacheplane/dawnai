import { highlightLight } from "../../../lib/shiki/highlight-light"
import { CodeFrame } from "../ui/CodeFrame"
import { FeatureBlock } from "./FeatureBlock"

const TYPES_CODE = `// state.ts — single source of truth
export default z.object({
  tenant: z.string(),
  question: z.string(),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })),
})

// inside a tool handler — state is inferred end-to-end
async function summarize({ state }: ToolContext) {
  // state.history is { role: "user" | "assistant"; content: string }[]
  return state.history.map((m) => \`\${m.role}: \${m.content}\`).join("\\n")
}`

export async function FeatureTypes() {
  const html = await highlightLight(TYPES_CODE, "typescript")
  return (
    <FeatureBlock
      eyebrow="Types"
      heading="Types that follow the data."
      paragraph="Define your agent state in one Zod schema. Dawn generates types that flow into route handlers, tool handlers, and your client code — so the editor catches an out-of-shape state mutation the moment you type it, not at 3am when the graph throws on a missing field."
      bullets={[
        "Single Zod schema → typed agent state everywhere",
        "Tool input/output types inferred and propagated",
        "Generated types refresh on save (HMR)",
        "Works with your existing tsconfig.json",
      ]}
      link={{ href: "/docs/state", label: "See type generation docs" }}
      visual={
        <CodeFrame label="state.ts → tools/*.ts">
          <div
            className="px-4 py-4 text-sm font-mono leading-[22px] overflow-x-auto"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </CodeFrame>
      }
    />
  )
}
