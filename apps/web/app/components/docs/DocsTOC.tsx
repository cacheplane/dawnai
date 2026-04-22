"use client"

import { useEffect, useState } from "react"

interface Heading {
  readonly id: string
  readonly text: string
  readonly level: 2 | 3
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
}

export function DocsTOC() {
  const [headings, setHeadings] = useState<readonly Heading[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    const article = document.querySelector("article.prose-dawn")
    if (!article) return

    const elements = Array.from(article.querySelectorAll<HTMLHeadingElement>("h2, h3"))
    const parsed: Heading[] = elements.map((el) => {
      const text = el.textContent?.trim() ?? ""
      const id = el.id || slugify(text)
      if (!el.id) el.id = id
      return {
        id,
        text,
        level: el.tagName === "H2" ? 2 : 3,
      }
    })
    setHeadings(parsed)

    if (parsed.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) => a.target.getBoundingClientRect().top - b.target.getBoundingClientRect().top,
          )
        const first = visible[0]
        if (first) setActiveId(first.target.id)
      },
      { rootMargin: "0px 0px -70% 0px", threshold: 1 },
    )
    for (const el of elements) observer.observe(el)
    return () => observer.disconnect()
  }, [])

  if (headings.length === 0) return null

  return (
    <nav aria-label="On this page" className="sticky top-8 w-52 shrink-0 hidden xl:block text-sm">
      <p className="text-xs text-text-muted uppercase tracking-widest mb-3">On this page</p>
      <ul className="space-y-2 border-l border-border-subtle">
        {headings.map((h) => (
          <li key={h.id} className={h.level === 3 ? "pl-5" : "pl-3"}>
            <a
              href={`#${h.id}`}
              className={`block py-0.5 transition-colors -ml-px border-l ${
                activeId === h.id
                  ? "text-accent-amber border-accent-amber"
                  : "text-text-muted border-transparent hover:text-text-primary"
              }`}
              style={{ paddingLeft: h.level === 3 ? 12 : 12 }}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
