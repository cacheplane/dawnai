// Page-level ambient atmosphere for the landing. Three layers:
//   1. Repeating starfield below the hero, so the cosmic dark continues all the way down.
//   2. Color blobs anchored at scroll depths to give each narrative beat its own atmospheric tint.
//   3. A faint amber dot grid masked to fade in/out, adding subtle technical texture.
//
// Sits behind everything on the landing (-z-40 → -z-30). Sections continue to render their own
// backgrounds on top; the ambient bleeds through wherever section bg is dark or transparent.

interface Blob {
  readonly top: string
  readonly side: "left" | "right" | "center"
  readonly offset: string
  readonly size: number
  readonly color: string
}

const BLOBS: readonly Blob[] = [
  // Pre-dawn deep violet behind the Problem section — "the cold before sunrise"
  { top: "950px", side: "left", offset: "-180px", size: 640, color: "rgba(99, 102, 241, 0.10)" },
  // Amber wash behind Comparison/Solution — "first warmth"
  { top: "1900px", side: "right", offset: "-120px", size: 580, color: "rgba(245, 158, 11, 0.08)" },
  // Soft peach behind CodeExample/Deploy — "morning sunlight catching the page"
  { top: "3100px", side: "left", offset: "-100px", size: 520, color: "rgba(251, 146, 60, 0.07)" },
  // Quiet amber under FeatureGrid/HowItWorks — keeping the warmth alive
  { top: "4300px", side: "right", offset: "-160px", size: 600, color: "rgba(245, 158, 11, 0.06)" },
  // Green halo behind Ecosystem — green's home, signaling the LangChain ecosystem moment
  { top: "5400px", side: "center", offset: "-300px", size: 700, color: "rgba(0, 166, 126, 0.09)" },
  // Final amber dawn at the CTA — closing the loop with the brightest warmth
  { top: "6100px", side: "center", offset: "-250px", size: 600, color: "rgba(245, 158, 11, 0.10)" },
]

function blobStyle(blob: Blob): React.CSSProperties {
  const positionStyle: React.CSSProperties = { top: blob.top }
  if (blob.side === "left") positionStyle.left = blob.offset
  if (blob.side === "right") positionStyle.right = blob.offset
  if (blob.side === "center") {
    positionStyle.left = "50%"
    positionStyle.transform = `translateX(calc(-50% + ${blob.offset}))`
  }
  return {
    ...positionStyle,
    width: blob.size,
    height: blob.size,
    background: `radial-gradient(circle at center, ${blob.color}, transparent 70%)`,
    filter: "blur(40px)",
  }
}

export function LandingAmbient() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-40 overflow-hidden">
      {/* Repeating starfield below the hero — continues the cosmic dark */}
      <div
        className="absolute inset-x-0 top-[800px] bottom-0 opacity-[0.55] bg-repeat-y bg-top"
        style={{
          backgroundImage: "url('/backgrounds/dawn-stars.svg')",
          backgroundSize: "100% 1200px",
        }}
      />

      {/* Faint amber dot grid — technical texture, masked to fade at top/bottom */}
      <div
        className="absolute inset-x-0 top-[600px] bottom-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at center, rgba(245,158,11,0.07) 1px, transparent 1.4px)",
          backgroundSize: "36px 36px",
          maskImage:
            "linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)",
        }}
      />

      {/* Section-anchored color blobs */}
      {BLOBS.map((blob) => (
        <div
          key={`${blob.top}-${blob.side}`}
          className="absolute rounded-full"
          style={blobStyle(blob)}
        />
      ))}
    </div>
  )
}
