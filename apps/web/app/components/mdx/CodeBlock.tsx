"use client"

import {
  createContext,
  type HTMLAttributes,
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
        className={`overflow-x-auto px-4 py-3 text-[13px] leading-[1.55] font-mono ${className ?? ""}`}
        {...rest}
      >
        {children}
      </pre>
    )
  }

  const label = tabLabel(language, title)

  return (
    <div className="relative my-6 rounded-lg border border-border bg-bg-card overflow-hidden">
      <CodeHeaderRow
        left={<TabPill label={label} active />}
        right={<CopyButton onCopy={copy} copied={copied} />}
      />
      <pre
        ref={ref}
        className={`overflow-x-auto px-4 py-3 text-[13px] leading-[1.55] font-mono ${className ?? ""}`}
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
    <div className="flex items-end justify-between px-3 pt-2 border-b border-border-subtle bg-bg-card/60">
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
    active ? "text-text-primary" : "text-text-muted hover:text-text-primary"
  }`
  const underline = active ? (
    <span
      aria-hidden
      className="absolute left-1 right-1 -bottom-px h-[2px] rounded-full bg-gradient-to-r from-accent-amber to-accent-amber-deep"
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
          ? "border-accent-amber/40 text-accent-amber bg-accent-amber/10"
          : "border-border text-text-muted hover:text-text-primary hover:border-text-muted"
      }`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
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
