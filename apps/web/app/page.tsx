import Link from "next/link";

const pillars = [
  {
    title: "Filesystem conventions",
    body: "Dawn owns discovery, validation, and type generation so apps stay predictable across routes and teams.",
  },
  {
    title: "Native-first runtime",
    body: "Route entrypoints stay close to LangGraph and LangChain instead of getting hidden behind a second runtime.",
  },
  {
    title: "One repo, clear surfaces",
    body: "The website, CLI, and framework packages live together but keep separate responsibilities and release boundaries.",
  },
];

const quickLinks = [
  {
    href: "/docs/getting-started",
    title: "Getting started",
    body: "Install the workspace, scaffold a basic app, and learn the Dawn app contract.",
  },
  {
    href: "/docs/app-graph",
    title: "App Graph",
    body: "Understand the documentation term Dawn uses for route ownership and graph-shaped app structure.",
  },
  {
    href: "/docs/packages",
    title: "Packages",
    body: "See how `@dawn/*` packages and `create-dawn-app` divide responsibilities.",
  },
];

export default function HomePage() {
  return (
    <div className="page-stack">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">TypeScript-first framework</p>
          <h1>Build graph-shaped agent systems without inventing a second runtime.</h1>
          <p className="hero-body">
            Dawn gives agent apps a clear filesystem contract, predictable local tooling, and
            room to stay native at the route boundary.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/docs/getting-started">
              Read the docs
            </Link>
            <Link className="button button-secondary" href="/docs/app-graph">
              Learn App Graph
            </Link>
          </div>
        </div>

        <aside className="hero-panel">
          <p className="panel-label">Current focus</p>
          <ul className="compact-list">
            <li>Marketing and docs site</li>
            <li>`dawn` CLI</li>
            <li>`@dawn/core` discovery and type generation</li>
            <li>`create-dawn-app` basic scaffold</li>
          </ul>
        </aside>
      </section>

      <section className="section-grid">
        {pillars.map((pillar) => (
          <article className="card" key={pillar.title}>
            <h2>{pillar.title}</h2>
            <p>{pillar.body}</p>
          </article>
        ))}
      </section>

      <section className="section-split">
        <div>
          <p className="eyebrow">Why Dawn</p>
          <h2>Opinionated at the filesystem boundary. Conservative at runtime.</h2>
          <p>
            Dawn is designed to own conventions like route discovery, config loading, validation,
            and generated route types. The graph logic itself should remain legible in native
            LangGraph constructs.
          </p>
        </div>

        <div className="card inset-card">
          <p className="panel-label">Public naming</p>
          <ul className="compact-list">
            <li>`dawn` is the product, repo, and CLI name.</li>
            <li>`App Graph` is the documentation term for the architecture concept.</li>
            <li>`@dawn/*` is the framework package scope.</li>
            <li>`create-dawn-app` remains intentionally unscoped.</li>
          </ul>
        </div>
      </section>

      <section className="section-grid">
        {quickLinks.map((item) => (
          <Link className="card card-link" href={item.href} key={item.href}>
            <h2>{item.title}</h2>
            <p>{item.body}</p>
            <span className="link-hint">Open page</span>
          </Link>
        ))}
      </section>
    </div>
  );
}
