const pillars = [
  {
    title: "Convention",
    body: "Routes, tools, state, config. Everything in the right place. If you know App Router, you know Dawn.",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    title: "Type Safety",
    body: "Tool signatures extracted at build time. Full autocomplete. No manual type wiring.",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <polyline points="4 7 4 4 20 4 20 7" />
        <line x1="9" y1="20" x2="15" y2="20" />
        <line x1="12" y1="4" x2="12" y2="20" />
      </svg>
    ),
  },
  {
    title: "Tooling",
    body: "Dev server with hot reload. CLI for running, testing, and validating. Vite-powered.",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
]

export function SolutionSection() {
  return (
    <section className="py-20 px-8 border-t landing-border">
      <div className="text-center max-w-2xl mx-auto">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          The Solution
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold landing-text leading-[1.1] text-balance tracking-tight"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Dawn gives your agents the structure they deserve.
        </h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-3xl mx-auto mt-10">
        {pillars.map((pillar) => (
          <div key={pillar.title} className="text-center">
            <div className="w-12 h-12 rounded-[10px] landing-surface border flex items-center justify-center mx-auto mb-4 landing-text">
              {pillar.icon}
            </div>
            <h3 className="text-base font-semibold landing-text">{pillar.title}</h3>
            <p className="text-sm landing-text-muted mt-2 leading-relaxed">{pillar.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
