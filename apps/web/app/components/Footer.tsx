import Link from "next/link"
import { BrandLogo } from "./BrandLogo"

interface LinkItem {
  readonly label: string
  readonly href: string
  readonly external?: boolean
}

interface Column {
  readonly heading: string
  readonly items: readonly LinkItem[]
}

const COLUMNS: readonly Column[] = [
  {
    heading: "Product",
    items: [
      { label: "Docs", href: "/docs/getting-started" },
      { label: "Examples", href: "/docs/recipes" },
      { label: "Blog", href: "/blog" },
      { label: "Brand", href: "/brand" },
    ],
  },
  {
    heading: "Resources",
    items: [
      { label: "GitHub", href: "https://github.com/cacheplane/dawnai", external: true },
      { label: "npm", href: "https://www.npmjs.com/org/dawn-ai", external: true },
      {
        label: "LangGraph.js",
        href: "https://www.langchain.com/langgraph",
        external: true,
      },
      { label: "RSS feed", href: "/blog/rss.xml", external: true },
      { label: "llms.txt", href: "/llms.txt", external: true },
    ],
  },
  {
    heading: "Legal",
    items: [
      {
        label: "MIT License",
        href: "https://github.com/cacheplane/dawnai/blob/main/LICENSE",
        external: true,
      },
      {
        label: "Code of Conduct",
        href: "https://github.com/cacheplane/dawnai/blob/main/CODE_OF_CONDUCT.md",
        external: true,
      },
      {
        label: "Security",
        href: "https://github.com/cacheplane/dawnai/blob/main/SECURITY.md",
        external: true,
      },
    ],
  },
]

function FooterLink({ label, href, external }: LinkItem) {
  const className = "text-sm text-ink-muted hover:text-ink transition-colors block py-0.5"
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {label}
      </a>
    )
  }
  return (
    <Link href={href} className={className}>
      {label}
    </Link>
  )
}

export function Footer() {
  return (
    <footer className="bg-surface border-t border-divider">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 pt-16 pb-10">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10 md:gap-8">
          <div className="col-span-2 md:col-span-1">
            <BrandLogo imageClassName="h-7" variant="dark" />
            <p className="text-sm text-ink-muted mt-3 leading-relaxed max-w-[28ch]">
              TypeScript meta-framework for LangGraph.js.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.heading} className="flex flex-col gap-1">
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-dim mb-3">
                {col.heading}
              </p>
              {col.items.map((item) => (
                <FooterLink key={item.label} {...item} />
              ))}
            </div>
          ))}
        </div>
        <div className="mt-12 pt-6 border-t border-divider flex flex-col md:flex-row gap-2 md:justify-between text-xs text-ink-dim">
          <span>{`© ${new Date().getFullYear()} Dawn. MIT-licensed.`}</span>
          <span>Built on the LangChain ecosystem.</span>
        </div>
      </div>
    </footer>
  )
}
