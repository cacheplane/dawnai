import Link from "next/link"
import type { ReactNode } from "react"

const docsNav = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/getting-started", label: "Getting started" },
  { href: "/docs/app-graph", label: "App Graph" },
  { href: "/docs/packages", label: "Packages" },
  { href: "/docs/cli", label: "CLI" },
  { href: "/docs/examples", label: "Examples" },
]

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="docs-shell">
      <aside className="docs-sidebar">
        <p className="eyebrow">Documentation</p>
        <h1>Docs</h1>
        <p className="docs-intro">
          A compact guide to Dawn&apos;s current repo surfaces, filesystem contract, and developer
          workflows.
        </p>

        <nav className="docs-nav" aria-label="Docs">
          {docsNav.map((item) => (
            <Link href={item.href} key={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      <section className="docs-content">{children}</section>
    </div>
  )
}
