import { Eyebrow } from "../ui/Eyebrow"
import { Card } from "../ui/Card"

function XIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
      className="w-4 h-4 mt-1 text-ink-dim shrink-0"
    >
      <path d="M4 4l8 8M12 4L4 12" strokeLinecap="round" />
    </svg>
  )
}

const NOT_DOING = [
  "Dawn is not a runtime — your graphs run on LangGraph.js, full stop.",
  "Dawn does not mediate model calls — you talk to OpenAI / Anthropic / your provider directly.",
  "Dawn does not host your agents — deploy anywhere Node runs.",
  "Dawn does not lock you in — eject to raw StateGraph at any time without rewriting.",
]

export function KeepTheRuntime() {
  return (
    <section className="bg-surface border-b border-divider">
      <div className="max-w-[1100px] mx-auto px-6 md:px-8 py-20 md:py-28">
        <Eyebrow>Compatibility</Eyebrow>
        <h2
          className="font-display font-semibold text-ink mt-3 text-[32px] leading-[38px] md:text-[44px] md:leading-[50px] max-w-[20ch]"
          style={{
            fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
            letterSpacing: "-0.01em",
          }}
        >
          Your bet on LangGraph.js stays your bet.
        </h2>

        <div className="mt-8 grid lg:grid-cols-[1.2fr_1fr] gap-10 lg:gap-16">
          <div className="space-y-5 text-lg text-ink-muted leading-[30px] max-w-[58ch]">
            <p>
              Dawn compiles to LangGraph constructs. Routes become nodes, tools
              become callable bindings, state becomes a typed channel. You can
              read the generated graph, drop into raw{" "}
              <code className="text-sm font-mono text-ink bg-page px-1.5 py-0.5 rounded border border-divider">
                StateGraph
              </code>{" "}
              for any node, or swap a Dawn route for a hand-written one without
              touching the rest of your app.
            </p>
            <p>
              If Dawn disappears tomorrow, your graphs are still valid
              LangGraph.js. Your model calls are still your model calls. Your
              deployment target is still yours. Dawn is the scaffolding between
              you and the runtime — not a replacement for it.
            </p>
          </div>

          <Card className="p-6 md:p-7">
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-dim">
              What Dawn does <span className="text-ink">not</span> do
            </p>
            <ul className="mt-4 space-y-3">
              {NOT_DOING.map((line) => (
                <li
                  key={line}
                  className="flex items-start gap-2.5 text-sm text-ink leading-[22px]"
                >
                  <XIcon />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </section>
  )
}
