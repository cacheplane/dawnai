"use client"

import { Children, isValidElement, type ReactElement, type ReactNode, useState } from "react"

interface CodeGroupProps {
  readonly children: ReactNode
}

interface PreElementProps {
  readonly "data-rehype-pretty-code-title"?: string
  readonly "data-language"?: string
  readonly children?: ReactNode
}

export function CodeGroup({ children }: CodeGroupProps) {
  const blocks = Children.toArray(children).filter((c): c is ReactElement<PreElementProps> =>
    isValidElement(c),
  )
  const [active, setActive] = useState(0)
  if (blocks.length === 0) return null

  const titles = blocks.map(
    (block, i) => block.props["data-rehype-pretty-code-title"] ?? `File ${i + 1}`,
  )

  return (
    <div className="my-6 rounded-lg border border-border overflow-hidden bg-bg-card">
      <div role="tablist" className="flex bg-bg-card/60 border-b border-border-subtle">
        {titles.map((title, i) => (
          <button
            key={title}
            type="button"
            role="tab"
            aria-selected={active === i}
            onClick={() => setActive(i)}
            className={`px-3 py-2 text-xs font-mono transition-colors border-b-2 ${
              active === i
                ? "text-accent-amber border-accent-amber"
                : "text-text-muted border-transparent hover:text-text-primary"
            }`}
          >
            {title}
          </button>
        ))}
      </div>
      <div>{blocks[active]}</div>
    </div>
  )
}
