import Image from "next/image"
import type { ReactNode } from "react"

interface ProviderMarkProps {
  readonly name: string
  /** Inline icon node (e.g. an inline SVG). Mutually exclusive with `logoSrc`. */
  readonly icon?: ReactNode
  /** Path to a logo image in /public. Rendered at 16px height with natural width. */
  readonly logoSrc?: string
  /**
   * If true and `logoSrc` is set, the logo contains the wordmark — render the
   * logo only and suppress the text name. Useful for brands whose logo is
   * inseparable from their wordmark (e.g. Ollama).
   */
  readonly logoIsWordmark?: boolean
  readonly href?: string
}

/**
 * Inline word+mark for ecosystem rows. Renders the provider name with an
 * optional logo to its left, optionally wrapped in an external link.
 */
export function ProviderMark({ name, icon, logoSrc, logoIsWordmark, href }: ProviderMarkProps) {
  const logo =
    logoSrc !== undefined ? (
      <Image
        src={logoSrc}
        alt={logoIsWordmark === true ? name : ""}
        width={48}
        height={16}
        className="h-4 w-auto"
        unoptimized
      />
    ) : icon !== undefined ? (
      <span aria-hidden="true" className="inline-flex w-4 h-4">
        {icon}
      </span>
    ) : null

  const content = (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink-muted">
      {logo}
      {logoIsWordmark === true && logoSrc !== undefined ? null : <span>{name}</span>}
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
