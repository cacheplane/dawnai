/**
 * Full-height pull-quote section that sits between ComparisonTable and
 * SolutionSection on the landing page. The "big reveal" — the moment the
 * page resolves from dusk into cream daylight, with a sharp question + pivot.
 *
 * Sets its own gradient background explicitly so the dusk → cream payoff is
 * visually exact, regardless of where the scroll-driven palette engine is
 * interpolated at this scroll position.
 *
 * No JS, no animation. The 100vh of vertical space is the moment.
 */
export function BigReveal() {
  return (
    <section
      className="relative w-full overflow-hidden flex items-center justify-center"
      style={{
        minHeight: "100vh",
        padding: "80px 24px",
        background:
          "linear-gradient(180deg, #3a2840 0%, #6a3848 25%, #c46c3e 55%, #fef4e6 88%, #fffcf4 100%)",
      }}
    >
      {/* Sun bloom rising at bottom-center */}
      <div
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          bottom: "-20%",
          left: "50%",
          width: "140%",
          height: "90%",
          transform: "translateX(-50%)",
          background:
            "radial-gradient(ellipse at center, rgba(251,191,36,0.45) 0%, rgba(245,165,36,0.18) 30%, transparent 60%)",
          zIndex: 0,
        }}
      />

      {/* Faint star dots — fading remnants of the cosmic field, scattered in upper third */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(circle at 18% 18%, rgba(255,255,255,0.55) 1px, transparent 1.6px), radial-gradient(circle at 65% 12%, rgba(255,255,255,0.45) 1px, transparent 1.6px), radial-gradient(circle at 82% 22%, rgba(255,255,255,0.6) 1px, transparent 1.6px), radial-gradient(circle at 35% 14%, rgba(255,255,255,0.5) 1px, transparent 1.6px), radial-gradient(circle at 48% 26%, rgba(255,255,255,0.4) 1px, transparent 1.6px)",
          zIndex: 0,
        }}
      />

      {/* Content */}
      <div className="relative max-w-[760px] text-center" style={{ zIndex: 2 }}>
        <p
          className="font-display mx-auto"
          style={{
            color: "rgba(254, 244, 230, 0.92)",
            fontSize: "clamp(28px, 4vw, 40px)",
            fontWeight: 500,
            lineHeight: 1.2,
            marginBottom: "28px",
            maxWidth: "720px",
            textShadow: "0 2px 18px rgba(0,0,0,0.35)",
            fontVariationSettings: "'opsz' 144, 'SOFT' 50",
          }}
        >
          Why do agent codebases drift, duplicate, and rot?
        </p>
        <h2
          className="font-display"
          style={{
            color: "#1a1530",
            fontSize: "clamp(56px, 9vw, 96px)",
            fontWeight: 700,
            letterSpacing: "-0.025em",
            lineHeight: 1,
            fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
          }}
        >
          No framework.
        </h2>
      </div>
    </section>
  )
}
