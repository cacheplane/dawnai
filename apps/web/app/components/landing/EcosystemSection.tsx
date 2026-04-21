const packages = [
  {
    name: "@dawn/langgraph",
    accent: true,
    body: "Backend adapter for LangGraph graphs and workflows. Native execution.",
  },
  {
    name: "@dawn/langchain",
    accent: true,
    body: "Adapter for LCEL chains. Convert Dawn tools to LangChain tools automatically.",
  },
  {
    name: "@dawn/sdk",
    accent: false,
    body: "Backend-neutral contract. RuntimeContext, tools, route config. Bring any adapter.",
  },
]

export function EcosystemSection() {
  return (
    <section className="py-16 px-8 border-t border-border-subtle bg-bg-secondary">
      <div className="text-center max-w-2xl mx-auto">
        <p className="text-text-muted text-xs uppercase tracking-widest mb-3">Ecosystem</p>
        <h2 className="text-xl font-bold text-text-primary leading-snug">
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
            className="flex-1 bg-bg-card border border-border rounded-lg p-5 text-center"
          >
            <p
              className={`text-base font-bold mb-2 ${
                pkg.accent
                  ? "text-accent-green"
                  : "text-text-muted border border-dashed border-[#333] rounded inline-block px-2"
              }`}
            >
              {pkg.name}
            </p>
            <p className="text-sm text-text-muted leading-relaxed">{pkg.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
