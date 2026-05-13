"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { DocsSearchEntry, DocsSearchHeading } from "./search-index"

interface Props {
  readonly index: readonly DocsSearchEntry[]
}

interface Result {
  readonly href: string
  readonly title: string
  readonly section: string
  readonly heading?: DocsSearchHeading
  readonly key: string
}

function flatten(index: readonly DocsSearchEntry[]): readonly Result[] {
  const results: Result[] = []
  for (const entry of index) {
    results.push({
      href: entry.href,
      title: entry.title,
      section: entry.section,
      key: entry.href,
    })
    for (const heading of entry.headings) {
      if (heading.level === 1) continue
      results.push({
        href: `${entry.href}#${heading.anchor}`,
        title: entry.title,
        section: entry.section,
        heading,
        key: `${entry.href}#${heading.anchor}`,
      })
    }
  }
  return results
}

function scoreMatch(query: string, target: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (t === q) return 100
  if (t.startsWith(q)) return 80
  if (t.includes(` ${q}`)) return 60
  if (t.includes(q)) return 40
  return 0
}

function filterResults(query: string, all: readonly Result[]): readonly Result[] {
  if (!query.trim()) return all.slice(0, 20)
  const scored = all
    .map((r) => {
      const titleScore = scoreMatch(query, r.title)
      const headingScore = r.heading ? scoreMatch(query, r.heading.text) : 0
      const sectionScore = scoreMatch(query, r.section) * 0.3
      return { result: r, score: Math.max(titleScore, headingScore) + sectionScore }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
  return scored.map((x) => x.result)
}

export function DocsSearch({ index }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const flat = useMemo(() => flatten(index), [index])
  const results = useMemo(() => filterResults(query, flat), [query, flat])

  const close = useCallback(() => {
    setOpen(false)
    setQuery("")
    setActive(0)
  }, [])

  const navigate = useCallback(
    (href: string) => {
      close()
      router.push(href)
    },
    [router, close],
  )

  // Global Cmd/Ctrl-K opens the palette
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen(true)
      } else if (e.key === "Escape" && open) {
        close()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, close])

  // Focus input whenever opened
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Keep active result in view. `active` is read via the data attribute, so
  // the effect needs to run on every render but not include `active` in deps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: active triggers DOM query
  useEffect(() => {
    if (!listRef.current) return
    const activeEl = listRef.current.querySelector<HTMLElement>(`[data-active="true"]`)
    activeEl?.scrollIntoView({ block: "nearest" })
  }, [active])

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, Math.max(0, results.length - 1)))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const r = results[active]
      if (r) navigate(r.href)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 border border-divider rounded-md bg-surface/50 text-sm text-ink-dim hover:border-text-muted hover:text-ink-muted transition-colors mb-6"
        aria-label="Search docs (press Cmd+K)"
      >
        <span className="flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            role="img"
          >
            <title>Search</title>
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          Search
        </span>
        <kbd className="font-mono text-[10px] text-ink-dim border border-divider rounded px-1.5 py-0.5">
          ⌘K
        </kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-ink/40 backdrop-blur-sm"
          onClick={close}
          onKeyDown={(e) => {
            if (e.key === "Escape") close()
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Search docs"
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: wrapper stops modal-close propagation; roles are on ancestor dialog */}
          <div
            className="w-full max-w-xl mx-4 bg-surface border border-divider rounded-xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-divider">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-ink-dim"
                role="img"
              >
                <title>Search</title>
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActive(0)
                }}
                onKeyDown={onInputKey}
                placeholder="Search Dawn docs..."
                className="flex-1 bg-transparent text-ink placeholder-text-muted focus:outline-none text-sm"
              />
              <button
                type="button"
                onClick={close}
                className="text-xs text-ink-dim border border-divider rounded px-1.5 py-0.5 font-mono hover:text-ink"
              >
                ESC
              </button>
            </div>

            <ul ref={listRef} className="max-h-[60vh] overflow-y-auto py-2">
              {results.length === 0 ? (
                <li className="px-4 py-6 text-sm text-ink-dim text-center">
                  No results for &quot;{query}&quot;
                </li>
              ) : (
                results.map((r, i) => (
                  <li key={r.key}>
                    <button
                      type="button"
                      data-active={i === active}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => navigate(r.href)}
                      className={`w-full text-left px-4 py-2.5 flex items-center gap-3 ${
                        i === active ? "bg-accent-saas/10" : ""
                      }`}
                    >
                      <span
                        className={`text-[10px] uppercase tracking-wider font-semibold w-20 shrink-0 ${
                          i === active ? "text-accent-saas" : "text-ink-dim"
                        }`}
                      >
                        {r.section}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span
                          className={`block text-sm font-semibold ${
                            i === active ? "text-accent-saas" : "text-ink"
                          }`}
                        >
                          {r.title}
                        </span>
                        {r.heading && (
                          <span className="block text-xs text-ink-dim truncate">
                            <span aria-hidden>#</span> {r.heading.text}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      )}
    </>
  )
}
