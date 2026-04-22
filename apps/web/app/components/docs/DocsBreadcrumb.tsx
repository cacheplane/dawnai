import Link from "next/link"
import { breadcrumbsFor } from "./nav"

interface Props {
  readonly href: string
}

export function DocsBreadcrumb({ href }: Props) {
  const crumbs = breadcrumbsFor(href)
  return (
    <nav aria-label="Breadcrumb" className="mb-6 text-xs text-text-muted">
      <ol className="flex items-center gap-2 flex-wrap">
        {crumbs.map((c, i) => (
          <li key={c.href ?? c.label} className="flex items-center gap-2">
            {c.href ? (
              <Link href={c.href} className="hover:text-text-primary transition-colors">
                {c.label}
              </Link>
            ) : (
              <span className="text-text-secondary">{c.label}</span>
            )}
            {i < crumbs.length - 1 && <span aria-hidden>/</span>}
          </li>
        ))}
      </ol>
    </nav>
  )
}
