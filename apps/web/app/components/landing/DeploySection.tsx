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
    <section className="py-20 px-8 border-t border-border-subtle">
      <div className="text-center max-w-2xl mx-auto">
        <p className="text-text-muted text-xs uppercase tracking-widest mb-3">The Deploy Story</p>
        <h2 className="text-3xl font-bold text-text-primary leading-snug">
          Build locally.
          <br />
          Deploy to LangSmith.
        </h2>
        <p className="text-text-secondary mt-4 leading-7">
          Dawn owns your local development lifecycle. When you&apos;re ready to ship, your routes
          speak the LangGraph Platform protocol natively &mdash; deploy as LangSmith assistants with
          the infrastructure you already trust.
        </p>
      </div>

      {/* Pipeline */}
      <div className="max-w-[650px] mx-auto mt-10 flex items-center justify-center gap-0">
        {steps.map((step, i) => (
          <div key={step.label} className="flex items-center">
            <div className="text-center flex-1 min-w-[140px]">
              <div
                className={`w-14 h-14 rounded-[10px] flex items-center justify-center mx-auto mb-3 ${
                  step.accent
                    ? "bg-gradient-to-br from-[#0a1a10] to-[#0a200a] border border-[#1a3a1a]"
                    : "bg-[#111] border border-[#222]"
                }`}
              >
                {i === 0 && (
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={step.accent ? "#00a67e" : "#fff"}
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
                    stroke={step.accent ? "#00a67e" : "#fff"}
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
                    stroke="#00a67e"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="M22 2L11 13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                )}
              </div>
              <p
                className={`text-sm font-semibold ${step.accent ? "text-accent-green" : "text-text-primary"}`}
              >
                {step.label}
              </p>
              <div className="text-xs text-text-muted mt-1.5 leading-5">
                {step.commands.map((cmd) => (
                  <div key={cmd}>{cmd}</div>
                ))}
              </div>
            </div>
            {i < steps.length - 1 && <span className="text-[#333] text-2xl mb-8 mx-2">&rarr;</span>}
          </div>
        ))}
      </div>

      {/* Protocol note */}
      <div className="max-w-[550px] mx-auto mt-8 bg-bg-card border border-border rounded-lg px-5 py-4 flex gap-4 items-start">
        <span className="text-accent-green text-base mt-0.5">&#9432;</span>
        <p className="text-sm text-text-secondary leading-relaxed">
          Dawn&apos;s dev server speaks the{" "}
          <span className="text-text-primary">LangGraph Platform protocol</span> natively &mdash;{" "}
          <code className="text-xs text-text-secondary font-mono">/runs/wait</code>,{" "}
          <code className="text-xs text-text-secondary font-mono">/runs/stream</code>,{" "}
          <code className="text-xs text-text-secondary font-mono">assistant_id</code> routing. What
          runs locally deploys without translation.
        </p>
      </div>
    </section>
  )
}
