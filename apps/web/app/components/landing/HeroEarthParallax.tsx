"use client"

import { useEffect, useRef, useState } from "react"

/**
 * Subtle scroll-linked parallax for the hero earth layer.
 *
 * The earth translates upward (the sun "rises" further) as the user scrolls
 * past the hero. Max translation is capped at `maxRisePx`. Respects
 * prefers-reduced-motion.
 *
 * EXPERIMENT: To undo, replace `<HeroEarthParallax />` in HeroSection with
 * the original inline markup:
 *
 *   <div
 *     aria-hidden
 *     className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 bg-no-repeat bg-bottom w-full"
 *     style={{
 *       backgroundImage: "url('/backgrounds/dawn-earth.svg')",
 *       backgroundSize: "100% 100%",
 *       aspectRatio: "1920 / 340",
 *     }}
 *   />
 */
export function HeroEarthParallax({ maxRisePx = 28 }: { maxRisePx?: number }) {
  const [translateY, setTranslateY] = useState(0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return

    const compute = () => {
      // Scroll progress 0..1 across the first viewport height
      const y = window.scrollY
      const h = window.innerHeight
      const progress = Math.max(0, Math.min(1, y / h))
      setTranslateY(progress * maxRisePx)
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
  }, [maxRisePx])

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 bg-no-repeat bg-bottom w-full"
      style={{
        backgroundImage: "url('/backgrounds/dawn-earth.svg')",
        backgroundSize: "100% 100%",
        aspectRatio: "1920 / 340",
        transform: `translate3d(0, ${-translateY}px, 0)`,
        willChange: "transform",
      }}
    />
  )
}
