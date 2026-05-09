const rows: Array<{
  label: string
  nextjs: string
  dawn: string
  dawnOnly?: boolean
}> = [
  {
    label: "File-system routing",
    nextjs: "app/page.tsx",
    dawn: "src/app/index.ts",
  },
  { label: "Dynamic segments", nextjs: "[slug]", dawn: "[tenant]" },
  { label: "Route groups", nextjs: "(marketing)", dawn: "(public)" },
  {
    label: "Generated types",
    nextjs: ".next/types/",
    dawn: "dawn.generated.d.ts",
  },
  { label: "Dev server", nextjs: "next dev", dawn: "dawn dev" },
  { label: "Scaffold CLI", nextjs: "create-next-app", dawn: "create-dawn-app" },
  {
    label: "Co-located tools w/ type inference",
    nextjs: "\u2014",
    dawn: "\u2713",
    dawnOnly: true,
  },
  {
    label: "Built-in scenario testing",
    nextjs: "\u2014",
    dawn: "\u2713",
    dawnOnly: true,
  },
]

export function ComparisonTable() {
  return (
    <section className="py-28 px-8 border-t landing-border">
      <div className="text-center max-w-2xl mx-auto">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          Quick check
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold landing-text leading-[1.1] tracking-tight"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          You already know this story.
        </h2>
        <p className="landing-text mt-4 leading-7">
          Every runtime gets a framework. React got Next.js. Svelte got SvelteKit. Vue got Nuxt.
          LangGraph just got Dawn.
        </p>
      </div>

      <div className="max-w-[650px] mx-auto mt-10 border landing-border rounded-lg overflow-hidden relative">
        {/* Header */}
        <div className="grid grid-cols-[2fr_1fr_1fr] landing-surface px-3 sm:px-5 py-3 text-[10px] sm:text-xs landing-text uppercase tracking-wide font-semibold">
          <span>Convention</span>
          <span className="text-center">Next.js</span>
          <span className="text-center text-accent-amber">Dawn</span>
        </div>

        {/* Rows */}
        {rows.map((row, i) => (
          <div
            key={row.label}
            className={`grid grid-cols-[2fr_1fr_1fr] px-3 sm:px-5 py-2.5 text-xs sm:text-sm border-t landing-border ${
              i % 2 === 1 ? "landing-surface" : ""
            }`}
          >
            <span className={`landing-text ${row.dawnOnly ? "font-semibold" : ""}`}>
              {row.label}
            </span>
            <span className="text-center landing-text-muted font-mono text-[10px] sm:text-xs break-all sm:break-normal">
              {row.nextjs}
            </span>
            <span
              className={`text-center font-mono text-[10px] sm:text-xs break-all sm:break-normal ${
                row.dawnOnly ? "text-accent-amber font-semibold text-xs sm:text-sm" : "landing-text"
              }`}
            >
              {row.dawn}
            </span>
          </div>
        ))}
      </div>

      <p className="text-center mt-5 landing-text-muted text-sm">
        Same conventions you already know. Purpose-built for AI agents.
      </p>
    </section>
  )
}
