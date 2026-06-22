import { Card } from "../ui/Card"
import { Eyebrow } from "../ui/Eyebrow"

const PAYOFFS = [
  "Threads survive a dawn dev restart — no lost state between edits.",
  "Agents that pause for human input resume exactly where they left off.",
  "A working SQLite checkpointer and thread store ship by default — zero setup.",
] as const

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
      className="w-4 h-4 mt-1 text-accent-saas shrink-0"
    >
      <path d="M3 8.5l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function DurableByDefault() {
  return (
    <section className="bg-page border-b border-divider">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-20 md:py-28">
        <Eyebrow>Durability</Eyebrow>
        <h2
          className="font-display font-semibold text-ink mt-3 text-[32px] leading-[38px] md:text-[44px] md:leading-[50px] max-w-[20ch]"
          style={{
            fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
            letterSpacing: "-0.01em",
          }}
        >
          Durable by default.
        </h2>

        <div className="mt-8 grid lg:grid-cols-[1.2fr_1fr] gap-10 lg:gap-16">
          <div className="space-y-5 text-lg text-ink-muted leading-[30px] max-w-[58ch]">
            <p>
              Every Dawn app ships a working checkpointer and thread store — no setup. Runs
              checkpoint to SQLite between turns, so threads survive a{" "}
              <code className="text-sm font-mono text-ink bg-surface px-1.5 py-0.5 rounded border border-divider">
                dawn dev
              </code>{" "}
              restart and an agent that pauses for human input resumes exactly where it left off.
            </p>
            <p>
              LangGraph defines the checkpoint interface; Dawn ships the default implementation. So
              durability is the path of least resistance — not a wiring task.
            </p>
          </div>

          <Card className="p-6 md:p-7">
            <ul className="space-y-3">
              {PAYOFFS.map((line) => (
                <li key={line} className="flex items-start gap-2.5 text-sm text-ink leading-[22px]">
                  <CheckIcon />
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
