export function CtaSection() {
  return (
    <section
      className="relative w-full overflow-hidden border-t"
      style={{
        background: "linear-gradient(180deg, #fff7e0 0%, #ffe2a8 100%)",
        borderColor: "rgba(217,119,6,0.15)",
        padding: "180px 24px",
      }}
    >
      {/* Layer 1 — atmospheric corner blobs */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 25% 75%, rgba(196,167,231,0.30) 0%, transparent 50%), radial-gradient(ellipse at 75% 25%, rgba(127,200,255,0.24) 0%, transparent 50%)",
          zIndex: 0,
        }}
      />

      {/* Layer 2 — sun bloom rising from bottom (sits beneath the grid) */}
      <div
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          bottom: "-40%",
          left: "50%",
          width: "140%",
          height: "140%",
          transform: "translateX(-50%)",
          background:
            "radial-gradient(ellipse at center, rgba(245,165,36,0.50) 0%, rgba(245,165,36,0.18) 28%, transparent 55%)",
          zIndex: 0,
        }}
      />

      {/* Layer 3 — amber dot grid, masked to fade at edges */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle at center, rgba(217,119,6,0.28) 1px, transparent 1.6px)",
          backgroundSize: "28px 28px",
          maskImage: "radial-gradient(ellipse at center, black 0%, black 45%, transparent 78%)",
          WebkitMaskImage:
            "radial-gradient(ellipse at center, black 0%, black 45%, transparent 78%)",
          zIndex: 1,
        }}
      />

      {/* Content */}
      <div className="relative max-w-[720px] mx-auto text-center" style={{ zIndex: 2 }}>
        <h2
          className="font-display font-semibold tracking-tight"
          style={{
            color: "#1a1530",
            fontSize: "clamp(40px, 6vw, 64px)",
            lineHeight: 1.05,
            letterSpacing: "-0.025em",
            marginBottom: "20px",
            fontVariationSettings: "'opsz' 144, 'SOFT' 50",
          }}
        >
          Build your first agent in under a minute.
        </h2>
        <p
          className="mx-auto"
          style={{
            color: "#6d5638",
            fontSize: "19px",
            lineHeight: 1.55,
            marginBottom: "32px",
            maxWidth: "540px",
          }}
        >
          File-system routes, type-safe tools, no Zod boilerplate. Scaffold a project and run it in
          one terminal.
        </p>
        <div className="flex gap-3 justify-center flex-wrap">
          <a
            href="https://github.com/cacheplane/dawnai"
            className="inline-block rounded-xl font-semibold transition-transform"
            style={{
              padding: "16px 32px",
              fontSize: "16px",
              background: "#1a1530",
              color: "#fef4e6",
            }}
          >
            Start building →
          </a>
          <a
            href="/docs/getting-started"
            className="inline-block rounded-xl font-medium transition-colors"
            style={{
              padding: "16px 28px",
              fontSize: "16px",
              background: "rgba(26,21,48,0.04)",
              color: "#1a1530",
              border: "1px solid rgba(26,21,48,0.18)",
            }}
          >
            Read the docs
          </a>
        </div>
      </div>
    </section>
  )
}
