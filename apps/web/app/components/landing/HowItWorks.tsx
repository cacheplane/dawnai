const steps = [
  {
    number: 1,
    title: "Scaffold",
    content: (
      <code className="font-mono text-xs text-text-muted bg-bg-card px-3 py-1.5 rounded border border-border inline-block mt-1.5">
        npx create-dawn-app my-agent
      </code>
    ),
  },
  {
    number: 2,
    title: "Write a route",
    content: (
      <p className="text-sm text-text-muted mt-1.5 leading-relaxed">
        Export a <code className="font-mono text-text-secondary">workflow</code>,{" "}
        <code className="font-mono text-text-secondary">graph</code>, or{" "}
        <code className="font-mono text-text-secondary">chain</code> from your route&apos;s
        index.ts. Add tools in a tools/ directory.
      </p>
    ),
  },
  {
    number: 3,
    title: "Run it",
    content: (
      <code className="font-mono text-xs text-text-muted bg-bg-card px-3 py-1.5 rounded border border-border inline-block mt-1.5">
        dawn run &apos;/hello/acme&apos;
      </code>
    ),
  },
  {
    number: 4,
    title: "Test & iterate",
    content: (
      <>
        <code className="font-mono text-xs text-text-muted bg-bg-card px-3 py-1.5 rounded border border-border inline-block mt-1.5">
          dawn dev
        </code>
        <p className="text-sm text-text-muted mt-1.5 leading-relaxed">
          Hot reload. Change tools, see results instantly.
        </p>
      </>
    ),
  },
]

export function HowItWorks() {
  return (
    <section className="py-20 px-8 border-t border-border-subtle">
      <div className="text-center mb-10">
        <h2 className="text-3xl font-bold text-text-primary">Up and running in 30 seconds.</h2>
      </div>

      <div className="max-w-md mx-auto space-y-8">
        {steps.map((step) => (
          <div key={step.number} className="flex gap-5 items-start">
            <div className="w-8 h-8 rounded-full bg-[#181818] text-text-primary flex items-center justify-center text-sm font-bold shrink-0">
              {step.number}
            </div>
            <div>
              <h3 className="text-base font-semibold text-text-primary">{step.title}</h3>
              {step.content}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
