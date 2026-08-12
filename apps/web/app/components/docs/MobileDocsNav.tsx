"use client"

import Link from "next/link"
import { DOCS_NAV } from "./nav"

interface Props {
  readonly pathname: string
  readonly onNavigate: () => void
}

export function MobileDocsNav({ pathname, onNavigate }: Props) {
  return (
    <nav aria-label="Documentation" className="space-y-2">
      {DOCS_NAV.map((section) => {
        const activeSection = section.items.some((item) => item.href === pathname)
        return (
          <details key={section.label} open={activeSection} className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between rounded-md px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-divider-strong">
              {section.label}
              <span aria-hidden className="text-xs transition-transform group-open:rotate-90">
                ›
              </span>
            </summary>
            <ul className="mt-0.5 space-y-0.5">
              {section.items.map((item) => {
                const active = pathname === item.href
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      {...(active ? { "aria-current": "page" as const } : {})}
                      className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                        active
                          ? "text-accent-saas bg-accent-saas-soft"
                          : "text-ink-muted hover:text-ink hover:bg-surface"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </details>
        )
      })}
    </nav>
  )
}
