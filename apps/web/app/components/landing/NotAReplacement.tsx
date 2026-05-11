interface Claim {
  readonly noun: string
  readonly rest: string
}

const CLAIMS: readonly Claim[] = [
  {
    noun: "LangGraph",
    rest: "The runtime stays where it is.",
  },
  {
    noun: "LangSmith",
    rest: "Deploy as you already do.",
  },
  {
    noun: "your model providers",
    rest: "OpenAI, Anthropic, Google — all the same.",
  },
]

export function NotAReplacement() {
  return (
    <section className="relative py-20 px-8">
      <div className="text-center max-w-2xl mx-auto mb-10">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          Not a replacement
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold landing-text leading-[1.1] tracking-tight text-balance"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Dawn doesn&apos;t replace your stack.
        </h2>
      </div>

      <div className="max-w-2xl mx-auto">
        {CLAIMS.map((claim, i) => (
          <div
            key={claim.noun}
            className={`text-base landing-text-muted py-4 leading-relaxed ${
              i === 0 ? "" : "border-t landing-border"
            }`}
          >
            Dawn doesn&apos;t replace{" "}
            <strong className="text-text-primary font-medium">{claim.noun}</strong>. {claim.rest}
          </div>
        ))}
      </div>
    </section>
  )
}
