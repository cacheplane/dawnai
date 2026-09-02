"use client"

import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react"

type MediaTab = "video" | "code"

interface MediaSwitcherProps {
  readonly video: ReactNode
  readonly code: ReactNode
  readonly videoLabel?: string
  readonly codeLabel?: string
  readonly ariaLabel?: string
  readonly className?: string
}

export function MediaSwitcher({
  video,
  code,
  videoLabel = "Video",
  codeLabel = "Code",
  ariaLabel = "Media view",
  className = "",
}: MediaSwitcherProps) {
  const [selected, setSelected] = useState<MediaTab>("video")
  const tabRefs = useRef<Record<MediaTab, HTMLButtonElement | null>>({
    video: null,
    code: null,
  })
  const id = useId()

  const selectAndFocus = (tab: MediaTab) => {
    setSelected(tab)
    tabRefs.current[tab]?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let next: MediaTab | undefined
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
        next = selected === "video" ? "code" : "video"
        break
      case "Home":
        next = "video"
        break
      case "End":
        next = "code"
        break
      default:
        return
    }
    event.preventDefault()
    selectAndFocus(next)
  }

  const selectedLabel = selected === "video" ? videoLabel : codeLabel

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="mb-3 inline-flex rounded-lg border border-divider bg-surface-sunk p-1"
      >
        {(
          [
            ["video", videoLabel],
            ["code", codeLabel],
          ] as const
        ).map(([tab, label]) => (
          <button
            key={tab}
            ref={(element) => {
              tabRefs.current[tab] = element
            }}
            id={`${id}-${tab}-tab`}
            type="button"
            role="tab"
            aria-controls={`${id}-${tab}-panel`}
            aria-selected={selected === tab}
            tabIndex={selected === tab ? 0 : -1}
            onClick={() => setSelected(tab)}
            onKeyDown={handleKeyDown}
            className={[
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              selected === tab ? "bg-page text-ink shadow-sm" : "text-ink-muted hover:text-ink",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        id={`${id}-${selected}-panel`}
        role="tabpanel"
        aria-label={`${selectedLabel} content`}
        aria-labelledby={`${id}-${selected}-tab`}
      >
        {selected === "video" ? video : code}
      </div>
    </div>
  )
}
