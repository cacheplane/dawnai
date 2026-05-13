import type { ReactNode } from "react"

interface ProviderMarkProps {
  readonly name: string
  readonly icon?: ReactNode
  readonly href?: string
}

/**
 * Inline word+mark for ecosystem rows. Renders the provider name with an
 * optional icon to its left, optionally wrapped in an external link.
 */
export function ProviderMark({ name, icon, href }: ProviderMarkProps) {
  const content = (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink-muted">
      {icon !== undefined ? (
        <span aria-hidden="true" className="inline-flex w-4 h-4">
          {icon}
        </span>
      ) : null}
      <span>{name}</span>
    </span>
  )
  if (href !== undefined) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-ink transition-colors"
      >
        {content}
      </a>
    )
  }
  return content
}
