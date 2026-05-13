import Link from "next/link"

export interface RelatedCardItem {
  readonly href: string
  readonly title: string
  readonly subtitle?: string
}

interface RelatedCardsProps {
  readonly items: ReadonlyArray<RelatedCardItem>
}

function ArrowIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
    >
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="7 7 17 7 17 17" />
    </svg>
  )
}

export function RelatedCards({ items }: RelatedCardsProps) {
  return (
    <div className="not-prose grid grid-cols-1 md:grid-cols-2 gap-3 my-6">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="group relative block rounded-lg border border-divider bg-surface/40 px-4 py-3 hover:border-text-muted hover:bg-surface transition-colors"
        >
          <span className="absolute top-3 right-3 text-ink-dim group-hover:text-ink transition-colors">
            <ArrowIcon />
          </span>
          <div className="pr-6">
            <div className="text-base font-semibold text-ink">{item.title}</div>
            {item.subtitle && (
              <div className="mt-1 text-sm text-ink-dim leading-snug">{item.subtitle}</div>
            )}
          </div>
        </Link>
      ))}
    </div>
  )
}
