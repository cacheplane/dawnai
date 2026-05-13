import type { ReactNode } from "react"

interface CodeFrameProps {
  readonly children: ReactNode
  readonly label?: string
  readonly className?: string
}

/**
 * Browser-chrome frame for code or product visuals.
 * Renders a top bar with traffic-light dots and an optional filename label,
 * then the children below in a sunk surface.
 */
export function CodeFrame({ children, label, className = "" }: CodeFrameProps) {
  return (
    <div
      className={`rounded-xl border border-divider bg-page overflow-hidden ${className}`}
      style={{
        boxShadow:
          "0 1px 2px rgba(20,17,13,0.04), 0 8px 24px -8px rgba(20,17,13,0.08)",
      }}
    >
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-divider bg-surface-sunk">
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-divider-strong" />
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-divider-strong" />
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-divider-strong" />
        {label !== undefined ? (
          <span className="ml-3 text-xs text-ink-muted font-mono truncate">{label}</span>
        ) : null}
      </div>
      <div>{children}</div>
    </div>
  )
}
