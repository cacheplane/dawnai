const painPoints = [
  {
    title: "Where do agents live?",
    body: "No standard project structure. Every repo is a snowflake.",
  },
  {
    title: "How do tools get typed?",
    body: "Manual type wiring everywhere. Zod schemas disconnected from tool functions.",
  },
  {
    title: "How do I test locally?",
    body: "No dev server, no hot reload, no scenario runner. console.log debugging.",
  },
  {
    title: "How do I deploy?",
    body: "Each team hand-rolls Docker, infra, and server config from scratch.",
  },
]

export function ProblemSection() {
  return (
    <section className="py-20 px-8 border-t border-border-subtle">
      <div className="text-center max-w-2xl mx-auto">
        <p className="text-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          The Problem
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold text-text-primary leading-[1.1] text-balance tracking-tight"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Building agents with raw LangGraph is like building React apps before Next.js.
        </h2>
        <p className="text-text-secondary mt-4 leading-7">
          You get the runtime. But you&apos;re left to figure out project structure, tooling, type
          safety, and deployment on your own. Every team reinvents the same scaffolding.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto mt-10">
        {painPoints.map((point) => (
          <div key={point.title} className="bg-bg-card border border-border rounded-lg p-5">
            <h3 className="text-sm font-semibold text-text-primary">{point.title}</h3>
            <p className="text-sm text-text-muted mt-2 leading-relaxed">{point.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
