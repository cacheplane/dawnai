interface Layer {
  readonly label: string
  readonly items: readonly string[]
  readonly accent: "neutral" | "dawn" | "ecosystem"
}

const LAYERS: readonly Layer[] = [
  {
    label: "You",
    items: ["Routes", "Tools", "State", "Tests"],
    accent: "neutral",
  },
  {
    label: "Dawn",
    items: ["Conventions", "Type inference", "Dev server", "CLI", "Deployment protocol"],
    accent: "dawn",
  },
  {
    label: "LangChain",
    items: ["LangGraph runtime", "LangGraph Platform", "LangSmith Assistants"],
    accent: "ecosystem",
  },
]

function Connector() {
  return (
    <div aria-hidden className="flex justify-center">
      <div className="w-px h-6 bg-gradient-to-b from-border via-border to-transparent" />
    </div>
  )
}

function LayerCard({ layer }: { layer: Layer }) {
  const isDawn = layer.accent === "dawn"
  const isEcosystem = layer.accent === "ecosystem"
  const borderClass = isDawn
    ? "border-accent-amber/40"
    : isEcosystem
      ? "border-accent-green/25"
      : ""
  const labelClass = isDawn
    ? "text-accent-amber"
    : isEcosystem
      ? "text-accent-green"
      : "landing-text"

  return (
    <div
      className={`relative landing-surface border rounded-xl p-6 overflow-hidden ${borderClass}`}
    >
      {/* Illuminated glow for the Dawn layer — this is the piece that was missing */}
      {isDawn && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-xl opacity-80"
          style={{
            background:
              "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(245,158,11,0.08), transparent 70%)",
          }}
        />
      )}
      {/* Soft green tint for the ecosystem layer */}
      {isEcosystem && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-20 rounded-b-xl opacity-50"
          style={{
            background:
              "radial-gradient(ellipse 80% 100% at 50% 100%, rgba(0,166,126,0.12), transparent 70%)",
          }}
        />
      )}
      <div className="relative flex flex-col md:flex-row md:items-center gap-4 md:gap-8">
        <div className="md:w-40 shrink-0">
          <p
            className={`font-display text-2xl md:text-3xl font-semibold tracking-tight ${labelClass}`}
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
          >
            {layer.label}
          </p>
          {isDawn && (
            <p className="text-[10px] uppercase tracking-widest text-accent-amber/80 mt-1">
              The missing layer
            </p>
          )}
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm font-mono landing-text">
          {layer.items.map((item, i) => (
            <li key={item} className="flex items-center gap-4">
              <span>{item}</span>
              {i < layer.items.length - 1 && (
                <span aria-hidden className="text-text-dim">
                  ·
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function ArchitectureSection() {
  return (
    <section className="relative py-36 px-8 border-t landing-border">
      <div className="text-center max-w-2xl mx-auto mb-12">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          The Architecture
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold landing-text leading-[1.1] tracking-tight text-balance"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Between your code and LangChain.
        </h2>
        <p className="landing-text mt-4 leading-7">
          Dawn is the conventions layer &mdash; everything you&apos;d build by hand, we built in the
          open.
        </p>
      </div>

      <div className="max-w-3xl mx-auto">
        {LAYERS.map((layer, i) => (
          <div key={layer.label}>
            <LayerCard layer={layer} />
            {i < LAYERS.length - 1 && <Connector />}
          </div>
        ))}
      </div>

      <div className="max-w-2xl mx-auto mt-10 text-center">
        <p className="text-sm landing-text-muted leading-relaxed">
          <span className="landing-text">You</span> write the agent logic.{" "}
          <span className="text-accent-amber">Dawn</span> writes the framework.{" "}
          <span className="text-accent-green">LangChain</span> runs the runtime.
        </p>
      </div>
    </section>
  )
}
