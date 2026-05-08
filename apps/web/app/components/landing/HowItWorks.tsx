const steps = [
  {
    number: 1,
    title: "Scaffold",
    content: (
      <code className="font-mono text-xs landing-text-muted landing-surface px-3 py-1.5 rounded border inline-block mt-1.5">
        npx create-dawn-app my-agent
      </code>
    ),
  },
  {
    number: 2,
    title: "Write a route",
    content: (
      <p className="text-sm landing-text-muted mt-1.5 leading-relaxed">
        Export a <code className="font-mono landing-text">workflow</code>,{" "}
        <code className="font-mono landing-text">graph</code>, or{" "}
        <code className="font-mono landing-text">chain</code> from your route&apos;s index.ts. Add
        tools in a tools/ directory.
      </p>
    ),
  },
  {
    number: 3,
    title: "Run it",
    content: (
      <code className="font-mono text-xs landing-text-muted landing-surface px-3 py-1.5 rounded border inline-block mt-1.5">
        dawn run &apos;/hello/acme&apos;
      </code>
    ),
  },
  {
    number: 4,
    title: "Test & iterate",
    content: (
      <>
        <code className="font-mono text-xs landing-text-muted landing-surface px-3 py-1.5 rounded border inline-block mt-1.5">
          dawn dev
        </code>
        <p className="text-sm landing-text-muted mt-1.5 leading-relaxed">
          Hot reload. Change tools, see results instantly.
        </p>
      </>
    ),
  },
]

export function HowItWorks() {
  return (
    <section className="py-36 px-8 border-t landing-border">
      <div className="text-center mb-10">
        <h2
          className="font-display text-4xl md:text-5xl font-semibold landing-text tracking-tight"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Up and running in 30 seconds.
        </h2>
      </div>

      <div className="max-w-md mx-auto space-y-8">
        {steps.map((step) => (
          <div key={step.number} className="flex gap-5 items-start">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
                step.number === 1
                  ? "bg-accent-amber text-bg-primary"
                  : "landing-surface border landing-text"
              }`}
            >
              {step.number}
            </div>
            <div>
              <h3 className="text-base font-semibold landing-text">{step.title}</h3>
              {step.content}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
