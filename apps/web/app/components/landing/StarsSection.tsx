interface Stat {
  readonly value: string
  readonly label: string
}

const REPO_URL = "https://github.com/cacheplane/dawnai"

export function StarsSection() {
  const stats: readonly Stat[] = [
    { value: "100+", label: "Stars" },
    { value: "MIT", label: "Licensed" },
    { value: "TS", label: "Strict types" },
  ]

  return (
    <section className="py-36 px-8 border-t landing-border relative overflow-hidden">
      {/* Subtle amber bloom — celebratory but restrained */}
      <div
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          top: "50%",
          left: "50%",
          width: "80%",
          height: "120%",
          transform: "translate(-50%, -50%)",
          background:
            "radial-gradient(ellipse at center, rgba(245,165,36,0.10) 0%, rgba(245,165,36,0.04) 35%, transparent 65%)",
          zIndex: 0,
        }}
      />

      <div className="relative max-w-3xl mx-auto text-center" style={{ zIndex: 1 }}>
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          Open source
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold landing-text leading-[1.1] tracking-tight text-balance"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Loved by builders.
        </h2>
        <p className="landing-text mt-4 leading-7 max-w-xl mx-auto">
          Dawn just crossed 100 stars on GitHub. Join the early adopters.
        </p>

        <div className="mt-12 grid grid-cols-3 gap-6 max-w-2xl mx-auto">
          {stats.map((stat) => (
            <div key={stat.label} className="flex flex-col items-center">
              <span
                className="font-display text-4xl md:text-5xl font-semibold text-accent-amber tabular-nums leading-none"
                style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
              >
                {stat.value}
              </span>
              <span className="landing-text-muted text-xs uppercase tracking-widest mt-2">
                {stat.label}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-12">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-accent-amber text-bg-primary px-5 py-3 rounded-md font-semibold hover:bg-accent-amber-deep transition-colors"
          >
            <span aria-hidden>★</span>
            Star on GitHub →
          </a>
        </div>
      </div>
    </section>
  )
}
