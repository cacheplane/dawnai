interface FragmentedProject {
  readonly name: string
  readonly stat: string
  readonly tree: string
}

const FRAGMENTED_PROJECTS: readonly FragmentedProject[] = [
  {
    name: "customer-support-bot",
    stat: "8 tools · 3 agents",
    tree: `agents/
  triage.py
  escalate.py
  resolve.py
tools.py
prompts/`,
  },
  {
    name: "ops-incident-agent",
    stat: "12 nodes · 5 tools",
    tree: `src/
  graphs/
    incident.ts
  nodes/
    diagnose.ts
    page-oncall.ts
  tools/`,
  },
  {
    name: "sales-copilot",
    stat: "4 chains · 2 prompt sets",
    tree: `lib/
  llm/
  chains/
    qualify.ts
    handoff.ts
prompts/
  v1/
  v2/`,
  },
  {
    name: "data-pipeline-bot",
    stat: "1 graph · 6 tools",
    tree: `pipeline_bot/
  __init__.py
  main.py
  models.py
  tools.py
tests/`,
  },
  {
    name: "research-agent",
    stat: "1 file · 9 tools inlined",
    tree: `src/
  index.ts
  agent.ts
  types.ts
prompts.json`,
  },
]

const DAWN_TREE = `src/app/
  (public)/
    hello/[tenant]/
      index.ts
      state.ts
      tools/
        greet.ts`

const PAINS: readonly string[] = [
  "Same StateGraph boilerplate. Fifth project running.",
  "Your tool's Zod schema drifted from its function signature. You found out at runtime.",
  "Your deploy is a hand-rolled Dockerfile per agent.",
  "Even your coding agent gets lost — every agent codebase has a different shape.",
]

export function ProblemSection() {
  return (
    <section className="relative py-20 px-8">
      <div className="text-center max-w-2xl mx-auto">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          Sound familiar?
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold landing-text leading-[1.1] tracking-tight text-balance"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Five projects in your org. Five different shapes.
        </h2>
        <p className="landing-text-muted mt-5 leading-7">
          We&apos;ve watched this in every company we&apos;ve worked at. It hurts.
        </p>
      </div>

      <div className="max-w-6xl mx-auto mt-12 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {FRAGMENTED_PROJECTS.map((project) => (
          <div
            key={project.name}
            className="landing-surface border border-indigo-500/20 rounded-lg p-3 flex flex-col gap-2"
          >
            <p className="text-[10px] font-mono uppercase tracking-wider text-indigo-300/80 truncate">
              {project.name}
            </p>
            <pre className="whitespace-pre font-mono text-[11px] leading-5 landing-text-muted overflow-hidden">
              {project.tree}
            </pre>
            <p className="text-[10px] font-mono landing-text-muted mt-auto pt-1 border-t border-border-subtle/50">
              {project.stat}
            </p>
          </div>
        ))}
      </div>

      <div className="max-w-6xl mx-auto mt-10 flex flex-col items-center">
        <p className="font-display text-lg landing-text-muted italic mb-4">Or — one shape.</p>
        <div className="w-full max-w-md landing-surface border border-accent-amber/40 bg-accent-amber/5 rounded-lg p-5 flex flex-col gap-2">
          <p className="text-[10px] font-mono uppercase tracking-wider text-accent-amber">
            any dawn project
          </p>
          <pre className="whitespace-pre font-mono text-xs leading-6 landing-text">{DAWN_TREE}</pre>
        </div>
      </div>

      <div className="max-w-2xl mx-auto mt-16">
        {PAINS.map((pain, index) => (
          <div
            key={pain}
            className={`text-base landing-text-muted py-4 leading-relaxed ${
              index === 0 ? "" : "border-t landing-border"
            }`}
          >
            {pain}
          </div>
        ))}
      </div>

      <p className="text-center font-display text-2xl md:text-3xl font-semibold landing-text tracking-tight mt-12 max-w-2xl mx-auto">
        Dawn is the convention that makes it stop.
      </p>
    </section>
  )
}
