"use client"

import { type HTMLAttributes, type ReactNode, useRef, useState } from "react"

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

export function Pre({ children, className, ...rest }: PreProps) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
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

  return (
    <div className="relative my-6 rounded-lg border border-border bg-bg-card overflow-hidden">
      {title ? (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-bg-card/60">
          <span className="font-mono text-xs text-text-muted">{title}</span>
          <div className="flex items-center gap-2">
            {language ? (
              <span className="font-mono text-[0.65rem] uppercase tracking-wide text-text-dim">
                {language}
              </span>
            ) : null}
            <CopyButton onCopy={copy} copied={copied} />
          </div>
        </div>
      ) : (
        <div className="absolute top-2 right-2 z-10">
          <CopyButton onCopy={copy} copied={copied} />
        </div>
      )}
      <pre
        ref={ref}
        className={`overflow-x-auto px-4 py-3 text-sm leading-6 font-mono ${className ?? ""}`}
        {...rest}
      >
        {children}
      </pre>
    </div>
  )
}

function CopyButton({ onCopy, copied }: { readonly onCopy: () => void; readonly copied: boolean }) {
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
