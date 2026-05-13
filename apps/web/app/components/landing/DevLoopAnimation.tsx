import { CodeFrame } from "../ui/CodeFrame"

/**
 * Animated terminal that simulates a Dawn dev-server reload cycle.
 * Uses CSS keyframes to fade in lines on a loop. Respects prefers-reduced-motion
 * — under reduced motion all lines render at full opacity statically.
 */
export function DevLoopAnimation() {
  return (
    <CodeFrame label="pnpm dev">
      <div className="px-4 py-4 text-sm font-mono leading-[22px] text-ink min-h-[260px]">
        <p>
          <span className="text-ink-dim">$</span> pnpm dev
        </p>
        <p className="text-ink-dim mt-2">▲ Dawn dev server</p>
        <p className="text-ink-dim">- Local: http://localhost:3000</p>

        <p className="mt-3">
          <span className="text-accent-saas">✓</span> Compiled in 412ms
        </p>
        <p>
          <span className="text-accent-saas">✓</span> Graph state preserved across reload
        </p>
        <p className="text-ink-dim mt-2">‒ Watching for changes…</p>

        <p
          className="mt-3 devloop-line"
          style={{ animation: "devloop 7s ease-in-out infinite", animationDelay: "0s" }}
        >
          <span className="text-accent-saas">✓</span> Updated route /support in 87ms
        </p>
        <p
          className="devloop-line"
          style={{ animation: "devloop 7s ease-in-out infinite", animationDelay: "2s" }}
        >
          <span className="text-accent-saas">✓</span> Tool tools/lookup-order updated in 31ms
        </p>
        <p
          className="devloop-line"
          style={{ animation: "devloop 7s ease-in-out infinite", animationDelay: "4s" }}
        >
          <span className="text-accent-saas">✓</span> Schema state.ts compiled in 22ms
        </p>

        <style>{`
          .devloop-line { opacity: 0; }
          @keyframes devloop {
            0%, 5% { opacity: 0; transform: translateY(2px); }
            10%, 90% { opacity: 1; transform: translateY(0); }
            100% { opacity: 0; transform: translateY(0); }
          }
          @media (prefers-reduced-motion: reduce) {
            .devloop-line {
              opacity: 1 !important;
              animation: none !important;
              transform: none !important;
            }
          }
        `}</style>
      </div>
    </CodeFrame>
  )
}
