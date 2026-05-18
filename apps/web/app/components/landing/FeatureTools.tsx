import { highlightLight } from "../../../lib/shiki/highlight-light"
import { CodeFrame } from "../ui/CodeFrame"
import { FeatureBlock } from "./FeatureBlock"

const TOOL_CODE = `// src/app/(public)/support/tools/lookup-order.ts
export const description = "Fetch order details by order ID."

export default async (input: { readonly orderId: string }) => {
  return await db.orders.find({ orderId: input.orderId })
}`

export async function FeatureTools() {
  const html = await highlightLight(TOOL_CODE, "typescript")
  return (
    <FeatureBlock
      eyebrow="Tools"
      heading="Tools that live next to the route that uses them."
      paragraph="Tools live as files inside the route directory that consumes them. Their argument types are inferred from TypeScript source — no string-typed JSON blobs, no manual type wiring. Co-located tools mean each agent is a self-contained unit you can move, copy, or delete without hunting through a central registry."
      bullets={[
        "Route-local tools — discovered automatically",
        "TypeScript-inferred argument types with full IntelliSense",
        "Tool handlers are plain typed functions",
        "Easy to test in isolation",
      ]}
      link={{ href: "/docs/tools", label: "See tools docs" }}
      imageSide="left"
      visual={
        <CodeFrame label="tools/lookup-order.ts">
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
