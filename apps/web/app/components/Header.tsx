import Link from "next/link"

export function Header() {
  return (
    <header className="flex justify-between items-center px-8 py-4 border-b border-border-subtle">
      <Link href="/" className="font-bold text-text-primary tracking-tight">
        dawn
      </Link>
      <nav className="flex items-center gap-6 text-sm text-text-secondary">
        <Link href="/docs/getting-started" className="hover:text-text-primary transition-colors">
          Docs
        </Link>
        <a
          href="https://github.com/anthropics/dawn"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-text-primary transition-colors"
        >
          GitHub
        </a>
        <Link
          href="/docs/getting-started"
          className="text-text-primary bg-[#181818] px-3 py-1.5 rounded-md hover:bg-[#222] transition-colors"
        >
          Get Started
        </Link>
      </nav>
    </header>
  )
}
