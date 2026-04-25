import Link from "next/link"
import { CopyCommand } from "../CopyCommand"

export function CtaSection() {
  return (
    <section className="relative py-20 px-8 border-t border-border-subtle text-center overflow-hidden">
      {/* Subtle cosmic echo — closes the dawn loop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-40 bg-no-repeat bg-top"
        style={{
          backgroundImage: "url('/backgrounds/dawn-stars.svg')",
          backgroundSize: "100% auto",
        }}
      />
      <h2
        className="font-display text-5xl font-semibold text-text-primary tracking-tight"
        style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
      >
        Ready to build?
      </h2>
      <p className="text-text-muted mt-3 text-base max-w-md mx-auto leading-relaxed">
        Give your AI agents the structure they deserve.
      </p>

      <div className="mt-8 flex gap-3 justify-center">
        <Link
          href="/docs/getting-started"
          className="px-8 py-3 bg-accent-amber text-bg-primary rounded-md text-sm font-semibold hover:bg-accent-amber-deep transition-colors"
        >
          Get Started
        </Link>
        <a
          href="https://github.com/cacheplane/dawnai"
          target="_blank"
          rel="noopener noreferrer"
          className="px-8 py-3 border border-border text-text-secondary rounded-md text-sm hover:border-text-muted hover:text-text-primary transition-colors"
        >
          View on GitHub
        </a>
      </div>

      <div className="mt-6">
        <CopyCommand command="npx create-dawn-app my-agent" />
      </div>
    </section>
  )
}
