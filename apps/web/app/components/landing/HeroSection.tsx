import Link from "next/link"

export function HeroSection() {
  return (
    <section className="pt-24 pb-16 text-center bg-gradient-to-b from-bg-primary to-bg-secondary">
      {/* Ecosystem badge */}
      <div className="inline-flex items-center gap-2 px-3.5 py-1.5 border border-[#222] rounded-full text-xs text-text-secondary mb-6">
        <span className="text-text-muted">Built for the</span>
        <span className="text-accent-green font-semibold">LangChain</span>
        <span className="text-text-muted">ecosystem</span>
      </div>

      <h1 className="text-5xl md:text-6xl font-extrabold text-text-primary tracking-tight leading-[1.1]">
        The App Router
        <br />
        for AI agents.
      </h1>

      <p className="text-text-secondary mt-4 text-lg max-w-xl mx-auto leading-relaxed">
        A TypeScript-first framework for building and deploying graph-based AI systems with the
        ergonomics of Next.js. File-system routing, type-safe tools, zero boilerplate.
      </p>

      <div className="mt-8 flex gap-3 justify-center">
        <Link
          href="/docs/getting-started"
          className="px-6 py-2.5 bg-text-primary text-bg-primary rounded-md text-sm font-semibold hover:bg-gray-200 transition-colors"
        >
          Get Started
        </Link>
        <a
          href="https://github.com/anthropics/dawn"
          target="_blank"
          rel="noopener noreferrer"
          className="px-6 py-2.5 border border-[#333] text-text-secondary rounded-md text-sm hover:border-[#555] transition-colors"
        >
          GitHub
        </a>
      </div>

      <div className="mt-6 font-mono text-sm text-text-muted bg-bg-card inline-block px-4 py-2 rounded-md border border-border">
        npx create-dawn-app my-agent
      </div>

      {/* Trust strip */}
      <div className="mt-12 flex justify-center gap-10 opacity-50">
        {[
          { name: "LangGraph", color: "text-accent-green" },
          { name: "LangChain", color: "text-accent-green" },
          { name: "TypeScript", color: "text-accent-blue" },
          { name: "Vite", color: "text-accent-purple" },
        ].map((item) => (
          <span key={item.name} className={`text-xs ${item.color}`}>
            {item.name}
          </span>
        ))}
      </div>
    </section>
  )
}
