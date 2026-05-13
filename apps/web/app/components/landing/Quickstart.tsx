import Link from "next/link"
import { CopyCommand } from "../CopyCommand"
import { Card } from "../ui/Card"
import { Eyebrow } from "../ui/Eyebrow"

interface Step {
  readonly n: number
  readonly title: string
  readonly body: string
  readonly extra?: React.ReactNode
}

const STEPS: readonly Step[] = [
  {
    n: 1,
    title: "Scaffold",
    body: "One command. You'll get a working Dawn app with a typed example route and the dev server running.",
  },
  {
    n: 2,
    title: "Run an example",
    body: "Open the support route, fire a request, and watch the graph state flow through the tool handler in your terminal.",
  },
  {
    n: 3,
    title: "Port a graph",
    body: "Bring one of your existing LangGraph.js graphs and rewrite it as a Dawn route — keep the logic, drop the orchestration boilerplate.",
  },
]

export function Quickstart() {
  return (
    <section className="bg-surface-sunk border-b border-divider">
      <div className="max-w-[1100px] mx-auto px-6 md:px-8 py-20 md:py-28">
        <Eyebrow>Try it</Eyebrow>
        <h2
          className="font-display font-semibold text-ink mt-3 text-[32px] leading-[38px] md:text-[44px] md:leading-[50px] text-balance max-w-[24ch]"
          style={{
            fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
            letterSpacing: "-0.01em",
          }}
        >
          Three steps to know if Dawn fits.
        </h2>

        <div className="mt-12 grid md:grid-cols-3 gap-5">
          {STEPS.map((step) => (
            <Card key={step.n} tone="page" className="p-6 md:p-7 flex flex-col">
              <span className="font-display text-3xl font-semibold text-accent-saas leading-none">
                {String(step.n).padStart(2, "0")}
              </span>
              <h3 className="mt-4 font-display text-xl font-semibold text-ink leading-tight">
                {step.title}
              </h3>
              <p className="mt-3 text-sm text-ink-muted leading-[22px] flex-1">{step.body}</p>
              {step.n === 1 ? (
                <div className="mt-5">
                  <CopyCommand command="pnpm create dawn-ai-app my-agent" />
                </div>
              ) : null}
            </Card>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap gap-6 text-sm">
          <Link
            href="/docs/getting-started"
            className="font-medium text-accent-saas hover:opacity-80 inline-flex items-center gap-1.5"
          >
            Read the docs <span aria-hidden="true">→</span>
          </Link>
          <Link
            href="/docs/recipes"
            className="font-medium text-accent-saas hover:opacity-80 inline-flex items-center gap-1.5"
          >
            See examples <span aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
    </section>
  )
}
