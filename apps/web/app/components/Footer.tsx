export function Footer() {
  return (
    <footer className="flex justify-between items-center px-8 py-6 border-t border-border-subtle text-xs text-text-dim">
      <span>dawn</span>
      <nav className="flex gap-4">
        <a href="/docs/getting-started" className="hover:text-text-secondary transition-colors">
          Docs
        </a>
        <a
          href="https://github.com/anthropics/dawn"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-text-secondary transition-colors"
        >
          GitHub
        </a>
        <a
          href="https://www.npmjs.com/org/dawn"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-text-secondary transition-colors"
        >
          npm
        </a>
      </nav>
    </footer>
  )
}
