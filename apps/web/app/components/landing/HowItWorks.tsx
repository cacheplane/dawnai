import { highlight } from "../../../lib/shiki/highlight"
import { CopyCommand } from "../CopyCommand"

const ROUTE_SNIPPET = `// src/app/(public)/hello/[tenant]/index.ts
import type { RuntimeContext } from "@dawn-ai/sdk"
import type { RouteTools } from "dawn:routes"
import type { HelloState } from "./state.js"

export async function workflow(
  state: HelloState,
  ctx: RuntimeContext<RouteTools<"/hello/[tenant]">>,
) {
  const result = await ctx.tools.greet({ tenant: state.tenant })
  return { ...state, greeting: result.greeting }
}
`

interface Step {
  readonly number: number
  readonly title: string
  readonly description: string
}

const STEPS: readonly Step[] = [
  {
    number: 1,
    title: "Scaffold",
    description: "One command. Project structure, types, dawn.config, and a working example route.",
  },
  {
    number: 2,
    title: "Write a route",
    description:
      "Routes are folders. Export a workflow, graph, or chain from index.ts. Co-locate tools, state, and tests next to it.",
  },
  {
    number: 3,
    title: "Run it",
    description: "Dispatch any route by path. Get back fully-typed output.",
  },
  {
    number: 4,
    title: "Iterate",
    description:
      "Hot reload on every save. Test scenarios run in milliseconds. Ship to prod when ready.",
  },
]

export async function HowItWorks() {
  const routeHtml = await highlight(ROUTE_SNIPPET, "typescript")

  return (
    <section className="py-36 px-8 border-t landing-border">
      <div className="text-center max-w-2xl mx-auto mb-14">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          The flow
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold landing-text leading-[1.1] tracking-tight"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Up and running in 30 seconds.
        </h2>
        <p className="landing-text mt-4 leading-7">
          Four commands, one route, one tool. Same shape as the docs — paste into a terminal and
          watch it run.
        </p>
      </div>

      <div className="max-w-3xl mx-auto space-y-10">
        {/* Step 1 — Scaffold */}
        <Step step={STEPS[0]}>
          <CopyCommand command="npx create-dawn-app my-agent" />
        </Step>

        {/* Step 2 — Write a route (with real code snippet) */}
        <Step step={STEPS[1]}>
          <div className="bg-bg-card border border-border rounded-lg overflow-hidden mt-3">
            <div className="px-4 py-2 border-b border-border-subtle">
              <p className="text-text-muted text-[0.65rem] font-mono">
                src/app/(public)/hello/[tenant]/index.ts
              </p>
            </div>
            <div
              className="text-xs leading-6 overflow-x-auto p-4 [&_pre]:bg-transparent [&_pre]:m-0 [&_pre]:p-0"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is server-generated
              dangerouslySetInnerHTML={{ __html: routeHtml }}
            />
          </div>
        </Step>

        {/* Step 3 — Run it */}
        <Step step={STEPS[2]}>
          <CopyCommand command="dawn run '/hello/acme'" />
        </Step>

        {/* Step 4 — Iterate */}
        <Step step={STEPS[3]}>
          <div className="flex flex-wrap gap-2 mt-3">
            <CopyCommand command="dawn dev" />
            <CopyCommand command="dawn test" />
          </div>
        </Step>
      </div>
    </section>
  )
}

function Step({
  step,
  children,
}: {
  readonly step: Step | undefined
  readonly children: React.ReactNode
}) {
  if (!step) return null
  return (
    <div className="flex gap-5 items-start">
      <div
        className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
          step.number === 1
            ? "bg-accent-amber text-bg-primary"
            : "border landing-border landing-text"
        }`}
        style={step.number !== 1 ? { borderColor: "var(--landing-border)" } : undefined}
      >
        {step.number}
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-base font-semibold landing-text">{step.title}</h3>
        <p className="text-sm landing-text-muted mt-1.5 leading-relaxed">{step.description}</p>
        {children}
      </div>
    </div>
  )
}
