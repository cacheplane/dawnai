import { Card } from "../ui/Card"
import { Eyebrow } from "../ui/Eyebrow"

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
  "Dawn does not replace LangGraph.js — agent routes materialize LangGraph graphs.",
  "Dawn does not proxy provider calls — raw graph and chain routes use the clients you instantiate.",
  "Dawn does not host your agents — it emits artifacts for your deployment target.",
  "Dawn does not wrap raw graph and chain exports in a proprietary runtime format.",
]

export function KeepTheRuntime() {
  return (
    <section className="bg-surface border-b border-divider">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-20 md:py-28">
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
              Node and Hono targets are Dawn HTTP runtimes; the LangSmith target emits graph
              entries. Agent routes materialize LangGraph graphs, while workflows keep their
              authored function shape and raw graph and chain exports remain portable. You can still
              drop into raw{" "}
              <code className="text-sm font-mono text-ink bg-page px-1.5 py-0.5 rounded border border-divider">
                StateGraph
              </code>{" "}
              where you need direct control.
            </p>
            <p>
              Your raw graphs stay valid LangGraph.js, and graph and chain routes keep the provider
              clients you instantiate. Dawn supplies the route and target boundaries around that
              code without replacing it.
            </p>
          </div>

          <Card className="p-6 md:p-7">
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-dim">
              What Dawn does <span className="text-ink">not</span> do
            </p>
            <ul className="mt-4 space-y-3">
              {NOT_DOING.map((line) => (
                <li key={line} className="flex items-start gap-2.5 text-sm text-ink leading-[22px]">
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
