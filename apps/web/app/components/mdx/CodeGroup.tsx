"use client"

import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useRef,
  useState,
} from "react"
import { CodeHeaderRow, CopyButton, HeadlessPreContext, TabPill, tabLabel } from "./CodeBlock"

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
  const ref = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  if (blocks.length === 0) return null

  const labels = blocks.map((block, i) => {
    const title = block.props["data-rehype-pretty-code-title"]
    const language = block.props["data-language"]
    if (title) return title
    if (language) return tabLabel(language, undefined)
    return `File ${i + 1}`
  })

  const copy = async () => {
    const text = ref.current?.textContent ?? ""
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="my-6 rounded-lg border border-border overflow-hidden bg-bg-card">
      <CodeHeaderRow
        left={
          <div role="tablist" className="flex items-end gap-1">
            {labels.map((label, i) => (
              <TabPill
                key={label}
                label={label}
                active={active === i}
                onClick={() => setActive(i)}
              />
            ))}
          </div>
        }
        right={<CopyButton onCopy={copy} copied={copied} />}
      />
      <div ref={ref}>
        <HeadlessPreContext.Provider value={true}>{blocks[active]}</HeadlessPreContext.Provider>
      </div>
    </div>
  )
}
