interface ProviderCell {
  readonly name: string
  readonly role: string
  readonly logoSrc?: string
  readonly initials?: string
  readonly accent?: "green" | "neutral"
}

const PROVIDERS: readonly ProviderCell[] = [
  { name: "OpenAI", role: "model", logoSrc: "/logos/providers/openai.svg" },
  { name: "Anthropic", role: "model", logoSrc: "/logos/providers/anthropic.svg" },
  { name: "Google", role: "model", logoSrc: "/logos/providers/google.svg" },
  { name: "Bedrock", role: "model", logoSrc: "/logos/providers/bedrock.svg" },
  { name: "Mistral", role: "model", logoSrc: "/logos/providers/mistral.svg" },
  { name: "Cohere", role: "model", initials: "C" },
  { name: "LangChain", role: "runtime", logoSrc: "/logos/langchain.svg", accent: "green" },
  { name: "LangGraph", role: "runtime", logoSrc: "/logos/langgraph.svg", accent: "green" },
  { name: "LangSmith", role: "tracing", initials: "LS", accent: "green" },
  { name: "Pinecone", role: "vector", logoSrc: "/logos/providers/pinecone.svg" },
  { name: "Tavily", role: "search", initials: "T" },
  { name: "+ more", role: "via LCEL", initials: "···" },
]

interface Adapter {
  readonly pkg: string
  readonly desc: string
  readonly accent: boolean
}

const ADAPTERS: readonly Adapter[] = [
  {
    pkg: "@dawn-ai/langgraph",
    desc: "Native LangGraph runtime adapter. StateGraph wiring, conditional edges, persistence + resume.",
    accent: true,
  },
  {
    pkg: "@dawn-ai/langchain",
    desc: "LCEL chain adapter. Auto-converts Dawn tools to LangChain tools, with LangSmith tracing.",
    accent: true,
  },
  {
    pkg: "@dawn-ai/sdk",
    desc: "Backend-neutral contract. RuntimeContext, ToolRegistry, route config. Build a custom adapter in ~200 lines.",
    accent: false,
  },
]

export function EcosystemSection() {
  return (
    <section className="py-32 px-8 border-t landing-border">
      <div className="max-w-[1100px] mx-auto">
        <p className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-accent-green font-semibold mb-3">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-green" aria-hidden />
          Ecosystem
        </p>
        <h2
          className="font-display font-bold tracking-tight leading-[1.05] mb-4 max-w-[760px] landing-text"
          style={{
            fontSize: "clamp(36px, 5vw, 48px)",
            letterSpacing: "-0.025em",
            fontVariationSettings: "'opsz' 144, 'SOFT' 50",
          }}
        >
          Works with everything{" "}
          <span style={{ color: "#d97706", fontStyle: "italic" }}>LangChain does.</span>
        </h2>
        <p className="landing-text-muted text-lg leading-relaxed max-w-[600px] mb-12">
          Models, tools, tracing, vector stores. Use the providers you already pay for.
        </p>

        {/* Logo wall */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-12">
          {PROVIDERS.map((p) => (
            <ProviderCellView key={p.name} provider={p} />
          ))}
        </div>

        {/* First-party adapters divider */}
        <div className="flex items-center gap-4 mb-6">
          <div className="flex-1 h-px" style={{ background: "rgba(33,24,12,0.10)" }} />
          <span
            className="font-mono text-[11px] uppercase tracking-[0.15em] font-bold"
            style={{ color: "#00a67e" }}
          >
            First-party adapters
          </span>
          <div className="flex-1 h-px" style={{ background: "rgba(33,24,12,0.10)" }} />
        </div>

        {/* Adapter cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          {ADAPTERS.map((a) => (
            <div
              key={a.pkg}
              className="rounded-lg p-5"
              style={
                a.accent
                  ? {
                      background: "rgba(0,166,126,0.04)",
                      border: "1px solid rgba(0,166,126,0.30)",
                    }
                  : {
                      background: "rgba(33,24,12,0.04)",
                      border: "1px solid rgba(33,24,12,0.15)",
                    }
              }
            >
              <p
                className="font-mono text-[13.5px] font-semibold mb-1.5"
                style={{ color: a.accent ? "#00a67e" : "var(--landing-fg)" }}
              >
                {a.pkg}
              </p>
              <p className="text-[12.5px] landing-text-muted leading-relaxed">{a.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function ProviderCellView({ provider }: { readonly provider: ProviderCell }) {
  return (
    <div
      className="rounded-[10px] px-3 py-4 flex flex-col items-center gap-2 min-h-[96px] justify-center transition-colors"
      style={{
        background: "rgba(33,24,12,0.04)",
        border: "1px solid rgba(33,24,12,0.10)",
      }}
    >
      <div
        className="w-7 h-7 flex items-center justify-center rounded-md"
        style={{
          background: provider.accent === "green" ? "rgba(0,166,126,0.10)" : "rgba(33,24,12,0.06)",
        }}
      >
        {provider.logoSrc ? (
          // biome-ignore lint/performance/noImgElement: small inline SVG icon, next/image overhead not warranted
          <img
            src={provider.logoSrc}
            alt=""
            width={20}
            height={20}
            style={{ width: 20, height: 20, objectFit: "contain" }}
          />
        ) : (
          <span
            className="font-mono text-[10px] font-semibold"
            style={{ color: "var(--landing-muted)" }}
          >
            {provider.initials}
          </span>
        )}
      </div>
      <span className="font-semibold text-[12.5px] landing-text">{provider.name}</span>
      <span
        className="font-mono text-[9.5px] uppercase tracking-[0.06em]"
        style={{ color: "var(--landing-muted)" }}
      >
        {provider.role}
      </span>
    </div>
  )
}
