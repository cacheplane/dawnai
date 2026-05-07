import Link from "next/link"
import { BrandLogo } from "./BrandLogo"

export function Header() {
  return (
    <header className="flex justify-between items-center px-8 py-4 border-b border-border-subtle">
      <BrandLogo imageClassName="h-8" />
      <nav className="flex items-center gap-6 text-sm text-text-secondary">
        <Link href="/docs/getting-started" className="hover:text-text-primary transition-colors">
          Docs
        </Link>
        <a
          href="https://github.com/cacheplane/dawnai"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-text-primary transition-colors"
        >
          GitHub
        </a>
        <Link
          href="/docs/getting-started"
          className="bg-accent-amber text-bg-primary px-3 py-1.5 rounded-md font-semibold hover:bg-accent-amber-deep transition-colors"
        >
          Read the Docs
        </Link>
      </nav>
    </header>
  )
}
