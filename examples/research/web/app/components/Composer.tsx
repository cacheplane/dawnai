"use client"
import { type KeyboardEvent, useState } from "react"

export interface ComposerProps {
  readonly onSend: (message: string) => void
  /** True while a run is in flight — the send button is unavailable until it settles. */
  readonly isRunning: boolean
}

export function Composer({ onSend, isRunning }: ComposerProps) {
  const [value, setValue] = useState("")
  const canSend = !isRunning && value.trim().length > 0

  function send() {
    if (!canSend) return
    onSend(value.trim())
    setValue("")
  }

  // Enter sends, Shift+Enter newlines. `isComposing` guards IME input: while a
  // Japanese or Chinese keyboard is composing, Enter commits the candidate and
  // must not send the message.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    send()
  }

  return (
    <div className="border-t border-[var(--wb-border)] px-6 py-4">
      <form
        className="mx-auto max-w-3xl"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <div className="flex items-end gap-2 rounded-[var(--wb-radius)] border border-[var(--wb-border)] bg-[var(--wb-surface)] p-2 transition-colors focus-within:border-[var(--wb-muted)]">
          <textarea
            rows={1}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask the research agent…"
            aria-label="Message"
            className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none placeholder:text-[var(--wb-muted)]"
          />
          <button
            type="submit"
            disabled={!canSend}
            className="wb-primary-action shrink-0 rounded-[calc(var(--wb-radius)-3px)] px-3.5 py-1.5 text-[13px] font-medium tracking-tight transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-accent-from)]"
          >
            {isRunning ? "Running…" : "Send"}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-[var(--wb-muted)]">
          Enter to send · Shift+Enter for a new line
        </p>
      </form>
    </div>
  )
}
