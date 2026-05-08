interface Logo {
  readonly name: string
  readonly src: string
}

const LOGOS: readonly Logo[] = [
  { name: "LangChain", src: "/logos/langchain.svg" },
  { name: "LangGraph", src: "/logos/langgraph.svg" },
  { name: "TypeScript", src: "/logos/typescript.svg" },
  { name: "Vite", src: "/logos/vite.svg" },
  { name: "Node.js", src: "/logos/nodejs.svg" },
]

export function LogoWall() {
  return (
    <section className="relative px-8 py-10">
      <div className="max-w-5xl mx-auto">
        <p className="text-center text-xs uppercase tracking-widest text-text-muted mb-8">
          Built on
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-6">
          {LOGOS.map((logo) => (
            <span
              key={logo.name}
              className="inline-flex items-center gap-2.5 text-sm font-semibold text-text-secondary opacity-70 hover:opacity-100 transition-opacity"
            >
              {/* biome-ignore lint/performance/noImgElement: small inline SVG, next/image overhead not warranted */}
              <img src={logo.src} alt="" width={22} height={22} className="shrink-0" />
              {logo.name}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
