"use client"

import { Children, isValidElement, type ReactElement, type ReactNode, useState } from "react"

interface TabsProps {
  readonly children: ReactNode
}

interface TabProps {
  readonly label: string
  readonly children: ReactNode
}

interface TabElementProps {
  readonly label: string
  readonly children: ReactNode
}

export function Tabs({ children }: TabsProps) {
  const tabs = Children.toArray(children).filter((child): child is ReactElement<TabElementProps> =>
    isValidElement(child),
  )
  const [active, setActive] = useState(0)
  if (tabs.length === 0) return null

  return (
    <div className="my-6 border border-divider rounded-lg overflow-hidden">
      <div role="tablist" className="flex bg-surface border-b border-divider">
        {tabs.map((tab, i) => (
          <button
            key={tab.props.label}
            type="button"
            role="tab"
            aria-selected={active === i}
            onClick={() => setActive(i)}
            className={`px-4 py-2 text-xs font-mono transition-colors border-b-2 ${
              active === i
                ? "text-accent-saas border-accent-amber"
                : "text-ink-dim border-transparent hover:text-ink"
            }`}
          >
            {tab.props.label}
          </button>
        ))}
      </div>
      <div className="p-4 text-sm text-ink-muted">{tabs[active]?.props.children}</div>
    </div>
  )
}

export function Tab({ children }: TabProps) {
  return <>{children}</>
}
