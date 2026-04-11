export default function AppGraphPage() {
  return (
    <article className="docs-article">
      <p className="eyebrow">App Graph</p>
      <h2>A documentation term for route ownership, not a replacement runtime.</h2>
      <p>
        Dawn uses <strong>App Graph</strong> to explain how route directories, entry files, and
        support assets fit together inside an agent application. It describes structure and
        ownership boundaries. It does not describe a proprietary execution engine.
      </p>

      <div className="section-grid docs-grid">
        <div className="card">
          <h3>Filesystem-owned by Dawn</h3>
          <p>
            Discovery and validation center on files like `route.ts`, `graph.ts`, `workflow.ts`,
            `state.ts`, `middleware.ts`, `memory.ts`, `ui/`, `approvals/`, and `evals/`.
          </p>
        </div>

        <div className="card">
          <h3>Runtime-owned by native libraries</h3>
          <p>
            LangGraph and LangChain remain the primary runtime concepts. Dawn should help authoring
            without forcing valid native graph code into a custom DSL.
          </p>
        </div>
      </div>

      <pre className="code-block">
        <code>{`src/app/(public)/support/[tenant]/
  route.ts
  graph.ts
  state.ts
  ui/
  approvals/`}</code>
      </pre>

      <p>
        Route-group folders such as `(public)` help organize ownership without changing the public
        pathname. Dynamic segments like `[tenant]`, `[...path]`, and `[[...path]]` stay visible in
        route metadata.
      </p>
    </article>
  )
}
