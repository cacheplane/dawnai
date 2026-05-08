const packages = [
  {
    name: "@dawn-ai/langgraph",
    accent: true,
    body: "Backend adapter for LangGraph graphs and workflows. Native execution.",
  },
  {
    name: "@dawn-ai/langchain",
    accent: true,
    body: "Adapter for LCEL chains. Convert Dawn tools to LangChain tools automatically.",
  },
  {
    name: "@dawn-ai/sdk",
    accent: false,
    body: "Backend-neutral contract. RuntimeContext, tools, route config. Bring any adapter.",
  },
]

export function EcosystemSection() {
  return (
    <section className="py-16 px-8 border-t border-border-subtle">
      <div className="text-center max-w-2xl mx-auto">
        <p className="text-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-green" aria-hidden />
          Ecosystem
        </p>
        <h2
          className="font-display text-3xl md:text-4xl font-semibold text-text-primary leading-[1.15] tracking-tight"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Built for the LangChain ecosystem.
        </h2>
        <p className="text-text-secondary mt-3 leading-7">
          Dawn is a meta-framework for LangGraph and LangChain. Use the tools and models you already
          know.
        </p>
      </div>

      <div className="flex flex-col md:flex-row gap-4 max-w-[650px] mx-auto mt-8 justify-center">
        {packages.map((pkg) => (
          <div
            key={pkg.name}
            className={`relative flex-1 bg-bg-card border rounded-lg p-5 text-center ${
              pkg.accent ? "border-accent-green/30" : "border-border"
            }`}
          >
            {pkg.accent && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-16 rounded-b-lg opacity-50"
                style={{
                  background:
                    "radial-gradient(ellipse 80% 100% at 50% 100%, rgba(0,166,126,0.18), transparent 70%)",
                }}
              />
            )}
            <p
              className={`relative text-base font-bold mb-2 ${
                pkg.accent
                  ? "text-accent-green"
                  : "text-text-muted border border-dashed border-border rounded inline-block px-2"
              }`}
            >
              {pkg.name}
            </p>
            <p className="relative text-sm text-text-muted leading-relaxed">{pkg.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
