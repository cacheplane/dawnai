const stats = [
  {
    value: "0",
    label: "Zod schemas",
    detail: "Tool types inferred from your function signatures",
  },
  {
    value: "<30s",
    label: "Scaffold to run",
    detail: "npx create-dawn-app → dawn run",
  },
  {
    value: "Native",
    label: "LangGraph Platform",
    detail: "Dev server speaks the deployment protocol",
  },
  {
    value: "OSS",
    label: "MIT-licensed",
    detail: "Source available on GitHub",
  },
]

export function StatsStrip() {
  return (
    <section className="relative px-8 py-12" style={{ background: "#020617" }}>
      <div className="max-w-5xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="relative bg-bg-card/60 border border-border rounded-xl px-5 py-6 text-center backdrop-blur-sm"
          >
            <div
              className="font-mono font-semibold text-3xl md:text-4xl text-accent-amber leading-none mb-2"
              style={{ fontFeatureSettings: "'tnum'" }}
            >
              {stat.value}
            </div>
            <div className="text-sm font-semibold text-text-primary">{stat.label}</div>
            <div className="text-xs text-text-muted mt-1 leading-relaxed">{stat.detail}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
