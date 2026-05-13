"use client"

import {
  Children,
  createContext,
  type HTMLAttributes,
  isValidElement,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from "react"

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
    >
      <title>Copy</title>
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
    >
      <title>Copied</title>
      <path d="M3 8.5l3.5 3.5L13 5" />
    </svg>
  )
}

interface PreProps extends HTMLAttributes<HTMLPreElement> {
  readonly children?: ReactNode
  readonly "data-language"?: string
  readonly "data-theme"?: string
}

/**
 * When a `<Pre>` is rendered inside a `<CodeGroup>`, the group owns the chrome
 * (frame + header). We use this context to tell the inner `<Pre>` to render
 * just its code body, with no border or header bar.
 */
export const HeadlessPreContext = createContext(false)

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  js: "js",
  javascript: "js",
  jsx: "jsx",
  json: "json",
  text: "text",
  plaintext: "text",
  md: "md",
  markdown: "md",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  css: "css",
}

export function tabLabel(language: string | undefined, title: string | undefined): string {
  if (title) return title
  if (!language) return "code"
  return LANGUAGE_LABELS[language.toLowerCase()] ?? language
}

export function Pre({ children, className, ...rest }: PreProps) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const headless = useContext(HeadlessPreContext)
  const title = (rest as Record<string, unknown>)["data-rehype-pretty-code-title"] as
    | string
    | undefined
  const language = rest["data-language"]

  const copy = async () => {
    const text = ref.current?.textContent ?? ""
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (headless) {
    return (
      <pre
        ref={ref}
        className={`overflow-x-auto pl-3 pr-4 py-3 text-[13px] leading-[1.55] font-mono ${className ?? ""}`}
        {...rest}
      >
        {children}
      </pre>
    )
  }

  const label = tabLabel(language, title)

  return (
    <div className="relative my-6 rounded-lg border border-divider bg-surface overflow-hidden">
      <CodeHeaderRow
        left={<TabPill label={label} active />}
        right={<CopyButton onCopy={copy} copied={copied} />}
      />
      <pre
        ref={ref}
        className={`overflow-x-auto pl-3 pr-4 py-3 text-[13px] leading-[1.55] font-mono ${className ?? ""}`}
        {...rest}
      >
        {children}
      </pre>
    </div>
  )
}

/**
 * Header bar used above the code body: left-aligned tab pill(s) plus the copy
 * button pinned to the right. The active pill renders its own underline.
 */
export function CodeHeaderRow({
  left,
  right,
}: {
  readonly left: ReactNode
  readonly right: ReactNode
}) {
  return (
    <div className="flex items-end justify-between px-3 pt-2 border-b border-divider bg-surface/60">
      <div className="flex items-end gap-1">{left}</div>
      <div className="pb-1.5">{right}</div>
    </div>
  )
}

export function TabPill({
  label,
  active,
  onClick,
}: {
  readonly label: string
  readonly active: boolean
  readonly onClick?: () => void
}) {
  const isButton = typeof onClick === "function"
  const baseClasses = `relative px-2 py-1.5 font-mono text-xs transition-colors ${
    active ? "text-ink" : "text-ink-dim hover:text-ink"
  }`
  const underline = active ? (
    <span
      aria-hidden
      className="absolute left-1 right-1 -bottom-px h-[2px] rounded-full bg-accent-saas"
    />
  ) : null

  if (isButton) {
    return (
      <button
        type="button"
        onClick={onClick}
        role="tab"
        aria-selected={active}
        className={baseClasses}
      >
        {label}
        {underline}
      </button>
    )
  }
  return (
    <span className={baseClasses}>
      {label}
      {underline}
    </span>
  )
}

export function CopyButton({
  onCopy,
  copied,
}: {
  readonly onCopy: () => void
  readonly copied: boolean
}) {
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied" : "Copy code"}
      className={`p-1.5 rounded border transition-colors ${
        copied
          ? "border-accent-saas/40 text-accent-saas bg-accent-saas/10"
          : "border-divider text-ink-dim hover:text-ink hover:border-text-muted"
      }`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}

/**
 * MDX `<figure>` mapping for rehype-pretty-code output. When a fence carries a
 * `title="..."` meta, the plugin wraps the code in a `<figure>` containing a
 * `<figcaption>` (the title) and the `<pre>`. Without this mapping, the
 * figcaption renders as plain text above the code block. RehypeFigure absorbs
 * the figcaption into the standard header chrome and renders the inner Pre
 * headless.
 */
// Recursively pull the first non-empty string descendant out of a React node.
// Used to extract the figcaption's title text regardless of whether MDX
// delivers it as a bare string, an array, or nested inside a wrapper element —
// hydration mismatches happen when server and client see different shapes here.
function extractTextContent(node: ReactNode): string | undefined {
  if (typeof node === "string") {
    const trimmed = node.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof node === "number") return String(node)
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = extractTextContent(child)
      if (found) return found
    }
    return undefined
  }
  if (isValidElement(node)) {
    const props = (node.props ?? {}) as { children?: ReactNode }
    return extractTextContent(props.children)
  }
  return undefined
}

export function RehypeFigure({
  children,
  ...rest
}: {
  readonly children?: ReactNode
} & Record<string, unknown>) {
  const isRehype = rest["data-rehype-pretty-code-figure"] !== undefined
  // Walk children deterministically with Children.toArray so server and client
  // see the same shape — manual iteration on a possibly-single-child `children`
  // was producing different `el.props` reads under hydration in some MDX
  // configurations.
  let title: string | undefined
  let preLanguage: string | undefined
  let preChild: ReactNode = null

  for (const c of Children.toArray(children)) {
    if (!isValidElement(c)) continue
    const props = (c.props ?? {}) as Record<string, unknown> & { children?: ReactNode }
    if (c.type === "figcaption") {
      const direct = props["data-rehype-pretty-code-title"]
      if (typeof direct === "string" && direct.length > 0) {
        title = direct
      } else {
        title = extractTextContent(props.children)
      }
      continue
    }
    // Otherwise treat as the inner Pre (or anything else passed through).
    const lang = props["data-language"]
    if (typeof lang === "string") preLanguage = lang
    preChild = c
  }

  if (!isRehype || !preChild) {
    return <figure {...rest}>{children}</figure>
  }

  const label = tabLabel(preLanguage, title)

  return (
    <figure
      {...rest}
      className="relative my-6 rounded-lg border border-divider bg-surface overflow-hidden"
    >
      <RehypeFigureHeader label={label} preChild={preChild} />
      <HeadlessPreContext.Provider value={true}>{preChild}</HeadlessPreContext.Provider>
    </figure>
  )
}

function RehypeFigureHeader({ label, preChild }: { label: string; preChild: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    // The DOM <pre> is the next sibling of this header; resolve via the
    // wrapping figure to find it.
    const figure = ref.current?.closest("figure")
    const pre = figure?.querySelector("pre")
    const text = pre?.textContent ?? ""
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  // Silence preChild-unused warning when the header doesn't need it:
  void preChild
  return (
    <span ref={ref}>
      <CodeHeaderRow
        left={<TabPill label={label} active />}
        right={<CopyButton onCopy={copy} copied={copied} />}
      />
    </span>
  )
}

export function InlineCode({
  children,
  className,
}: {
  readonly children?: ReactNode
  readonly className?: string
}) {
  return <code className={`mdx-inline-code ${className ?? ""}`}>{children}</code>
}
