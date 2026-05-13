import { Eyebrow } from "../ui/Eyebrow"

export function WhyDawn() {
  return (
    <section className="bg-page border-b border-divider">
      <div className="max-w-[920px] mx-auto px-6 md:px-8 py-20 md:py-28">
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
            File-system routes for agents, route-local tools with inferred argument types,
            end-to-end generated types from your state schema, and an HMR dev server that doesn't
            lose graph state between edits.
          </p>
          <p>
            <strong className="text-ink font-medium">
              Dawn is not a runtime, an LLM router, or a hosting product.
            </strong>{" "}
            Your graphs stay valid LangGraph code. Your model calls stay your model calls. Your
            deployment target stays yours. Dawn is the scaffolding between you and the runtime.
          </p>
        </div>
      </div>
    </section>
  )
}
