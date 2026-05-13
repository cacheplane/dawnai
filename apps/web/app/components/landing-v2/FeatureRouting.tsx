import { highlightLight } from "../../../lib/shiki/highlight-light"
import { CodeFrame } from "../ui/CodeFrame"
import { FeatureBlock } from "./FeatureBlock"

const ROUTE_CODE = `// src/app/(public)/support/index.ts
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "openai:gpt-4o-mini",
  systemPrompt: "Answer for {tenant}.",
})

// src/app/(public)/support/state.ts
import { z } from "zod"

export default z.object({
  tenant: z.string(),
  question: z.string(),
})`

export async function FeatureRouting() {
  const html = await highlightLight(ROUTE_CODE, "typescript")
  return (
    <FeatureBlock
      eyebrow="Routing"
      heading="Routes for agents, not just pages."
      paragraph="Every agent in your app is a directory. Drop in an index.ts, a state.ts, and a couple of tool files — Dawn wires it into the graph at build time. No registry, no boilerplate orchestration code, no central switch statement that grows every time you add a capability."
      bullets={[
        "File-system routing the way Next.js does it for pages",
        "Route groups for organizing public vs. internal agents",
        "Nested routes for multi-step workflows",
        "Cold-start safe — routes compile to plain LangGraph at build time",
      ]}
      link={{ href: "/docs/routes", label: "See routing docs" }}
      visual={
        <CodeFrame label="src/app/(public)/support/">
          <div
            className="px-4 py-4 text-sm font-mono leading-[22px] overflow-x-auto"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is server-generated
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </CodeFrame>
      }
    />
  )
}
