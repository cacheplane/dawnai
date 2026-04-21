import Link from "next/link"

export function HeroSection() {
  return (
    <section className="relative pt-24 pb-32 text-center overflow-hidden isolate">
      {/* Starfield — the distant cosmos, scattered throughout the upper hero */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-20 bg-no-repeat bg-top opacity-[0.85]"
        style={{
          backgroundImage: "url('/backgrounds/dawn-stars.svg')",
          backgroundSize: "100% auto",
        }}
      />
      {/* Earth — curvature pinned to the very bottom, thin atmospheric dawn along the limb */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 bg-no-repeat bg-bottom"
        style={{
          backgroundImage: "url('/backgrounds/dawn-earth.svg')",
          backgroundSize: "100% auto",
          height: "180px",
        }}
      />
      {/* Ecosystem badge */}
      <div className="relative inline-flex items-center gap-2 px-3.5 py-1.5 border border-border rounded-full text-xs text-text-secondary mb-6">
        <span className="text-text-muted">Built for the</span>
        <span className="text-accent-green font-semibold">LangChain</span>
        <span className="text-text-muted">ecosystem</span>
      </div>

      <h1
        className="relative font-display text-5xl md:text-7xl font-semibold text-text-primary tracking-tight leading-[1.05]"
        style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0" }}
      >
        The App Router
        <br />
        for AI agents.
      </h1>

      <p className="relative text-text-secondary mt-5 text-lg max-w-xl mx-auto leading-relaxed">
        A TypeScript-first framework for building and deploying graph-based AI systems with the
        ergonomics of Next.js. File-system routing, type-safe tools, zero boilerplate.
      </p>

      {/* Trust strip — placed in the cosmic dark above the atmospheric glow */}
      <div className="relative mt-8 flex justify-center flex-wrap gap-x-8 gap-y-2 opacity-60">
        {[
          { name: "LangGraph", color: "text-accent-green" },
          { name: "LangChain", color: "text-accent-green" },
          { name: "TypeScript", color: "text-accent-blue" },
          { name: "Vite", color: "text-accent-purple" },
        ].map((item) => (
          <span key={item.name} className={`text-xs font-medium ${item.color}`}>
            {item.name}
          </span>
        ))}
      </div>

      <div className="relative mt-8 flex gap-3 justify-center">
        <Link
          href="/docs/getting-started"
          className="px-6 py-2.5 bg-accent-amber text-bg-primary rounded-md text-sm font-semibold hover:bg-accent-amber-deep transition-colors"
        >
          Get Started
        </Link>
        <a
          href="https://github.com/anthropics/dawn"
          target="_blank"
          rel="noopener noreferrer"
          className="px-6 py-2.5 border border-border text-text-secondary rounded-md text-sm hover:border-text-muted hover:text-text-primary transition-colors"
        >
          GitHub
        </a>
      </div>

      <div className="relative mt-6 font-mono text-sm text-text-muted bg-bg-card inline-block px-4 py-2 rounded-md border border-border">
        <span className="text-accent-amber">$</span> npx create-dawn-app my-agent
      </div>
    </section>
  )
}
