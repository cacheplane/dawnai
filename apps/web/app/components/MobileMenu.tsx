"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useId, useRef, useState } from "react"
import { CopyCommand } from "./CopyCommand"
import { DOCS_NAV } from "./docs/nav"

interface SiteLink {
  readonly label: string
  readonly href: string
  readonly external?: boolean
}

const SITE_LINKS: readonly SiteLink[] = [
  { label: "Docs", href: "/docs/getting-started" },
  { label: "Blog", href: "/blog" },
  { label: "Brand", href: "/brand" },
  { label: "GitHub", href: "https://github.com/cacheplane/dawnai", external: true },
]

/**
 * Full-screen mobile menu. Visible only below the md breakpoint.
 *
 * Trigger: hamburger button in the header.
 * Overlay: cream-palette full-viewport sheet listing site links and (on
 *          a docs page) the Documentation nav. Primary action is the
 *          install command — same as the desktop nav.
 * Close: × button, Esc, or tapping any link.
 */
export function MobileMenu() {
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  const isDocsPage = pathname.startsWith("/docs")

  // Body scroll lock + focus management
  useEffect(() => {
    if (isOpen) {
      const previous = document.body.style.overflow
      document.body.style.overflow = "hidden"
      // Focus the close button on open
      const closeBtn = closeRef.current
      const t = window.setTimeout(() => closeBtn?.focus(), 0)
      return () => {
        window.clearTimeout(t)
        document.body.style.overflow = previous
        // Return focus to the trigger
        triggerRef.current?.focus()
      }
    }
  }, [isOpen])

  // Esc key closes
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isOpen])

  // Close on route change
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger; isOpen is managed internally
  useEffect(() => {
    setIsOpen(false)
  }, [pathname])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label="Open menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-md text-ink-muted hover:text-ink hover:bg-surface transition-colors"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden role="img">
          <title>Menu</title>
          <path
            d="M4 7h16M4 12h16M4 17h16"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {/* Overlay */}
      <div
        id={menuId}
        role="dialog"
        aria-modal="true"
        aria-label="Site menu"
        className={`md:hidden fixed inset-0 z-50 bg-page transition-opacity duration-200 ease-out ${
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        <div className="h-full overflow-y-auto">
          {/* Header strip */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-divider">
            <span className="text-xs uppercase tracking-widest text-ink-dim font-mono">Menu</span>
            <button
              ref={closeRef}
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Close menu"
              className="inline-flex items-center justify-center w-10 h-10 rounded-md text-ink-muted hover:text-ink hover:bg-surface transition-colors"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden role="img">
                <title>Close</title>
                <path
                  d="M6 6l12 12M6 18L18 6"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {/* Site section */}
          <div className="px-6 py-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim mb-3">
              Site
            </p>
            <ul className="flex flex-col gap-0.5">
              {SITE_LINKS.map((link) => (
                <li key={link.label}>
                  {link.external ? (
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setIsOpen(false)}
                      className="block text-base px-3 py-2.5 rounded-md text-ink-muted hover:text-ink hover:bg-surface transition-colors"
                    >
                      {link.label} <span aria-hidden>↗</span>
                    </a>
                  ) : (
                    <Link
                      href={link.href}
                      onClick={() => setIsOpen(false)}
                      className="block text-base px-3 py-2.5 rounded-md text-ink-muted hover:text-ink hover:bg-surface transition-colors"
                    >
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-5 px-3">
              <CopyCommand command="pnpm create dawn-ai-app" />
            </div>
          </div>

          {/* Documentation section — only on docs pages */}
          {isDocsPage && (
            <div className="px-6 pb-10 border-t border-divider pt-6">
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim mb-3">
                Documentation
              </p>
              <nav className="space-y-5">
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
                              onClick={() => setIsOpen(false)}
                              className={`block text-sm px-3 py-2 rounded-md transition-colors ${
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
                  </div>
                ))}
              </nav>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
