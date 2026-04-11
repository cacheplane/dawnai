export default function GettingStartedPage() {
  return (
    <article className="docs-article">
      <p className="eyebrow">Getting started</p>
      <h2>Start from the monorepo, then scaffold a Dawn app when you need one.</h2>
      <p>
        Dawn itself is a workspace that contains the website, the CLI, and publishable framework
        packages. A Dawn application is a separate project root with a `package.json`,
        `dawn.config.ts`, and route discovery under `src/app`.
      </p>

      <div className="callout">
        <p className="panel-label">Canonical app contract</p>
        <ul className="compact-list">
          <li>App root contains `package.json` and `dawn.config.ts`.</li>
          <li>Route discovery starts at `src/app`.</li>
          <li>
            Each route directory exposes exactly one primary executable entry: `graph.ts` or
            `workflow.ts`.
          </li>
        </ul>
      </div>

      <pre className="code-block">
        <code>{`pnpm install
pnpm --filter create-dawn-app build
node packages/create-dawn-app/dist/index.js my-dawn-app --template basic`}</code>
      </pre>

      <p>
        The first scaffold path is intentionally small. It gives you a basic app shape while the
        repo continues to define discovery, validation, and type generation around that contract.
      </p>
    </article>
  )
}
