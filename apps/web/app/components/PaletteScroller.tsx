"use client"

import { useEffect } from "react"
import { paletteAt } from "../../lib/palette/interpolate"

/**
 * Drives the landing-page CSS variables from scroll position.
 *
 * Mount once near the top of the landing tree. Renders nothing.
 * Respects `prefers-reduced-motion`: bails out before registering the
 * scroll listener, leaving the daylight defaults from globals.css in place.
 */
export function PaletteScroller() {
  useEffect(() => {
    if (typeof window === "undefined") return
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduced) return

    const root = document.documentElement
    let ticking = false

    function apply() {
      const max = document.documentElement.scrollHeight - window.innerHeight
      const progress = max > 0 ? window.scrollY / max : 0
      const pal = paletteAt(progress)
      root.style.setProperty("--landing-bg", pal.bg)
      root.style.setProperty("--landing-fg", pal.fg)
      root.style.setProperty("--landing-muted", pal.muted)
      root.style.setProperty("--landing-surface", pal.surface)
      root.style.setProperty("--landing-accent", pal.accent)
      root.style.setProperty("--landing-hue", pal.hue)
      root.style.setProperty("--landing-border", pal.border)
      ticking = false
    }

    function onScroll() {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(apply)
    }

    apply() // initial paint at the user's current scroll position
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll, { passive: true })

    return () => {
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
    }
  }, [])

  return null
}
