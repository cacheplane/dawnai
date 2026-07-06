import { Accordion } from "../ui/Accordion"
import { Eyebrow } from "../ui/Eyebrow"

const ITEMS = [
  {
    id: "production-ready",
    question: "Is Dawn production-ready?",
    answer: (
      <p>
        Dawn is pre-1.0. The framework's surface API is stabilizing, and the types and dev-loop
        layers are in active use on internal projects. Run replay evals and harness tests against a
        representative route before adopting Dawn for production work, and use live evals locally
        when you need real-model signal. The runtime — LangGraph.js — is production-grade today, and
        Dawn does not change its execution model.
      </p>
    ),
  },
  {
    id: "langgraph-relationship",
    question: "What's the relationship to LangGraph.js?",
    answer: (
      <p>
        Dawn is a meta-framework. LangGraph.js is the runtime that actually executes your agents.
        Dawn discovers routes, tools, and state, then writes LangGraph-compatible deployment
        artifacts at build time. You can drop into raw LangGraph by named-exporting a graph route
        whenever you need direct control.
      </p>
    ),
  },
  {
    id: "shipped-capabilities",
    question: "What agent capabilities ship today?",
    answer: (
      <p>
        Routing, tools, generated types, the dev loop, planning, skills, memory, subagents, opt-in
        sandboxing, replay/live evals, and testing helpers are shipped. The current testing harness
        runs agent routes in-process; the standalone Agent Protocol injector and subprocess helpers
        are available for custom orchestration, but those are not harness modes. Everything ships
        incrementally on main with semver-honest releases.
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
        Yes, with the deployment target doing the runtime work. `dawn build` produces
        LangGraph-compatible entry files and `langgraph.json`; LangSmith can consume those directly,
        and self-hosted setups should run the generated artifacts in their own LangGraph runtime.
        Dawn doesn't introduce a hosting dependency.
      </p>
    ),
  },
  {
    id: "langsmith",
    question: "How does Dawn affect our LangSmith / observability setup?",
    answer: (
      <p>
        Dawn does not proxy LangSmith. Raw graph and chain routes keep whatever tracing setup you
        already configure through LangGraph or LangChain. The local Dawn dev server also loads
        LangSmith tracing env vars when present.
      </p>
    ),
  },
  {
    id: "cost",
    question: "What does Dawn cost?",
    answer: (
      <p>
        Nothing. Dawn is MIT-licensed open source with no paid tier, no usage meter, no hosted
        service to sign up for. The built-in `agent()` route materializes to a LangChain chat model
        and can infer known provider families; raw graph and chain routes can instantiate providers
        directly. Provider and deployment costs are yours and flow directly to the services you
        choose.
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
