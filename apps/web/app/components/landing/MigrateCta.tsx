import Link from "next/link"

export function MigrateCta() {
  return (
    <section className="relative py-20 px-8">
      <div className="text-center max-w-2xl mx-auto">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          Already on LangGraph?
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold landing-text leading-[1.1] tracking-tight text-balance"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Bring your project. Migrate in an afternoon.
        </h2>
        <div className="mt-8">
          <Link
            href="/docs/migrating-from-langgraph"
            className="inline-flex items-center gap-2 bg-accent-amber text-bg-primary px-5 py-3 rounded-md font-semibold hover:bg-accent-amber-deep transition-colors"
          >
            Migrate from LangGraph →
          </Link>
        </div>
      </div>
    </section>
  )
}
