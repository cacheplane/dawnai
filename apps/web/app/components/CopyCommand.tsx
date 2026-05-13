"use client"

import { useState } from "react"

interface Props {
  readonly command: string
  readonly className?: string
}

export function CopyCommand({ command, className }: Props) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // clipboard unavailable — silent no-op
    }
  }

  return (
    <div
      className={`font-mono text-sm text-ink-muted bg-surface inline-flex items-center gap-2 pl-4 pr-2 py-2 rounded-md border border-divider ${
        className ?? ""
      }`}
    >
      <span>
        <span className="text-accent-saas">$</span> {command}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : `Copy command: ${command}`}
        className="ml-1 p-1 rounded hover:bg-accent-saas-soft text-ink-muted hover:text-accent-saas transition-colors"
      >
        {copied ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            role="img"
            className="text-accent-saas"
          >
            <title>Copied</title>
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            role="img"
          >
            <title>Copy</title>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </div>
  )
}
