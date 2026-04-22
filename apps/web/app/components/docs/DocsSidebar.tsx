"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { DocsSearch } from "./DocsSearch"
import { DOCS_NAV } from "./nav"
import type { DocsSearchEntry } from "./search-index"

interface Props {
  readonly searchIndex: readonly DocsSearchEntry[]
}

export function DocsSidebar({ searchIndex }: Props) {
  const pathname = usePathname()

  return (
    <aside className="w-56 shrink-0">
      <p className="text-xs text-text-muted uppercase tracking-widest mb-4 inline-flex items-center gap-2">
        <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
        Documentation
      </p>
      <DocsSearch index={searchIndex} />
      <nav className="space-y-6">
        {DOCS_NAV.map((section) => (
          <div key={section.label}>
            <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider mb-2 px-3">
              {section.label}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = pathname === item.href
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`block text-sm px-3 py-1.5 rounded-md transition-colors ${
                        active
                          ? "text-accent-amber bg-accent-amber/5 border-l border-accent-amber -ml-px pl-[11px]"
                          : "text-text-secondary hover:text-text-primary hover:bg-bg-card"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  )
}
