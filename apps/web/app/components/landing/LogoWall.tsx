interface Logo {
  readonly name: string
  readonly colorClass: string
  readonly mark: React.ReactNode
  readonly href?: string
}

function LangChainMark() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      role="img"
      aria-hidden
    >
      <title>LangChain</title>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

function TypeScriptMark() {
  return (
    <span
      className="inline-flex items-center justify-center w-4 h-4 rounded-[3px] font-mono text-[9px] font-bold"
      style={{ background: "currentColor" }}
    >
      <span className="text-bg-primary">TS</span>
    </span>
  )
}

function ViteMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" role="img" aria-hidden>
      <title>Vite</title>
      <path d="M2 2 L22 2 L12 22 Z" opacity="0.9" />
    </svg>
  )
}

function NodeMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" role="img" aria-hidden>
      <title>Node.js</title>
      <path d="M12 2 L22 8 L22 16 L12 22 L2 16 L2 8 Z" opacity="0.85" />
    </svg>
  )
}

function LangGraphMark() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      role="img"
      aria-hidden
    >
      <title>LangGraph</title>
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M7 6h10" />
      <path d="M6 8l6 8" />
      <path d="M18 8l-6 8" />
    </svg>
  )
}

function LangSmithMark() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      role="img"
      aria-hidden
    >
      <title>LangSmith</title>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

const LOGOS: readonly Logo[] = [
  { name: "LangChain", colorClass: "text-accent-green", mark: <LangChainMark /> },
  { name: "LangGraph", colorClass: "text-accent-green", mark: <LangGraphMark /> },
  { name: "LangSmith", colorClass: "text-accent-green", mark: <LangSmithMark /> },
  { name: "TypeScript", colorClass: "text-accent-blue", mark: <TypeScriptMark /> },
  { name: "Vite", colorClass: "text-accent-purple", mark: <ViteMark /> },
  { name: "Node.js", colorClass: "text-[#8cc84b]", mark: <NodeMark /> },
]

export function LogoWall() {
  return (
    <section className="relative px-8 py-10" style={{ background: "#020617" }}>
      <div className="max-w-5xl mx-auto">
        <p className="text-center text-xs uppercase tracking-widest text-text-muted mb-6">
          Built on
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
          {LOGOS.map((logo) => (
            <span
              key={logo.name}
              className={`inline-flex items-center gap-2 text-sm font-semibold ${logo.colorClass} opacity-60 hover:opacity-100 transition-opacity`}
            >
              <span className="shrink-0">{logo.mark}</span>
              {logo.name}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
