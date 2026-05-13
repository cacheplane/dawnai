import type { ReactNode } from "react"

interface CardProps {
  readonly children: ReactNode
  readonly tone?: "surface" | "page" | "sunk"
  readonly className?: string
}

const toneClasses: Record<NonNullable<CardProps["tone"]>, string> = {
  page: "bg-page",
  surface: "bg-surface",
  sunk: "bg-surface-sunk",
}

export function Card({ children, tone = "surface", className = "" }: CardProps) {
  return (
    <div
      className={`rounded-xl border border-divider ${toneClasses[tone]} ${className}`}
      style={{
        boxShadow:
          "0 1px 2px rgba(20,17,13,0.04), 0 8px 24px -8px rgba(20,17,13,0.08)",
      }}
    >
      {children}
    </div>
  )
}
