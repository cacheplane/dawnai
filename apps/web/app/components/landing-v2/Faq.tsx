import { Accordion } from "../ui/Accordion"
import { Eyebrow } from "../ui/Eyebrow"

const ITEMS = [
  {
    id: "production-ready",
    question: "Is Dawn production-ready?",
    answer: (
      <p>
        Dawn is pre-1.0. The framework's surface API is stabilizing, and the types and dev-loop
        layers are in active use on internal projects. We recommend running an evaluation against a
        representative graph before adopting Dawn for production work. The runtime — LangGraph.js —
        is production-grade today, and Dawn does not change its execution model.
      </p>
    ),
  },
  {
    id: "langgraph-relationship",
    question: "What's the relationship to LangGraph.js?",
    answer: (
      <p>
        Dawn is a meta-framework. LangGraph.js is the runtime that actually executes your agents.
        Dawn compiles routes, tools, and state into LangGraph constructs at build time. You can read
        the generated StateGraph, drop into raw LangGraph for any node, or eject entirely — your
        graphs are valid LangGraph code without Dawn.
      </p>
    ),
  },
  {
    id: "deep-agents-roadmap",
    question: "What about Deep Agents and other planned features?",
    answer: (
      <p>
        Phases 1 and 2 — routing, tools, types, dev loop — are shipped. Phase 3, Deep Agents
        (multi-step planning, sub-agents, durable evaluation harness), is on the roadmap and not yet
        started. Expect concrete proposals before implementation; everything ships incrementally on
        main with semver-honest releases.
      </p>
    ),
  },
  {
    id: "maintainers",
    question: "Who maintains Dawn? What's the release cadence?",
    answer: (
      <p>
        Dawn is maintained by Brian Love and the contributors listed on the GitHub repo. Releases
        ship under changesets on main; minor releases roughly every two to three weeks, patch
        releases as needed. Breaking changes go through deprecation periods documented in the
        changelog.
      </p>
    ),
  },
  {
    id: "license",
    question: "What license is Dawn under?",
    answer: (
      <p>
        MIT. Free for commercial and non-commercial use. See the{" "}
        <a
          href="https://github.com/cacheplane/dawnai/blob/main/LICENSE"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-saas hover:opacity-80"
        >
          LICENSE file
        </a>{" "}
        for the full text.
      </p>
    ),
  },
  {
    id: "hosted-langgraph",
    question: "Can we use Dawn with hosted LangGraph platforms?",
    answer: (
      <p>
        Yes. Dawn produces standard LangGraph.js graphs that you can deploy anywhere LangGraph runs
        — your own infrastructure, LangChain's hosted platform, or a serverless target. Dawn doesn't
        introduce a hosting dependency.
      </p>
    ),
  },
  {
    id: "langsmith",
    question: "How does Dawn affect our LangSmith / observability setup?",
    answer: (
      <p>
        Unchanged. Dawn-compiled graphs report to LangSmith (and any OpenTelemetry-compatible
        observability tool) using the same hooks LangGraph already provides. You don't reconfigure
        tracing because you're using Dawn.
      </p>
    ),
  },
  {
    id: "cost",
    question: "What does Dawn cost?",
    answer: (
      <p>
        Nothing. Dawn is MIT-licensed open source with no paid tier, no usage meter, no hosted
        service to sign up for. You bring your own model provider and your own deployment target —
        those costs are yours and flow directly to the providers you choose.
      </p>
    ),
  },
  {
    id: "migration",
    question: "How do we migrate an existing LangGraph graph to Dawn?",
    answer: (
      <p>
        Most migrations move state into a single Zod schema, then re-express nodes as route files
        and tool functions inside a route directory. The{" "}
        <a href="/docs/migrating-from-langgraph" className="text-accent-saas hover:opacity-80">
          migration guide
        </a>{" "}
        walks through a representative example; the dev loop is forgiving enough to iterate one node
        at a time.
      </p>
    ),
  },
]

export function Faq() {
  return (
    <section className="bg-page border-b border-divider">
      <div className="max-w-[820px] mx-auto px-6 md:px-8 py-20 md:py-28">
        <Eyebrow>FAQ</Eyebrow>
        <h2
          className="font-display font-semibold text-ink mt-3 text-[32px] leading-[38px] md:text-[44px] md:leading-[50px]"
          style={{
            fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
            letterSpacing: "-0.01em",
          }}
        >
          Things people ask before adopting Dawn.
        </h2>
        <div className="mt-10">
          <Accordion items={ITEMS} defaultOpenId="production-ready" />
        </div>
      </div>
    </section>
  )
}
