import { Eyebrow } from "../ui/Eyebrow"

export function WhyDawn() {
  return (
    <section className="bg-page border-b border-divider">
      <div className="max-w-[820px] mx-auto px-6 md:px-8 py-20 md:py-28">
        <Eyebrow>Why Dawn</Eyebrow>
        <h2
          className="font-display font-semibold text-ink mt-3 text-[32px] leading-[38px] md:text-[44px] md:leading-[50px]"
          style={{
            fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
            letterSpacing: "-0.01em",
          }}
        >
          LangGraph is powerful. Writing real agents in it is tedious.
        </h2>

        <div className="mt-8 space-y-5 text-lg text-ink-muted leading-[30px] max-w-[64ch]">
          <p>
            LangGraph.js gives you a graph runtime, durable state, and a production-grade execution
            model — the right primitives. What it doesn't give you is structure. Real agents drift
            into a single file, hand-rolled tool plumbing, types that don't follow the data, and a
            dev loop that means restarting the graph every time you change a prompt.
          </p>
          <p>
            Dawn is a meta-framework for LangGraph in the same shape Next.js is for React.
            File-system routes for agents, shared and route-local tools with inferred argument
            types, end-to-end generated types from your state schema, and a dev server that keeps
            persisted state available across child-runtime restarts.
          </p>
          <p>
            <strong className="text-ink font-medium">
              Dawn includes Node and Hono HTTP runtimes, but it is not an LLM router or hosted
              cloud.
            </strong>{" "}
            The LangSmith target emits graph entries, and raw graph and chain exports stay portable.
            Your model calls and deployment target stay yours.
          </p>
        </div>
      </div>
    </section>
  )
}
