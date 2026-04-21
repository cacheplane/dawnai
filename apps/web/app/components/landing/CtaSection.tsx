import Link from "next/link"

export function CtaSection() {
  return (
    <section className="py-20 px-8 border-t border-border-subtle text-center">
      <h2 className="text-4xl font-extrabold text-text-primary tracking-tight">Ready to build?</h2>
      <p className="text-text-muted mt-3 text-base max-w-md mx-auto leading-relaxed">
        Give your AI agents the structure they deserve.
      </p>

      <div className="mt-8 flex gap-3 justify-center">
        <Link
          href="/docs/getting-started"
          className="px-8 py-3 bg-text-primary text-bg-primary rounded-md text-sm font-semibold hover:bg-gray-200 transition-colors"
        >
          Get Started
        </Link>
        <a
          href="https://github.com/anthropics/dawn"
          target="_blank"
          rel="noopener noreferrer"
          className="px-8 py-3 border border-[#333] text-text-secondary rounded-md text-sm hover:border-[#555] transition-colors"
        >
          View on GitHub
        </a>
      </div>

      <div className="mt-6 font-mono text-sm text-text-muted bg-bg-card inline-block px-5 py-2.5 rounded-md border border-border">
        npx create-dawn-app my-agent
      </div>
    </section>
  )
}
