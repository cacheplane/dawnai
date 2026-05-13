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
    <div>
      <p className="text-xs text-ink-dim uppercase tracking-widest mb-4 inline-flex items-center gap-2">
        <span className="inline-block w-1 h-1 rounded-full bg-accent-saas" aria-hidden />
        Documentation
      </p>
      <DocsSearch index={searchIndex} />
      <nav className="space-y-6 mt-4">
        {DOCS_NAV.map((section) => (
          <div key={section.label}>
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim mb-1.5 px-3">
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
                          ? "text-accent-saas bg-accent-saas/15"
                          : "text-ink-muted hover:text-ink hover:bg-surface"
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
    </div>
  )
}
