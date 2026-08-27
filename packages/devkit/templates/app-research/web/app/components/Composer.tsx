"use client"
import { type KeyboardEvent, useId, useRef, useState } from "react"
import { neutralButton } from "./ui"

export interface ComposerProps {
  readonly onSend: (message: string) => void
  /** Aborts the in-flight run. */
  readonly onStop: () => void
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

export function Composer({ onSend, onStop, isRunning, isAwaitingApproval }: ComposerProps) {
  const [value, setValue] = useState("")
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const hintId = useId()
  const isBlocked = isRunning || isAwaitingApproval
  const canSend = !isBlocked && value.trim().length > 0

  function send() {
    if (!canSend) return
    onSend(value.trim())
    setValue("")
    // Sending empties the box, which flips `canSend` false and disables the
    // very button the user just activated — and a disabled element cannot hold
    // focus, so it lands on <body> and the next Tab restarts from the top of
    // the page. Put the caret back where the user is working.
    inputRef.current?.focus()
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
  // reasons it is — and say it in the accessibility tree too, via the
  // `aria-describedby` below, since "the text under the box" is a visual
  // relationship that assistive tech cannot infer.
  const placeholder = isAwaitingApproval
    ? "Waiting on your decision above…"
    : isRunning
      ? "The agent is working…"
      : "Ask the research agent…"
  const hint = isAwaitingApproval
    ? "Allow or deny the request above to continue this conversation."
    : "Enter to send · Shift+Enter for a new line"

  return (
    <div className="border-t border-wb-border px-6 py-4">
      <form
        className="mx-auto max-w-3xl"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <div className="flex items-end gap-2 rounded-wb border border-wb-border bg-wb-surface p-2 transition-colors focus-within:border-wb-muted">
          <textarea
            ref={inputRef}
            rows={1}
            value={value}
            // `readOnly` + `aria-disabled`, NOT `disabled`. An interrupt can
            // arrive mid-sentence, and `disabled` would yank focus out of the
            // box the user is typing in, hide it from assistive tech, and lose
            // the draft's reachability. `readOnly` keeps it focusable and
            // readable while refusing edits.
            readOnly={isAwaitingApproval}
            aria-disabled={isAwaitingApproval}
            aria-describedby={hintId}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label="Message"
            // `field-sizing-content` grows the box with the text, bounded by
            // `max-h-40` — without it, "Shift+Enter for a new line" produces a
            // one-row box the user cannot see their own message in.
            className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none field-sizing-content placeholder:text-wb-muted read-only:cursor-not-allowed"
          />
          {isRunning ? (
            // Swapped in rather than sitting alongside Send: the two are never
            // both meaningful, and without it a hung stream (where `isRunning`
            // never clears) leaves the composer dead with no way out but
            // abandoning the conversation.
            <button type="button" onClick={onStop} className={`${neutralButton("md")} shrink-0`}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              className="wb-primary-action wb-focus shrink-0 rounded-wb-sm px-3.5 py-1.5 text-[13px] font-medium tracking-tight transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isAwaitingApproval ? "Waiting" : "Send"}
            </button>
          )}
        </div>
        <p id={hintId} className="mt-2 text-[11px] text-wb-muted">
          {hint}
        </p>
      </form>
    </div>
  )
}
