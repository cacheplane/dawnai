import Link from "next/link"
import type { ReactNode } from "react"

const docsNav = [{ href: "/docs/getting-started", label: "Getting Started" }]

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-5xl mx-auto px-8 py-12 flex gap-12">
      <aside className="w-56 shrink-0">
        <p className="text-xs text-text-muted uppercase tracking-widest mb-4">Documentation</p>
        <nav className="space-y-2">
          {docsNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block text-sm text-text-secondary hover:text-text-primary transition-colors px-3 py-2 rounded-md hover:bg-bg-card"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <section className="flex-1 min-w-0">{children}</section>
    </div>
  )
}
