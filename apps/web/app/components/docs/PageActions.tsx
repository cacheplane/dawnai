"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"

interface PageActionsProps {
  readonly slug: string
  readonly promptSlug?: string
  readonly promptBody?: string
}

const CANONICAL_BASE = "https://dawnai.dev"
const GITHUB_EDIT_BASE = "https://github.com/cacheplane/dawnai/edit/main/apps/web/content/docs"

type Feedback = "idle" | "copying" | "copied" | "error"

function pageUrl(slug: string): string {
  return `${CANONICAL_BASE}/docs/${slug}`
}

function aiPrompt(slug: string): string {
  return `Read this Dawn AI docs page and help me apply it to my project: ${pageUrl(slug)}`
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function DotsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="3" cy="8" r="1.4" fill="currentColor" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      <circle cx="13" cy="8" r="1.4" fill="currentColor" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function ClipboardIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function PageIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  )
}

function ChatBubbleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  )
}

function SparkIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2l2.39 6.96L21 11l-6.61 2.04L12 20l-2.39-6.96L3 11l6.61-2.04L12 2z" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  )
}

interface MenuItem {
  readonly key: string
  readonly icon: React.ReactNode
  readonly title: string
  readonly subtitle: string
  readonly onSelect: () => void | Promise<void>
  readonly external?: boolean
}

export function PageActions({ slug, promptSlug, promptBody }: PageActionsProps) {
  const [open, setOpen] = useState(false)
  const [primaryFeedback, setPrimaryFeedback] = useState<Feedback>("idle")
  const [activeItem, setActiveItem] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const hasPrompt = Boolean(promptSlug && promptBody)

  const flashItem = useCallback((key: string) => {
    setActiveItem(key)
    setTimeout(() => setActiveItem((cur) => (cur === key ? null : cur)), 1600)
  }, [])

  const handleCopyPrompt = useCallback(async () => {
    if (!promptBody) return
    setPrimaryFeedback("copying")
    const ok = await copyText(promptBody)
    setPrimaryFeedback(ok ? "copied" : "error")
    setTimeout(() => setPrimaryFeedback("idle"), 2000)
  }, [promptBody])

  const handleCopyMarkdown = useCallback(async () => {
    try {
      const res = await fetch(`/api/markdown/${slug}`)
      if (!res.ok) throw new Error(String(res.status))
      const text = await res.text()
      await copyText(text)
      flashItem("markdown")
    } catch {
      flashItem("markdown-error")
    }
  }, [slug, flashItem])

  const handleCopyPromptFromMenu = useCallback(async () => {
    if (!promptBody) return
    await copyText(promptBody)
    flashItem("prompt")
  }, [promptBody, flashItem])

  const openChatGPT = useCallback(() => {
    const url = `https://chatgpt.com/?hints=search&q=${encodeURIComponent(aiPrompt(slug))}`
    window.open(url, "_blank", "noopener,noreferrer")
  }, [slug])

  const openassistant = useCallback(() => {
    const url = `https://assistant.ai/new?q=${encodeURIComponent(aiPrompt(slug))}`
    window.open(url, "_blank", "noopener,noreferrer")
  }, [slug])

  const openGitHub = useCallback(() => {
    window.open(`${GITHUB_EDIT_BASE}/${slug}.mdx`, "_blank", "noopener,noreferrer")
  }, [slug])

  // Build the menu items. On mobile, "Copy prompt" appears at the top of the menu when a prompt exists.
  const baseItems: MenuItem[] = [
    {
      key: "markdown",
      icon: <PageIcon />,
      title: "Copy page as Markdown",
      subtitle: "Raw MDX for pasting into an LLM",
      onSelect: handleCopyMarkdown,
    },
    {
      key: "chatgpt",
      icon: <ChatBubbleIcon />,
      title: "Open in ChatGPT",
      subtitle: "Send this page to ChatGPT",
      onSelect: openChatGPT,
      external: true,
    },
    {
      key: "assistant",
      icon: <SparkIcon />,
      title: "Open in assistant",
      subtitle: "Send this page to assistant",
      onSelect: openassistant,
      external: true,
    },
    {
      key: "github",
      icon: <PencilIcon />,
      title: "Edit on GitHub",
      subtitle: "Suggest changes via pull request",
      onSelect: openGitHub,
      external: true,
    },
  ]

  const mobilePromptItem: MenuItem | null = hasPrompt
    ? {
        key: "prompt",
        icon: <ClipboardIcon />,
        title: "Copy prompt",
        subtitle: "Paste into your coding agent",
        onSelect: handleCopyPromptFromMenu,
      }
    : null

  // Outside click + Escape
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onClick)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  function renderItem(item: MenuItem) {
    const flashed = activeItem === item.key
    return (
      <button
        key={item.key}
        type="button"
        role="menuitem"
        onClick={async () => {
          await item.onSelect()
          if (item.external) setOpen(false)
        }}
        className="w-full text-left px-3 py-2 flex items-start gap-3 hover:bg-surface focus:bg-surface focus:outline-none transition-colors"
      >
        <span className="mt-0.5 text-ink-dim shrink-0">{item.icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-ink">
            {flashed ? "Copied" : item.title}
          </span>
          <span className="block text-xs text-ink-dim leading-snug">{item.subtitle}</span>
        </span>
      </button>
    )
  }

  return (
    <div ref={containerRef} className="relative flex items-center gap-2">
      {hasPrompt && (
        <button
          type="button"
          onClick={handleCopyPrompt}
          className="hidden md:inline-flex items-center gap-2 px-3 py-1.5 border border-accent-amber/40 text-accent-saas rounded-md text-xs font-mono hover:border-accent-amber hover:bg-accent-saas/5 transition-colors"
          aria-label={primaryFeedback === "copied" ? "Prompt copied" : "Copy prompt to clipboard"}
        >
          {primaryFeedback === "copied" ? (
            <>
              <CheckIcon />
              Copied
            </>
          ) : (
            <>
              <ClipboardIcon />
              Copy prompt
            </>
          )}
        </button>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Page actions"
        className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-divider text-ink-dim hover:text-ink hover:border-divider-strong transition-colors"
      >
        <DotsIcon />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-full mt-2 w-72 rounded-lg border border-divider bg-surface shadow-lg z-30 py-1 focus:outline-none"
        >
          {mobilePromptItem && <div className="md:hidden">{renderItem(mobilePromptItem)}</div>}
          {baseItems.map(renderItem)}
        </div>
      )}
    </div>
  )
}
