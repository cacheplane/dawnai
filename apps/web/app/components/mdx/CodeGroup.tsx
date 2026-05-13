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
  readonly "data-language"?: string
  readonly children?: ReactNode
}

interface FigureChildProps {
  readonly children?: ReactNode
}

interface FigCaptionProps {
  readonly children?: ReactNode
  readonly "data-rehype-pretty-code-title"?: string
}

interface NormalizedBlock {
  readonly key: string
  readonly label: string
  readonly pre: ReactElement<PreElementProps>
}

// Detect elements by prop shape rather than type identity. In the Next.js App
// Router, MDX (rendered as a server component) hands components to CodeGroup
// (a client component) as client-reference objects — not the literal imported
// functions — so `child.type === Pre` does not match. Props are stable across
// that boundary.
function isPreElement(node: unknown): node is ReactElement<PreElementProps> {
  if (!isValidElement(node)) return false
  if (node.type === "figcaption") return false
  const props = (node.props ?? {}) as Record<string, unknown>
  if (props["data-rehype-pretty-code-figure"] !== undefined) return false
  return typeof props["data-language"] === "string"
}

function isFigureElement(node: unknown): node is ReactElement<FigureChildProps> {
  if (!isValidElement(node)) return false
  const props = (node.props ?? {}) as Record<string, unknown>
  return props["data-rehype-pretty-code-figure"] !== undefined
}

function isFigCaption(node: unknown): node is ReactElement<FigCaptionProps> {
  return isValidElement(node) && node.type === "figcaption"
}

function extractTitle(captionProps: FigCaptionProps): string | undefined {
  const direct = captionProps["data-rehype-pretty-code-title"]
  if (typeof direct === "string" && direct.length > 0) return direct
  let title: string | undefined
  Children.forEach(captionProps.children, (c) => {
    if (typeof c === "string" && c.length > 0 && !title) title = c
  })
  return title
}

function normalizeBlock(child: ReactNode, index: number): NormalizedBlock | null {
  if (!isValidElement(child)) return null

  // Case 1: bare <Pre> — fence without a title meta.
  if (isPreElement(child)) {
    const language = child.props["data-language"]
    const label = tabLabel(language, undefined) || `File ${index + 1}`
    return { key: `${index}:${language ?? "pre"}`, label, pre: child }
  }

  // Case 2: figure wrapping figcaption + Pre — fence with a title meta. The
  // figure may be a literal `<figure>` element or a mapped `RehypeFigure`
  // component; both expose `data-rehype-pretty-code-figure` on their props.
  if (isFigureElement(child)) {
    let title: string | undefined
    let pre: ReactElement<PreElementProps> | null = null
    Children.forEach(child.props.children, (grand) => {
      if (isFigCaption(grand)) {
        title = extractTitle(grand.props)
      } else if (isPreElement(grand)) {
        pre = grand
      }
    })
    if (!pre) return null
    const inner: ReactElement<PreElementProps> = pre
    const language = inner.props["data-language"]
    const label = title ?? tabLabel(language, undefined) ?? `File ${index + 1}`
    return { key: `${index}:${title ?? language ?? "pre"}`, label, pre: inner }
  }

  return null
}

export function CodeGroup({ children }: CodeGroupProps) {
  const blocks = Children.toArray(children)
    .map((c, i) => normalizeBlock(c, i))
    .filter((b): b is NormalizedBlock => b !== null)

  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  if (blocks.length === 0) return null

  const copy = async () => {
    const text = ref.current?.textContent ?? ""
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const current = blocks[active] ?? blocks[0]
  if (!current) return null

  return (
    <div className="my-6 rounded-lg border border-divider overflow-hidden bg-surface">
      <CodeHeaderRow
        left={
          <div role="tablist" className="flex items-end gap-1">
            {blocks.map((b, i) => (
              <TabPill
                key={b.key}
                label={b.label}
                active={active === i}
                onClick={() => setActive(i)}
              />
            ))}
          </div>
        }
        right={<CopyButton onCopy={copy} copied={copied} />}
      />
      <div ref={ref}>
        <HeadlessPreContext.Provider value={true}>{current.pre}</HeadlessPreContext.Provider>
      </div>
    </div>
  )
}
