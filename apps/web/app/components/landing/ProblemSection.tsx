const painPoints = [
  {
    title: "You've written the same StateGraph boilerplate five times.",
    body: "State channels, nodes, edges, the same pattern in every project. Every repo invents its own structure.",
  },
  {
    title: "Your tool's Zod schema drifted from its function signature.",
    body: "You found out at runtime. Schemas live in one file, the actual function in another, and the types between them quietly disagree.",
  },
  {
    title: "You added console.log to find out what state your agent is in.",
    body: "There's no dev server that shows the graph mid-run. No hot reload when you change a tool. No structured way to test scenarios.",
  },
  {
    title: "Your deployment is a hand-rolled Docker image.",
    body: "You wrote the server, the routing, the protocol adapter. Every team building production agents on LangGraph rebuilds this from scratch.",
  },
]

function CodeColumn({
  label,
  caption,
  borderClass,
  labelClass,
  children,
}: {
  label: string
  caption: string
  borderClass: string
  labelClass: string
  children: React.ReactNode
}) {
  return (
    <div
      className={`flex-1 min-w-0 bg-bg-card/80 border rounded-lg overflow-hidden ${borderClass}`}
    >
      <div className="px-4 py-2.5 border-b border-border-subtle flex items-center justify-between">
        <span className={`text-xs font-mono uppercase tracking-wider ${labelClass}`}>{label}</span>
        <span className="text-[10px] text-text-muted font-mono">{caption}</span>
      </div>
      <pre className="px-4 py-3 text-xs leading-6 font-mono text-text-secondary overflow-x-auto whitespace-pre">
        {children}
      </pre>
    </div>
  )
}

export function ProblemSection() {
  return (
    <section
      className="relative py-20 px-8"
      style={{
        background:
          "linear-gradient(to bottom, #020617 0%, #050a1a 25%, var(--color-bg-primary) 100%)",
      }}
    >
      <div className="text-center max-w-2xl mx-auto">
        <p className="text-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          The Problem
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold text-text-primary leading-[1.1] text-balance tracking-tight"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          LangChain gave us the runtime. Every team builds the framework around it by hand.
        </h2>
        <p className="text-text-secondary mt-5 leading-7">
          LangGraph is powerful and unopinionated &mdash; that&apos;s the design. So every team
          adopting it &mdash; including ours &mdash; ends up inventing project structure, type
          wiring, dev tooling, and deployment scripts from scratch. We&apos;ve watched this happen
          at every company building agents on LangChain.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto mt-12">
        {painPoints.map((point) => (
          <div
            key={point.title}
            className="relative bg-bg-card border border-indigo-500/20 rounded-lg p-5 overflow-hidden"
          >
            {/* Cool indigo glow at the bottom — these are unsolved pre-dawn problems */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-20 rounded-b-lg opacity-60"
              style={{
                background:
                  "radial-gradient(ellipse 80% 100% at 50% 100%, rgba(99,102,241,0.15), transparent 70%)",
              }}
            />
            <h3 className="relative text-sm font-semibold text-text-primary leading-snug">
              {point.title}
            </h3>
            <p className="relative text-sm text-text-muted mt-2 leading-relaxed">{point.body}</p>
          </div>
        ))}
      </div>

      {/* Side-by-side: same agent, two ways. The visual difference is the argument. */}
      <div className="max-w-5xl mx-auto mt-16">
        <p className="text-center text-xs uppercase tracking-widest text-text-muted mb-2">
          The same agent, two ways
        </p>
        <p className="text-center font-display text-2xl md:text-3xl font-semibold text-text-primary tracking-tight mb-8">
          One greets a tenant.
        </p>
        <div className="flex flex-col md:flex-row gap-4">
          <CodeColumn
            label="Raw LangGraph"
            caption="one file · ~30 lines"
            borderClass="border-indigo-500/25"
            labelClass="text-indigo-300"
          >
            {`import { StateGraph, START, END } from "@langchain/langgraph"
import { z } from "zod"

const GreetSchema = z.object({ tenant: z.string() })
type State = { tenant: string; greeting?: string }

async function greet(i: z.infer<typeof GreetSchema>) {
  return { greeting: \`Hello, \${i.tenant}!\` }
}

const graph = new StateGraph<State>({
  channels: {
    tenant:   { value: (_, y) => y, default: () => "" },
    greeting: { value: (_, y) => y, default: () => "" },
  },
})
  .addNode("greet", async (state) => {
    const r = await greet({ tenant: state.tenant })
    return { greeting: r.greeting }
  })
  .addEdge(START, "greet")
  .addEdge("greet", END)

const app = graph.compile()
const result = await app.invoke({ tenant: "acme" })

// + write your own dev loop, types, server, and deploy.`}
          </CodeColumn>

          <CodeColumn
            label="With Dawn"
            caption="three focused files · zero plumbing"
            borderClass="border-accent-amber/40"
            labelClass="text-accent-amber"
          >
            {`// src/app/(public)/hello/[tenant]/state.ts
export interface HelloState {
  tenant: string
  greeting?: string
}

// src/app/(public)/hello/[tenant]/tools/greet.ts
export default async (i: { readonly tenant: string }) =>
  ({ greeting: \`Hello, \${i.tenant}!\` })

// src/app/(public)/hello/[tenant]/index.ts
import type { RuntimeContext } from "@dawn-ai/sdk"
import type { RouteTools } from "dawn:routes"
import type { HelloState } from "./state.js"

export async function workflow(
  state: HelloState,
  ctx: RuntimeContext<RouteTools<"/hello/[tenant]">>,
) {
  const { greeting } = await ctx.tools.greet({
    tenant: state.tenant,
  })
  return { ...state, greeting }
}

// $ dawn run "/hello/acme"  · dawn dev · dawn test`}
          </CodeColumn>
        </div>
        <p className="text-center text-sm text-text-muted mt-6 max-w-2xl mx-auto leading-relaxed">
          Dawn writes the StateGraph wiring, generates the tool types from your function signatures,
          runs the dev server, and speaks the LangGraph Platform protocol. You write the agent
          logic. The framework gives you back the time.
        </p>
      </div>
    </section>
  )
}
