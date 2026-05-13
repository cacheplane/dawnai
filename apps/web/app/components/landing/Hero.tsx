import Link from "next/link"
import { highlightLight } from "../../../lib/shiki/highlight-light"
import { CopyCommand } from "../CopyCommand"
import { CodeFrame } from "../ui/CodeFrame"
import { Eyebrow } from "../ui/Eyebrow"

const ROUTE_CODE = `import { agent } from "@dawn-ai/sdk"
import { z } from "zod"

export const state = z.object({
  tenant: z.string(),
  question: z.string(),
})

export default agent({
  model: "openai:gpt-4o-mini",
  systemPrompt: "Answer for {tenant}.",
})`

export async function Hero() {
  const codeHtml = await highlightLight(ROUTE_CODE, "typescript")

  return (
    <section className="relative bg-page border-b border-divider">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 pt-20 md:pt-28 pb-20 md:pb-28">
        <div className="grid grid-cols-1 lg:grid-cols-[1.25fr_1fr] gap-12 lg:gap-16 items-center">
          <div className="min-w-0">
            <Eyebrow>TypeScript meta-framework · for LangGraph.js</Eyebrow>
            <h1
              className="font-display font-semibold text-ink mt-4 text-[40px] leading-[44px] md:text-[56px] md:leading-[60px] lg:text-[64px] lg:leading-[68px] text-balance"
              style={{
                fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
                letterSpacing: "-0.015em",
              }}
            >
              Build LangGraph agents like Next.js apps.
            </h1>
            <p className="mt-6 text-lg text-ink-muted leading-[30px] max-w-[44ch]">
              Dawn adds file-system routing, route-local tools, generated types, and HMR to your
              existing LangGraph.js stack.{" "}
              <strong className="text-ink font-medium">
                Keep the runtime. Drop the boilerplate.
              </strong>
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <CopyCommand command="pnpm create dawn-ai-app my-agent" />
              <Link
                href="/docs/getting-started"
                className="text-sm font-medium text-ink hover:text-accent-saas transition-colors inline-flex items-center gap-1.5"
              >
                Read the docs <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>

          <div className="w-full min-w-0 overflow-hidden">
            <CodeFrame label="src/app/(public)/support/index.ts">
              <div
                className="px-4 py-4 text-sm font-mono leading-[22px] overflow-x-auto"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is server-generated
                dangerouslySetInnerHTML={{ __html: codeHtml }}
              />
            </CodeFrame>
          </div>
        </div>
      </div>
    </section>
  )
}
