import { CopyCommand } from "../CopyCommand"

function GitHubIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
      className="w-4 h-4"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.26.82-.577 0-.285-.01-1.04-.015-2.04-3.338.725-4.042-1.61-4.042-1.61-.547-1.387-1.335-1.757-1.335-1.757-1.09-.745.083-.73.083-.73 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.998.108-.775.42-1.305.762-1.605-2.665-.305-5.467-1.335-5.467-5.93 0-1.31.467-2.38 1.235-3.22-.123-.305-.535-1.527.118-3.18 0 0 1.008-.323 3.3 1.23.957-.267 1.98-.4 3-.405 1.02.005 2.043.138 3 .405 2.29-1.553 3.297-1.23 3.297-1.23.655 1.653.243 2.875.12 3.18.77.84 1.233 1.91 1.233 3.22 0 4.61-2.807 5.62-5.48 5.92.43.37.815 1.103.815 2.222 0 1.605-.015 2.898-.015 3.293 0 .32.217.697.825.578C20.565 21.795 24 17.297 24 12c0-6.63-5.37-12-12-12z"
      />
    </svg>
  )
}

export function FinalCta() {
  return (
    <section className="bg-surface-sunk">
      <div className="max-w-[1100px] mx-auto px-6 md:px-8 py-24 md:py-32 text-center">
        <h2
          className="font-display font-semibold text-ink text-[40px] leading-[46px] md:text-[56px] md:leading-[62px]"
          style={{
            fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
            letterSpacing: "-0.015em",
          }}
        >
          Start building.
        </h2>
        <p className="mt-5 text-lg text-ink-muted leading-[30px] max-w-[48ch] mx-auto">
          Scaffold a Dawn app, open the example, and see whether the shape
          fits your team in under five minutes.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <CopyCommand command="pnpm create dawn-ai-app my-agent" />
          <a
            href="https://github.com/cacheplane/dawnai"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:text-accent-saas transition-colors"
          >
            <GitHubIcon /> Star on GitHub <span aria-hidden="true">→</span>
          </a>
        </div>
      </div>
    </section>
  )
}
