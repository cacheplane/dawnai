interface MetaFrameworkRow {
  readonly runtime: string
  readonly meta: string
  readonly highlight?: boolean
}

const META_FRAMEWORKS: readonly MetaFrameworkRow[] = [
  { runtime: "React", meta: "Next.js" },
  { runtime: "Svelte", meta: "SvelteKit" },
  { runtime: "Vue", meta: "Nuxt" },
  { runtime: "LangGraph", meta: "Dawn", highlight: true },
]

const DELETES: readonly string[] = [
  "StateGraph node + edge wiring",
  "Zod schema duplicates of tool params",
  "Per-route protocol adapters",
  "Custom dev loop scripts",
  "Hand-rolled scenario test harnesses",
  "Bespoke Docker images for deployment",
]

const KEEPS: readonly string[] = [
  "Your tool implementations (just the function)",
  "Your prompts and personas",
  "Your LangGraph workflows and graphs",
  "Your LangChain LCEL chains",
  "Your model providers (OpenAI, Anthropic, etc.)",
  "Your LangSmith tracing",
]

const X_MASK =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='currentColor'><path d='M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z'/></svg>\")"

const CHECK_MASK =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='currentColor'><path d='M9 16.2l-3.5-3.5L4 14.2 9 19.2 20 8.2 18.6 6.8z'/></svg>\")"

