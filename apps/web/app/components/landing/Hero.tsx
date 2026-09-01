import Link from "next/link"
import { highlightLight } from "../../../lib/shiki/highlight-light"
import { demoMedia } from "../../lib/demo-media"
import { CopyCommand } from "../CopyCommand"
import { CopyPromptButton } from "../CopyPromptButton"
import { ClipPlayer } from "../ui/ClipPlayer"
import { CodeFrame } from "../ui/CodeFrame"
import { Eyebrow } from "../ui/Eyebrow"
import { MediaSwitcher } from "./MediaSwitcher"

const ROUTE_CODE = `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "Answer for {tenant}.",
})`

const HERO_PROMPT = `Scaffold a new Dawn app and help me build an agent. Dawn is the TypeScript meta-framework for LangGraph — agents and workflows are file-system routes with shared and route-local tools, generated types, and durable threads. Run \`npm create dawn-ai-app@latest my-agent\` to scaffold, then read https://dawnai.org/AGENTS.md and https://dawnai.org/llms-full.txt for the full framework reference before writing any routes.`

export async function Hero() {
  const codeHtml = await highlightLight(ROUTE_CODE, "typescript")

  return (
    <section id="product-loop" className="relative bg-page border-b border-divider scroll-mt-16">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 pt-20 md:pt-28 pb-16 md:pb-20">
        <div className="grid grid-cols-1 lg:grid-cols-[1.25fr_1fr] gap-12 lg:gap-16 items-center">
          <div className="min-w-0">
            <Eyebrow>TypeScript meta-framework · for LangGraph.js</Eyebrow>
            <h1
              className="font-display font-semibold text-ink mt-4 text-[40px] leading-[44px] md:text-[56px] md:leading-[60px] lg:text-[56px] lg:leading-[60px] xl:text-[80px] xl:leading-[84px] text-balance"
              style={{
                fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
                letterSpacing: "-0.015em",
              }}
            >
              Build LangGraph agents like Next.js apps.
            </h1>
            <p className="mt-6 text-lg text-ink-muted leading-[30px] max-w-[44ch]">
              Dawn adds file-system routing, shared and route-local tools, per-route scoping,
              generated types, and durable threads to your LangGraph.js stack.{" "}
              <strong className="text-ink font-medium">
                Keep the runtime. Drop the boilerplate.
              </strong>
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <CopyCommand command="npm create dawn-ai-app@latest my-agent" />
              <CopyPromptButton
                prompt={HERO_PROMPT}
                label="Copy agent prompt"
                ariaLabel="Copy a prompt to scaffold Dawn with your coding agent"
              />
              <Link
                href="/docs/getting-started"
                className="text-sm font-medium text-ink hover:text-accent-saas transition-colors inline-flex items-center gap-1.5"
              >
                Read the docs <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>

          <div className="w-full min-w-0">
            <MediaSwitcher
              videoLabel="Video"
              codeLabel="Code"
              ariaLabel="Dawn product loop"
              video={
                <figure>
                  <ClipPlayer
                    clip={demoMedia.productLoop}
                    className="border border-divider shadow-sm"
                  />
                  <figcaption className="mt-3 text-sm leading-6 text-ink-muted">
                    {demoMedia.productLoop.caption}{" "}
                    <a
                      href={demoMedia.productLoop.transcript}
                      className="font-medium text-ink underline underline-offset-4"
                    >
                      Read the transcript
                    </a>
                    .
                  </figcaption>
                </figure>
              }
              code={
                <CodeFrame label="src/app/(public)/support/index.ts">
                  <div
                    className="px-4 py-4 text-sm font-mono leading-[22px] overflow-x-auto"
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is server-generated
                    dangerouslySetInnerHTML={{ __html: codeHtml }}
                  />
                </CodeFrame>
              }
            />
          </div>
        </div>
      </div>
    </section>
  )
}
