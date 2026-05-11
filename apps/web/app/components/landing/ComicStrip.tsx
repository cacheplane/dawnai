import type { ReactNode } from "react"

// Placeholder stick-figure illustrations for v1. Each panel is a simple
// monochrome amber-stroke SVG. Swap these out for commissioned cartoony art
// in a follow-up commit — the structure here is stable enough to swap visuals
// without touching the dialog/layout.

function Panel1SVG() {
  return (
    <svg viewBox="0 0 200 140" fill="none" stroke="currentColor" strokeWidth="1.5">
      <title>Frustrated developer at a cluttered desk</title>
      {/* Desk */}
      <line x1="30" y1="100" x2="170" y2="100" />
      {/* Monitor */}
      <rect x="60" y="50" width="80" height="50" rx="2" />
      {/* Boilerplate code lines on monitor */}
      <line x1="68" y1="62" x2="120" y2="62" strokeWidth="1" />
      <line x1="68" y1="70" x2="130" y2="70" strokeWidth="1" />
      <line x1="68" y1="78" x2="115" y2="78" strokeWidth="1" />
      <line x1="68" y1="86" x2="125" y2="86" strokeWidth="1" />
      {/* Developer (stick figure) */}
      <circle cx="100" cy="28" r="8" />
      <line x1="100" y1="36" x2="100" y2="55" />
      {/* Frown */}
      <path d="M 96 28 Q 100 31 104 28" />
      {/* Sad eyebrows */}
      <line x1="94" y1="24" x2="98" y2="26" strokeWidth="1" />
      <line x1="102" y1="26" x2="106" y2="24" strokeWidth="1" />
    </svg>
  )
}

function Panel2SVG() {
  return (
    <svg viewBox="0 0 200 140" fill="none" stroke="currentColor" strokeWidth="1.5">
      <title>Developer with head in hands</title>
      {/* Desk */}
      <line x1="30" y1="100" x2="170" y2="100" />
      {/* Developer head */}
      <circle cx="100" cy="50" r="14" />
      {/* Hands covering face */}
      <path d="M 86 50 Q 92 60 100 58 Q 108 60 114 50" />
      {/* Arms going up to head */}
      <line x1="84" y1="52" x2="76" y2="78" />
      <line x1="116" y1="52" x2="124" y2="78" />
      {/* Body slumped */}
      <line x1="100" y1="64" x2="100" y2="98" />
    </svg>
  )
}

function Panel3SVG() {
  return (
    <svg viewBox="0 0 200 140" fill="none" stroke="currentColor" strokeWidth="1.5">
      <title>Second developer entering with a coffee mug</title>
      {/* Desk */}
      <line x1="30" y1="100" x2="170" y2="100" />
      {/* Dev A still at desk */}
      <circle cx="70" cy="50" r="8" />
      <line x1="70" y1="58" x2="70" y2="92" />
      <line x1="70" y1="92" x2="60" y2="100" />
      <line x1="70" y1="92" x2="80" y2="100" />
      {/* Monitor */}
      <rect x="50" y="58" width="40" height="28" rx="2" />
      {/* Dev B entering, holding mug */}
      <circle cx="140" cy="50" r="9" />
      {/* Smile */}
      <path d="M 136 52 Q 140 56 144 52" />
      <line x1="140" y1="59" x2="140" y2="92" />
      <line x1="140" y1="92" x2="130" y2="100" />
      <line x1="140" y1="92" x2="150" y2="100" />
      {/* Arm with mug */}
      <line x1="140" y1="68" x2="124" y2="74" />
      <rect x="116" y="68" width="10" height="10" rx="1" />
      {/* Steam */}
      <path d="M 119 64 Q 120 60 121 64" strokeWidth="1" />
      <path d="M 123 64 Q 124 60 125 64" strokeWidth="1" />
    </svg>
  )
}

function Panel4SVG() {
  return (
    <svg viewBox="0 0 200 140" fill="none" stroke="currentColor" strokeWidth="1.5">
      <title>Developer looking at a clean three-file project</title>
      {/* Desk */}
      <line x1="30" y1="120" x2="170" y2="120" />
      {/* Monitor */}
      <rect x="55" y="45" width="90" height="65" rx="2" />
      {/* Three-file tree on monitor */}
      <line x1="65" y1="60" x2="80" y2="60" strokeWidth="1" />
      <line x1="70" y1="72" x2="115" y2="72" strokeWidth="1" />
      <line x1="70" y1="84" x2="118" y2="84" strokeWidth="1" />
      <line x1="70" y1="96" x2="105" y2="96" strokeWidth="1" />
      {/* Developer (above the monitor area, slightly raised eyebrows) */}
      <circle cx="100" cy="25" r="7" />
      {/* Surprised mouth */}
      <circle cx="100" cy="27" r="2" />
      {/* Raised eyebrows */}
      <line x1="94" y1="20" x2="98" y2="19" strokeWidth="1" />
      <line x1="102" y1="19" x2="106" y2="20" strokeWidth="1" />
      <line x1="100" y1="32" x2="100" y2="45" />
    </svg>
  )
}

interface Panel {
  readonly speaker: "Dev A" | "Dev B"
  readonly line: string
  readonly illustration: ReactNode
}

const PANELS: readonly Panel[] = [
  { speaker: "Dev A", line: "Fifth StateGraph this month.", illustration: <Panel1SVG /> },
  {
    speaker: "Dev A",
    line: "This isn't agent code. This is project structure.",
    illustration: <Panel2SVG />,
  },
  {
    speaker: "Dev B",
    line: "You know Next.js, right? Same thing for LangGraph.",
    illustration: <Panel3SVG />,
  },
  { speaker: "Dev A", line: "…wait, that's it?", illustration: <Panel4SVG /> },
]

export function ComicStrip() {
  return (
    <section className="relative py-20 px-8">
      <div className="text-center max-w-2xl mx-auto mb-12">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          Meanwhile…
        </p>
      </div>

      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {PANELS.map((p) => (
          <div key={p.line} className="landing-surface border border-border-subtle rounded-lg p-5">
            <div className="aspect-[200/140] flex items-center justify-center text-accent-amber mb-4">
              {p.illustration}
            </div>
            <p className="text-sm leading-relaxed">
              <strong className="text-text-primary font-medium">{p.speaker}:</strong>{" "}
              <span className="landing-text-muted">{p.line}</span>
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
