interface Persona {
  readonly title: string
  readonly line: string
}

const PERSONAS: readonly Persona[] = [
  {
    title: "Next.js SaaS team",
    line: "You already build with Next.js. Dawn uses the same conventions.",
  },
  {
    title: "Scaling LangGraph across teams",
    line: "You're already on LangGraph and LangSmith. The next ten agents shouldn't each be a snowflake.",
  },
  {
    title: "AI consultancy or agency",
    line: "You build the same agent for ten clients. Build it once.",
  },
]

export function WhoItsFor() {
  return (
    <section className="relative py-20 px-8">
      <div className="text-center max-w-2xl mx-auto mb-12">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          Who it&apos;s for
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold landing-text leading-[1.1] tracking-tight text-balance"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Dawn is for you if…
        </h2>
      </div>

      <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-4">
        {PERSONAS.map((p) => (
          <div key={p.title} className="landing-surface border border-border-subtle rounded-lg p-5">
            <h3 className="text-sm font-semibold landing-text mb-2 leading-snug">{p.title}</h3>
            <p className="text-sm landing-text-muted leading-relaxed">{p.line}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