export function ComparisonTable() {
  return (
    <section className="py-28 px-8 border-t landing-border">
      <div className="max-w-[1100px] mx-auto">
        {/* Eyebrow */}
        <p className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-accent-amber font-semibold mb-3">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          Quick check
        </p>

        {/* Headline */}
        <h2
          className="font-display font-bold tracking-tight leading-[1.05] mb-4 max-w-[720px] landing-text"
          style={{
            fontSize: "clamp(36px, 5vw, 48px)",
            letterSpacing: "-0.025em",
            fontVariationSettings: "'opsz' 144, 'SOFT' 50",
          }}
        >
          Every runtime gets a meta-framework.
        </h2>

        {/* Lede */}
        <p className="landing-text-muted text-lg leading-relaxed max-w-[600px]">
          React got Next.js. Svelte got SvelteKit. Vue got Nuxt. LangGraph just got Dawn.
        </p>

        {/* Brand wall */}
        <div
          className="rounded-2xl border my-10 overflow-hidden"
          style={{
            background: "rgb(from var(--landing-surface) r g b / 0.6)",
            borderColor: "var(--landing-border)",
            boxShadow: "0 12px 32px -16px rgba(0,0,0,0.30)",
          }}
        >
          {META_FRAMEWORKS.map((row, i) => (
            <div
              key={row.runtime}
              className={`grid grid-cols-[1fr_auto_1fr] items-center gap-6 px-7 py-5 ${
                i < META_FRAMEWORKS.length - 1 ? "border-b" : ""
              }`}
              style={{
                borderColor: "var(--landing-border)",
                background: row.highlight ? "rgba(251,191,36,0.06)" : "transparent",
              }}
            >
              {/* Runtime side */}
              <span className="flex items-center gap-3">
                <span
                  className="font-mono font-semibold text-lg"
                  style={{ color: row.highlight ? "var(--landing-fg)" : "var(--landing-muted)" }}
                >
                  {row.runtime}
                </span>
                <span
                  className="font-sans text-[11px] px-2 py-0.5 rounded border inline-block"
                  style={{
                    background: "rgb(from var(--landing-fg) r g b / 0.05)",
                    borderColor: "var(--landing-border)",
                    color: "var(--landing-muted)",
                  }}
                >
                  runtime
                </span>
              </span>

              {/* Arrow */}
              <span
                className="font-bold"
                style={{ color: row.highlight ? "#d97706" : "rgba(217,119,6,0.55)" }}
                aria-hidden
              >
                →
              </span>

              {/* Meta-framework side */}
              <span className="flex items-center gap-3">
                <span
                  className="font-mono font-semibold text-lg"
                  style={{ color: row.highlight ? "#d97706" : "var(--landing-fg)" }}
                >
                  {row.meta}
                </span>
                <span
                  className="font-sans text-[11px] px-2 py-0.5 rounded border inline-block"
                  style={
                    row.highlight
                      ? {
                          background: "rgba(251,191,36,0.15)",
                          borderColor: "rgba(217,119,6,0.30)",
                          color: "#d97706",
                        }
                      : {
                          background: "rgb(from var(--landing-fg) r g b / 0.05)",
                          borderColor: "var(--landing-border)",
                          color: "var(--landing-muted)",
                        }
                  }
                >
                  meta-framework
                </span>
              </span>
            </div>
          ))}
        </div>

        {/* Bridge line */}
        <p
          className="font-display landing-text mb-10 max-w-[720px]"
          style={{
            fontSize: "clamp(22px, 2.4vw, 26px)",
            fontWeight: 500,
            lineHeight: 1.25,
            fontVariationSettings: "'opsz' 144, 'SOFT' 50",
          }}
        >
          A meta-framework{" "}
          <em style={{ color: "#d97706", fontStyle: "italic" }}>deletes the boilerplate</em>, not
          your stack.
        </p>

        {/* Two-column reassurance */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Dawn deletes */}
          <div
            className="rounded-xl p-7"
            style={{
              background: "rgba(120,30,40,0.10)",
              border: "1px solid rgba(255,99,99,0.25)",
            }}
          >
            <div
              className="text-[11px] uppercase tracking-[0.15em] font-bold mb-3"
              style={{ color: "#ff7a85" }}
            >
              Dawn deletes
            </div>
            <h3
              className="font-display landing-text mb-4"
              style={{
                fontSize: "22px",
                fontWeight: 700,
                lineHeight: 1.2,
                fontVariationSettings: "'opsz' 144, 'SOFT' 50",
              }}
            >
              Plumbing you wrote five times.
            </h3>
            <ul className="flex flex-col">
              {DELETES.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-3 py-1.5 text-[14.5px] leading-snug landing-text"
                >
                  <span
                    aria-hidden
                    className="inline-block w-3.5 h-3.5 mt-1 shrink-0"
                    style={{
                      background: "#ff7a85",
                      maskImage: X_MASK,
                      WebkitMaskImage: X_MASK,
                      maskSize: "contain",
                      WebkitMaskSize: "contain",
                      maskRepeat: "no-repeat",
                      WebkitMaskRepeat: "no-repeat",
                    }}
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Dawn keeps */}
          <div
            className="rounded-xl p-7"
            style={{
              background: "rgba(251,191,36,0.05)",
              border: "1px solid rgba(217,119,6,0.36)",
            }}
          >
            <div
              className="text-[11px] uppercase tracking-[0.15em] font-bold mb-3"
              style={{ color: "#d97706" }}
            >
              Dawn keeps
            </div>
            <h3
              className="font-display landing-text mb-4"
              style={{
                fontSize: "22px",
                fontWeight: 700,
                lineHeight: 1.2,
                fontVariationSettings: "'opsz' 144, 'SOFT' 50",
              }}
            >
              Everything you already wrote.
            </h3>
            <ul className="flex flex-col">
              {KEEPS.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-3 py-1.5 text-[14.5px] leading-snug landing-text"
                >
                  <span
                    aria-hidden
                    className="inline-block w-3.5 h-3.5 mt-1 shrink-0"
                    style={{
                      background: "#d97706",
                      maskImage: CHECK_MASK,
                      WebkitMaskImage: CHECK_MASK,
                      maskSize: "contain",
                      WebkitMaskSize: "contain",
                      maskRepeat: "no-repeat",
                      WebkitMaskRepeat: "no-repeat",
                    }}
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}
