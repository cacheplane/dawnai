interface Feature {
  readonly title: string
  readonly body: string
}

interface Category {
  readonly heading: string
  readonly features: readonly Feature[]
}

const CATEGORIES: readonly Category[] = [
  {
    heading: "Conventions",
    features: [
      {
        title: "File-system routing",
        body: "Routes are folders. Route groups, dynamic segments, catch-all params — same conventions as Next.js App Router.",
      },
      {
        title: "Co-location",
        body: "Tools, state, and tests sit next to the workflow that uses them. No central registry, no manual imports.",
      },
      {
        title: "Inferred tool types",
        body: "Tool params lifted from your function signatures via the TypeScript compiler API. Zero schema duplication, zero Zod boilerplate.",
      },
      {
        title: "Middleware & retry",
        body: "Auth, logging, rate-limit, retry-with-backoff. Same semantics as Next.js middleware — runs before your workflow.",
      },
    ],
  },
  {
    heading: "Tooling",
    features: [
      {
        title: "Vite dev server",
        body: "Hot reload on every tool and route change. Parent-child process model for clean restarts.",
      },
      {
        title: "One CLI",
        body: "dawn dev, run, test, check, typegen, routes, deploy. Everything from one binary — no config sprawl.",
      },
      {
        title: "Scenario testing",
        body: "Co-located test scenarios with expected outputs. Run in-process, via CLI, or against the dev server.",
      },
      {
        title: "Generated types",
        body: "dawn.generated.d.ts is an ambient module typed with your routes, tools, and state. Full editor autocomplete.",
      },
    ],
  },
  {
    heading: "Runtime",
    features: [
      {
        title: "LangGraph workflows",
        body: "Linear, async-first execution with full state typing. The default for most agent routes.",
      },
      {
        title: "LangGraph graphs",
        body: "Branching, looping, conditional edges. The full LangGraph DSL for routes that need it.",
      },
      {
        title: "LangChain LCEL chains",
        body: "For the simple linear cases. Drop in an LCEL chain when a graph would be overkill.",
      },
      {
        title: "Platform protocol",
        body: "Native /runs/wait, /runs/stream, and assistant_id routing. What runs locally deploys without translation.",
      },
    ],
  },
]

export function FeatureGrid() {
  return (
    <section className="py-36 px-8 border-t landing-border">
      <div className="text-center max-w-2xl mx-auto mb-14">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          Everything you need
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold landing-text leading-[1.1] tracking-tight text-balance"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          A complete framework, in three layers.
        </h2>
        <p className="landing-text mt-4 leading-7">
          Conventions you write against. Tooling you run locally. Runtime that ships to production.
          Twelve features, none of them optional.
        </p>
      </div>

      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-10">
        {CATEGORIES.map((cat) => (
          <div key={cat.heading}>
            <h3
              className="text-[11px] uppercase tracking-[0.15em] font-bold text-accent-amber-deep pb-3 mb-4 border-b"
              style={{ borderColor: "rgba(217,119,6,0.2)" }}
            >
              {cat.heading}
            </h3>
            <div className="flex flex-col gap-3">
              {cat.features.map((feature) => (
                <div
                  key={feature.title}
                  className="rounded-lg p-5"
                  style={{
                    background: "var(--landing-surface)",
                    border: "1px solid var(--landing-border)",
                  }}
                >
                  <h4 className="text-sm font-semibold landing-text mb-1.5">{feature.title}</h4>
                  <p className="text-[13px] landing-text-muted leading-relaxed">{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
