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
            Each route directory exposes a single `index.ts` that exports exactly one of `workflow`
            or `graph`.
          </li>
        </ul>
      </div>

      <div className="callout">
        <p className="panel-label">supported dawn.config.ts subset</p>
        <p>
          The current parser only supports a narrow `dawn.config.ts` shape. For v0, treat it as a
          small config file that either exports an empty object or sets `appDir` with a string
          binding.
        </p>
        <pre className="code-block">
          <code>{`const appDir = "src/custom-app"
export default { appDir }`}</code>
        </pre>
        <p>
          That means `appDir` is the only supported option today. Helper wrappers, computed config,
          and arbitrary TypeScript expressions are outside the supported dawn.config.ts subset until
          the config loader grows beyond this bootstrap syntax.
        </p>
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

      <p>
        There are two scaffold paths to keep straight. The repo build above is a bootstrap-local
        workflow for Dawn contributors. External users should prefer the published `create-dawn-app`
        package, which defaults to published package specifiers rather than monorepo-local paths.
      </p>
    </article>
  )
}
