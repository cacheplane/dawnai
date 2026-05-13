import Link from "next/link"
import { siblingsFor } from "./nav"

interface Props {
  readonly href: string
}

export function DocsPrevNext({ href }: Props) {
  const { prev, next } = siblingsFor(href)
  if (!prev && !next) return null

  return (
    <nav
      aria-label="Pagination"
      className="mt-16 pt-8 border-t border-divider grid grid-cols-2 gap-4"
    >
      {prev ? (
        <Link
          href={prev.href}
          className="group border border-divider rounded-lg p-4 hover:border-accent-amber/40 transition-colors"
        >
          <span className="text-xs text-ink-dim block mb-1">&larr; Previous</span>
          <span className="text-sm font-semibold text-ink group-hover:text-accent-saas transition-colors">
            {prev.label}
          </span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          href={next.href}
          className="group border border-divider rounded-lg p-4 text-right hover:border-accent-amber/40 transition-colors"
        >
          <span className="text-xs text-ink-dim block mb-1">Next &rarr;</span>
          <span className="text-sm font-semibold text-ink group-hover:text-accent-saas transition-colors">
            {next.label}
          </span>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  )
}
