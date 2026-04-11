import Link from "next/link"

const sections = [
  {
    href: "/docs/getting-started",
    title: "Getting started",
    body: "The minimum shape of a Dawn app and the fastest path into the repo.",
  },
  {
    href: "/docs/app-graph",
    title: "App Graph",
    body: "The ownership model Dawn documents for routes, entrypoints, and app structure.",
  },
  {
    href: "/docs/packages",
    title: "Packages",
    body: "What each package in the monorepo is responsible for and why the boundaries matter.",
  },
  {
    href: "/docs/cli",
    title: "CLI",
    body: "The current `dawn` commands and how they compose core discovery and type generation.",
  },
  {
    href: "/docs/examples",
    title: "Examples",
    body: "What the initial scaffold shows today, plus the route shapes the docs focus on.",
  },
]

export default function DocsOverviewPage() {
  return (
    <article className="docs-article">
      <p className="eyebrow">Docs overview</p>
      <h2>Dawn keeps the first surface area intentionally small.</h2>
      <p>
        The initial repo focuses on a publishable package layout, a developer CLI, and a
        documentation model that explains the App Graph concept without inventing runtime features
        that are not built yet.
      </p>

      <div className="section-grid docs-grid">
        {sections.map((section) => (
          <Link className="card card-link" href={section.href} key={section.href}>
            <h3>{section.title}</h3>
            <p>{section.body}</p>
            <span className="link-hint">Read page</span>
          </Link>
        ))}
      </div>
    </article>
  )
}
