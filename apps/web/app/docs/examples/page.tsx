export default function ExamplesPage() {
  return (
    <article className="docs-article">
      <p className="eyebrow">Examples</p>
      <h2>Examples should teach the contract, not hide it.</h2>
      <p>
        The initial repo keeps examples concise. The current scaffold path is the `basic` template,
        which shows the minimum Dawn app structure without layering on deployment or orchestration
        abstractions that are still out of scope.
      </p>

      <div className="callout">
        <p className="panel-label">What examples should make obvious</p>
        <ul className="compact-list">
          <li>Where `dawn.config.ts` lives.</li>
          <li>How routes are discovered from `src/app`.</li>
          <li>
            How each route&apos;s `index.ts` exports a single `workflow` or `graph` for execution.
          </li>
          <li>How support folders like `ui/`, `approvals/`, and `evals/` stay colocated.</li>
        </ul>
      </div>

      <p>
        As the repo grows, the docs can add more worked examples around App Graph route patterns.
        For now, the goal is clarity over breadth.
      </p>
    </article>
  )
}
