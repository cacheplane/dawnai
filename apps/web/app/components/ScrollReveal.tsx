"use client"

import { type ReactNode, useEffect, useRef, useState } from "react"

interface Props {
  readonly children: ReactNode
  readonly delayMs?: number
  readonly distancePx?: number
  readonly durationMs?: number
}

/**
 * Fades and rises children when they scroll into view. Runs once per element
 * via IntersectionObserver. Sections already visible on initial load render
 * at full opacity with no transition — only off-screen sections get the reveal
 * animation.
 *
 * Respects prefers-reduced-motion.
 */
export function ScrollReveal({ children, delayMs = 0, distancePx = 14, durationMs = 600 }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [revealed, setRevealed] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    const el = ref.current
    if (!el) return

    // Respect reduced motion
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setRevealed(true)
      return
    }

    // If already in view on mount (e.g. above the fold), reveal without delay
    const rect = el.getBoundingClientRect()
    if (rect.top < window.innerHeight * 0.9) {
      setRevealed(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry?.isIntersecting) {
          setRevealed(true)
          observer.disconnect()
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.05 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Before mount, render at full opacity/transform so SSR output matches and
  // there's no first-paint flash.
  const active = !mounted || revealed

  return (
    <div
      ref={ref}
      style={{
        opacity: active ? 1 : 0,
        transform: active ? "translateY(0)" : `translateY(${distancePx}px)`,
        transition: `opacity ${durationMs}ms ease-out ${delayMs}ms, transform ${durationMs}ms ease-out ${delayMs}ms`,
        willChange: "opacity, transform",
      }}
    >
      {children}
    </div>
  )
}
