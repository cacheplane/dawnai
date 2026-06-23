import { Card } from "../ui/Card"
import { Eyebrow } from "../ui/Eyebrow"

const SHAPES = [
  {
    name: "agent",
    tagline: "Let the model decide.",
    body: "An LLM-driven route that picks tools at runtime and can pause for a human. Reach for it when you want the model to choose what to do.",
  },
  {
    name: "workflow",
    tagline: "You own the order.",
    body: "A deterministic, typed async function. Reach for it when you control the sequence of operations and want predictable, step-by-step execution.",
  },
] as const

export function DriveTheModel() {
  return (
    <section className="bg-surface border-b border-divider">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-20 md:py-28">
        <Eyebrow>Route shapes</Eyebrow>
        <h2
          className="font-display font-semibold text-ink mt-3 text-[32px] leading-[38px] md:text-[44px] md:leading-[50px] max-w-[22ch]"
          style={{
            fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
            letterSpacing: "-0.01em",
          }}
        >
          Two ways to drive the model.
        </h2>

        <p className="mt-5 text-lg text-ink-muted leading-[30px] max-w-[60ch]">
          Same routing, same types, same dev loop — you choose who's in charge. A route's{" "}
          <code className="text-sm font-mono text-ink bg-page px-1.5 py-0.5 rounded border border-divider">
            index.ts
          </code>{" "}
          exports exactly one shape.
        </p>

        <div className="mt-10 grid sm:grid-cols-2 gap-6">
          {SHAPES.map((s) => (
            <Card key={s.name} className="p-6 md:p-7">
              <code className="text-sm font-mono font-semibold text-accent-saas">{s.name}</code>
              <p className="mt-3 text-base font-medium text-ink">{s.tagline}</p>
              <p className="mt-2 text-sm text-ink-muted leading-[22px]">{s.body}</p>
            </Card>
          ))}
        </div>

        <p className="mt-6 text-sm text-ink-dim leading-[22px] max-w-[60ch]">
          Need raw LangGraph? Export a{" "}
          <code className="text-xs font-mono text-ink-muted">graph</code> or{" "}
          <code className="text-xs font-mono text-ink-muted">chain</code> and instantiate anything
          you want.
        </p>
      </div>
    </section>
  )
}
