const features = [
  {
    title: "File-system Routing",
    body: "Routes map to directories. Route groups, dynamic segments, catch-all params. Same conventions as Next.js App Router.",
  },
  {
    title: "Type-safe Tools",
    body: "Tool types inferred from source via the TypeScript compiler API. Full autocomplete. Zero manual wiring.",
  },
  {
    title: "Vite Dev Server",
    body: "Hot reload on tool and route changes. Parent-child process architecture for clean restarts.",
  },
  {
    title: "Scenario Testing",
    body: "Co-located test scenarios with expected outputs. Run against in-process, CLI, or dev server.",
  },
  {
    title: "Pluggable Backends",
    body: "LangGraph graphs, LangGraph workflows, LangChain LCEL chains. One framework, multiple execution modes.",
  },
  {
    title: "Dawn CLI",
    body: "check, routes, typegen, run, test, dev. Everything from one command. No config sprawl.",
  },
]

export function FeatureGrid() {
  return (
    <section className="py-20 px-8 border-t border-border-subtle bg-bg-secondary">
      <div className="text-center mb-10">
        <h2 className="text-3xl font-bold text-text-primary">Everything you need.</h2>
        <p className="text-text-muted mt-2">And nothing you don&apos;t.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-[650px] mx-auto">
        {features.map((feature) => (
          <div key={feature.title} className="bg-bg-card border border-border rounded-lg p-5">
            <h3 className="text-sm font-semibold text-text-primary">{feature.title}</h3>
            <p className="text-sm text-text-muted mt-2 leading-relaxed">{feature.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
