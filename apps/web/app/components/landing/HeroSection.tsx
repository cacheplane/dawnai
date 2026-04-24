import { getPrompt } from "../../../content/prompts"
import { CopyCommand } from "../CopyCommand"
import { CopyPromptButton } from "../CopyPromptButton"
import { HeroParallaxLayers } from "./HeroEarthParallax"

const scaffoldPrompt = getPrompt("scaffold")

export function HeroSection() {
  return (
    <section
      className="relative pt-24 pb-56 text-center isolate"
      style={{
        background:
          "linear-gradient(to bottom, var(--color-bg-primary) 0%, var(--color-bg-primary) 55%, #020617 100%)",
      }}
    >
      {/* Starfield (slow drift) + earth (medium lift) + sun bloom (accelerated).
          Sun bloom extends below the hero and bleeds into StatsStrip's transparent top. */}
      <HeroParallaxLayers />
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
        <CopyPromptButton prompt={scaffoldPrompt.body} label="Copy prompt" variant="hero" />
        <a
          href="https://github.com/cacheplane/dawnai"
          target="_blank"
          rel="noopener noreferrer"
          className="px-6 py-2.5 border border-border text-text-secondary rounded-md text-sm hover:border-text-muted hover:text-text-primary transition-colors"
        >
          GitHub
        </a>
      </div>

      <div className="relative mt-6">
        <CopyCommand command="npx create-dawn-app my-agent" />
      </div>
    </section>
  )
}
