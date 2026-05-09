interface DeployStep {
  readonly label: string
  readonly description: string
  readonly items: readonly string[]
  readonly accent: boolean
}

const STEPS: readonly DeployStep[] = [
  {
    label: "Develop",
    description: "Local dev server with HMR. Real CLI for running, testing, and inspecting.",
    items: ["dawn dev", "dawn run", "dawn test"],
    accent: false,
  },
  {
    label: "Validate",
    description:
      "Static checks before you push. Type-safe routes, generated types, route registry.",
    items: ["dawn check", "dawn typegen", "dawn routes"],
    accent: false,
  },
  {
    label: "Deploy",
    description: "Your routes already speak the LangGraph Platform protocol. No translation layer.",
    items: ["LangGraph Platform", "LangSmith Assistants", "Your infrastructure"],
    accent: true,
  },
]

function DevelopIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
    >
      <title>Develop</title>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  )
}

function ValidateIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
    >
      <title>Validate</title>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  )
}

function DeployIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
    >
      <title>Deploy</title>
      <path d="M22 2L11 13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

const ICONS = [DevelopIcon, ValidateIcon, DeployIcon] as const

export function DeploySection() {
  return (
    <section className="py-36 px-8 border-t landing-border">
      <div className="text-center max-w-2xl mx-auto mb-14">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          The deploy story
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

      {/* Pipeline cards */}
      <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr] gap-4 md:gap-0 items-stretch">
        {STEPS.map((step, i) => {
          const Icon = ICONS[i]
          if (!Icon) return null
          return (
            <DeployStepBlock
              key={step.label}
              step={step}
              Icon={Icon}
              arrowAfter={i < STEPS.length - 1}
            />
          )
        })}
      </div>

      {/* Protocol note */}
      <div
        className="max-w-[640px] mx-auto mt-10 rounded-lg px-5 py-4 flex gap-4 items-start"
        style={{
          background: "rgba(217,119,6,0.06)",
          border: "1px solid rgba(217,119,6,0.18)",
        }}
      >
        <span className="text-accent-amber-deep text-base mt-0.5">&#9432;</span>
        <p className="text-sm landing-text leading-relaxed">
          Dawn&apos;s dev server speaks the{" "}
          <span className="font-semibold landing-text">LangGraph Platform protocol</span> natively
          &mdash;{" "}
          <code
            className="text-xs font-mono px-1.5 py-0.5 rounded"
            style={{ background: "var(--landing-surface)", color: "var(--landing-fg)" }}
          >
            /runs/wait
          </code>
          ,{" "}
          <code
            className="text-xs font-mono px-1.5 py-0.5 rounded"
            style={{ background: "var(--landing-surface)", color: "var(--landing-fg)" }}
          >
            /runs/stream
          </code>
          ,{" "}
          <code
            className="text-xs font-mono px-1.5 py-0.5 rounded"
            style={{ background: "var(--landing-surface)", color: "var(--landing-fg)" }}
          >
            assistant_id
          </code>{" "}
          routing. What runs locally deploys without translation.
        </p>
      </div>
    </section>
  )
}

interface BlockProps {
  readonly step: DeployStep
  readonly Icon: () => React.ReactElement
  readonly arrowAfter: boolean
}

function DeployStepBlock({ step, Icon, arrowAfter }: BlockProps) {
  return (
    <>
      <div
        className="rounded-xl p-6 flex flex-col items-start text-left h-full"
        style={
          step.accent
            ? {
                background:
                  "linear-gradient(180deg, rgba(254,244,230,1) 0%, rgba(255,232,184,1) 100%)",
                border: "1px solid rgba(217,119,6,0.35)",
                boxShadow: "0 8px 24px -12px rgba(217,119,6,0.25)",
              }
            : {
                background: "var(--landing-surface)",
                border: "1px solid var(--landing-border)",
              }
        }
      >
        <div
          className="w-12 h-12 rounded-[10px] flex items-center justify-center mb-4"
          style={
            step.accent
              ? { background: "rgba(217,119,6,0.15)", color: "#d97706" }
              : {
                  background: "var(--landing-bg)",
                  border: "1px solid var(--landing-border)",
                  color: "var(--landing-fg)",
                }
          }
        >
          <Icon />
        </div>
        <p
          className="text-base font-semibold mb-1.5"
          style={step.accent ? { color: "#21180c" } : undefined}
        >
          <span className={step.accent ? "" : "landing-text"}>{step.label}</span>
        </p>
        <p
          className="text-[13px] leading-relaxed mb-4"
          style={step.accent ? { color: "#6d5638" } : undefined}
        >
          <span className={step.accent ? "" : "landing-text-muted"}>{step.description}</span>
        </p>
        <ul className="flex flex-col gap-1.5 w-full mt-auto">
          {step.items.map((item) => (
            <li
              key={item}
              className="font-mono text-[12.5px] px-2.5 py-1 rounded inline-block"
              style={
                step.accent
                  ? { background: "rgba(217,119,6,0.08)", color: "#21180c" }
                  : {
                      background: "var(--landing-bg)",
                      color: "var(--landing-fg)",
                      border: "1px solid var(--landing-border)",
                    }
              }
            >
              {item}
            </li>
          ))}
        </ul>
      </div>
      {arrowAfter && (
        <div
          className="hidden md:flex items-center justify-center px-4 text-accent-amber-deep"
          aria-hidden
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            role="img"
          >
            <title>arrow right</title>
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </div>
      )}
    </>
  )
}
