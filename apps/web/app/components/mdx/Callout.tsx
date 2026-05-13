import type { ReactNode } from "react"

type CalloutType = "info" | "tip" | "warn" | "danger"

interface Props {
  readonly type?: CalloutType
  readonly title?: string
  readonly children: ReactNode
}

const STYLES: Record<CalloutType, { border: string; icon: string; glyph: string }> = {
  info: {
    border: "border-accent-amber/40",
    icon: "text-accent-saas",
    glyph: "\u24D8", // ⓘ
  },
  tip: {
    border: "border-accent-green/40",
    icon: "text-accent-green",
    glyph: "\u2728", // ✨
  },
  warn: {
    border: "border-yellow-500/40",
    icon: "text-yellow-500",
    glyph: "\u26A0", // ⚠
  },
  danger: {
    border: "border-red-500/40",
    icon: "text-red-500",
    glyph: "\u2716", // ✖
  },
}

export function Callout({ type = "info", title, children }: Props) {
  const s = STYLES[type]
  return (
    <aside
      className={`my-6 p-4 bg-surface border rounded-lg flex gap-3 items-start ${s.border}`}
      role="note"
    >
      <span className={`text-base mt-0.5 shrink-0 ${s.icon}`} aria-hidden>
        {s.glyph}
      </span>
      <div className="flex-1 min-w-0">
        {title && <p className="font-semibold text-ink mb-1 text-sm">{title}</p>}
        <div className="text-sm text-ink-muted leading-relaxed [&>p]:m-0 [&>p+p]:mt-2">
          {children}
        </div>
      </div>
    </aside>
  )
}
