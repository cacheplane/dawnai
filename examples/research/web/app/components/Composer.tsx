"use client"
import { type KeyboardEvent, useState } from "react"

export interface ComposerProps {
  readonly onSend: (message: string) => void
  /** True while a run is in flight. */
  readonly isRunning: boolean
  /**
   * True while the agent is parked on an unresolved interrupt.
   *
   * A separate flag from `isRunning`, not a refinement of it: when Dawn's
   * permission gate parks a run, the run has *finished* — `isRunning` is false
   * and `agent.pendingInterrupts` is non-empty. Gating on `isRunning` alone
   * therefore leaves the composer live under an open approve/deny card, and
   * sending from there throws `Thread has N pending interrupt(s) not addressed
   * by resume` from inside `runAgent` — after the user's message is already in
   * the transcript.
   */
  readonly isAwaitingApproval: boolean
}

export function Composer({ onSend, isRunning, isAwaitingApproval }: ComposerProps) {
  const [value, setValue] = useState("")
  const isBlocked = isRunning || isAwaitingApproval
  const canSend = !isBlocked && value.trim().length > 0

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

  // A greyed-out box with no explanation reads as broken. Say which of the two
  // reasons it is, in the placeholder and again under the box.
  const placeholder = isAwaitingApproval
    ? "Waiting on your decision above…"
    : isRunning
      ? "The agent is working…"
      : "Ask the research agent…"
  const hint = isAwaitingApproval
    ? "Allow or deny the request above to continue this conversation."
    : "Enter to send · Shift+Enter for a new line"
  const label = isAwaitingApproval ? "Waiting" : isRunning ? "Running…" : "Send"

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
            disabled={isAwaitingApproval}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label="Message"
            className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none placeholder:text-[var(--wb-muted)] disabled:cursor-not-allowed"
          />
          <button
            type="submit"
            disabled={!canSend}
            className="wb-primary-action shrink-0 rounded-[calc(var(--wb-radius)-3px)] px-3.5 py-1.5 text-[13px] font-medium tracking-tight transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-accent-from)]"
          >
            {label}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-[var(--wb-muted)]">{hint}</p>
      </form>
    </div>
  )
}
