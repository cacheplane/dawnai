"use client"

import { useEffect, useRef, useState } from "react"

/**
 * Three-layer scroll-linked parallax for the hero sky + earth + sun.
 *
 * The effect: as the reader scrolls down, the stars drift slowly (far
 * background), the earth rises at a medium rate (the horizon), and the sun
 * bloom accelerates upward (cresting the horizon). Different rates = depth.
 *
 * The full range is reached by the time the reader scrolls one viewport height.
 * Respects prefers-reduced-motion.
 *
 * EXPERIMENT: To undo, replace `<HeroParallaxLayers />` in HeroSection with
 * the original two inline divs (starfield + earth). The removal snippet is
 * at the bottom of this file.
 */
export function HeroParallaxLayers({
  maxEarthRisePx = 90,
  maxStarRisePx = 20,
  maxSunRisePx = 160,
}: {
  maxEarthRisePx?: number
  maxStarRisePx?: number
  /** Accelerated rate for the sun bloom — outpaces the earth so the sun
   *  reads as rising above the horizon, not dragging with the ground. */
  maxSunRisePx?: number
}) {
  const [progress, setProgress] = useState(0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return

    const compute = () => {
      const y = window.scrollY
      const h = window.innerHeight
      setProgress(Math.max(0, Math.min(1, y / h)))
    }

    const onScroll = () => {
      if (rafRef.current != null) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        compute()
      })
    }

    compute()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      window.removeEventListener("scroll", onScroll)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  const earthY = progress * maxEarthRisePx
  const starY = progress * maxStarRisePx
  const sunY = progress * maxSunRisePx

  return (
    <>
      {/* Starfield — drifts slowly (far background) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-20 bg-no-repeat bg-top opacity-[0.85]"
        style={{
          backgroundImage: "url('/backgrounds/dawn-stars.svg')",
          backgroundSize: "100% auto",
          transform: `translate3d(0, ${-starY}px, 0)`,
          willChange: "transform",
        }}
      />
      {/* Earth — rises at medium rate (the horizon beneath the sun) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 bg-no-repeat bg-bottom w-full"
        style={{
          backgroundImage: "url('/backgrounds/dawn-earth.svg')",
          backgroundSize: "100% 100%",
          aspectRatio: "1920 / 340",
          transform: `translate3d(0, ${-earthY}px, 0)`,
          willChange: "transform",
        }}
      />
      {/* Sun bloom — accelerates upward FASTER than the earth, so the sun
          appears to rise above the horizon. Container is oversized (800px
          tall, anchored 320px below the hero) so the gradient's ellipse has
          room to fade fully on all sides — no hard cutoff at the container
          edge as the user scrolls. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -z-[5] w-full h-[800px]"
        style={{
          bottom: "-320px",
          background:
            "radial-gradient(ellipse 30% 45% at 50% 50%, rgba(254,243,199,0.55) 0%, rgba(252,211,77,0.32) 28%, rgba(245,158,11,0.14) 58%, transparent 82%)",
          transform: `translate3d(0, ${-sunY}px, 0)`,
          willChange: "transform",
        }}
      />
    </>
  )
}

/* --- UNDO SNIPPET ----------------------------------------------------------
Replace <HeroParallaxLayers /> in HeroSection.tsx with the two original divs
to remove the parallax experiment entirely:

  <div
    aria-hidden
    className="pointer-events-none absolute inset-0 -z-20 bg-no-repeat bg-top opacity-[0.85]"
    style={{
      backgroundImage: "url('/backgrounds/dawn-stars.svg')",
      backgroundSize: "100% auto",
    }}
  />
  <div
    aria-hidden
    className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 bg-no-repeat bg-bottom w-full"
    style={{
      backgroundImage: "url('/backgrounds/dawn-earth.svg')",
      backgroundSize: "100% 100%",
      aspectRatio: "1920 / 340",
    }}
  />
--------------------------------------------------------------------------- */
