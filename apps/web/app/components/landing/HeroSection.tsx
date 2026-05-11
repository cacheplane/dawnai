import Link from "next/link"
import { getPrompt } from "../../../content/prompts"
import { highlight } from "../../../lib/shiki/highlight"
import { CopyCommand } from "../CopyCommand"
import { CopyPromptButton } from "../CopyPromptButton"
import { HeroCodeShowcase } from "./HeroCodeShowcase"
import { HeroParallaxLayers } from "./HeroEarthParallax"

const scaffoldPrompt = getPrompt("scaffold")

const STATE_CODE = `import { z } from "zod"

export default z.object({
  tenant: z.string(),
  question: z.string(),
})`

const INDEX_CODE = `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "openai:gpt-4o-mini",
  systemPrompt: "Answer for {tenant}.",
})`

export async function HeroSection() {
  const [stateHtml, indexHtml] = await Promise.all([
    highlight(STATE_CODE, "typescript"),
    highlight(INDEX_CODE, "typescript"),
  ])

  return (
    <section
      className="relative pt-24 pb-56 text-center isolate"
      style={{
        background:
          "linear-gradient(to bottom, var(--color-bg-primary) 0%, var(--color-bg-primary) 55%, #020617 100%)",
      }}
    >
      {/* Starfield (slow drift) + earth (medium lift) + sun bloom (accelerated).
          Sun bloom extends below the hero and bleeds into StatsStrip's transparent top. */}
      <HeroParallaxLayers />

      <h1
        className="relative font-display text-5xl md:text-7xl font-semibold text-text-primary tracking-tight leading-[1.05]"
        style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0" }}
      >
        Build LangGraph agents
        <br />
        like Next.js apps.
      </h1>

      <p className="relative text-text-secondary mt-5 text-lg max-w-2xl mx-auto leading-relaxed">
        Dawn adds file-system routing, route-local tools, generated types, and HMR to your existing
        LangGraph.js stack.{" "}
        <strong className="text-text-primary font-medium">
          Keep the runtime. Drop the boilerplate.
        </strong>
      </p>

      <div className="relative mt-8 flex gap-3 justify-center">
        <CopyPromptButton prompt={scaffoldPrompt.body} label="Copy prompt" variant="hero" />
        <Link
          href="/docs/getting-started"
          className="px-6 py-2.5 border border-border text-text-secondary rounded-md text-sm hover:border-text-muted hover:text-text-primary transition-colors"
        >
          Read the docs
        </Link>
      </div>

      <div className="relative mt-6">
        <CopyCommand command="pnpm create dawn-ai-app my-agent" />
      </div>

      <HeroCodeShowcase
        files={[
          {
            label: "src/app/(public)/support/state.ts",
            html: stateHtml,
            raw: STATE_CODE,
          },
          {
            label: "src/app/(public)/support/index.ts",
            html: indexHtml,
            raw: INDEX_CODE,
          },
        ]}
        defaultIndex={1}
      />
    </section>
  )
}
