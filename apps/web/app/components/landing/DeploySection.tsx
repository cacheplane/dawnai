const steps = [
  {
    label: "Develop",
    commands: ["dawn dev", "dawn run", "dawn test"],
    accent: false,
  },
  {
    label: "Validate",
    commands: ["dawn check", "dawn typegen", "dawn routes"],
    accent: false,
  },
  {
    label: "Deploy",
    commands: ["LangGraph Platform", "LangSmith Assistants", "Your infrastructure"],
    accent: true,
  },
]

export function DeploySection() {
  return (
    <section className="py-20 px-8 border-t landing-border">
      <div className="text-center max-w-2xl mx-auto">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          The Deploy Story
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold landing-text leading-[1.1] tracking-tight text-balance"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Build locally. Deploy to LangSmith.
        </h2>
        <p className="landing-text mt-4 leading-7">
          Dawn owns your local development lifecycle. When you&apos;re ready to ship, your routes
          speak the LangGraph Platform protocol natively &mdash; deploy as LangSmith assistants with
          the infrastructure you already trust.
        </p>
      </div>

      {/* Pipeline — stacked vertically on mobile, horizontal on md+ */}
      <div className="max-w-[650px] mx-auto mt-10 flex flex-col md:flex-row items-center justify-center gap-0">
        {steps.map((step, i) => (
          <div key={step.label} className="flex flex-col md:flex-row items-center">
            <div className="text-center flex-1 min-w-[140px]">
              <div
                className={`w-14 h-14 rounded-[10px] flex items-center justify-center mx-auto mb-3 ${
                  step.accent
                    ? "bg-gradient-to-br from-[#1a1005] to-[#2a1a08] border border-accent-amber/40"
                    : "landing-surface border"
                }`}
              >
                {i === 0 && (
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={step.accent ? "#f59e0b" : "#f8f5ef"}
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <polyline points="16 18 22 12 16 6" />
                    <polyline points="8 6 2 12 8 18" />
                  </svg>
                )}
                {i === 1 && (
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={step.accent ? "#f59e0b" : "#f8f5ef"}
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                )}
                {i === 2 && (
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="M22 2L11 13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                )}
              </div>
              <p
                className={`text-sm font-semibold ${step.accent ? "text-accent-amber" : "landing-text"}`}
              >
                {step.label}
              </p>
              <div className="text-xs landing-text-muted mt-1.5 leading-5">
                {step.commands.map((cmd) => (
                  <div key={cmd}>{cmd}</div>
                ))}
              </div>
            </div>
            {i < steps.length - 1 && (
              <span className="text-accent-amber/50 text-2xl mx-2 my-2 md:my-0 md:mb-8 inline-flex">
                <span className="md:hidden" aria-hidden>
                  &darr;
                </span>
                <span className="hidden md:inline" aria-hidden>
                  &rarr;
                </span>
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Protocol note */}
      <div className="max-w-[550px] mx-auto mt-8 landing-surface border rounded-lg px-5 py-4 flex gap-4 items-start">
        <span className="text-accent-amber text-base mt-0.5">&#9432;</span>
        <p className="text-sm landing-text leading-relaxed">
          Dawn&apos;s dev server speaks the{" "}
          <span className="landing-text">LangGraph Platform protocol</span> natively &mdash;{" "}
          <code className="text-xs landing-text font-mono">/runs/wait</code>,{" "}
          <code className="text-xs landing-text font-mono">/runs/stream</code>,{" "}
          <code className="text-xs landing-text font-mono">assistant_id</code> routing. What runs
          locally deploys without translation.
        </p>
      </div>
    </section>
  )
}
