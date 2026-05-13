import type { ReactNode } from "react"

interface EyebrowProps {
  readonly children: ReactNode
  readonly tone?: "default" | "accent"
}

export function Eyebrow({ children, tone = "default" }: EyebrowProps) {
  const colorClass = tone === "accent" ? "text-accent-saas" : "text-ink-dim"
  return (
    <p className={`text-xs font-semibold uppercase tracking-[0.06em] ${colorClass}`}>{children}</p>
  )
}
