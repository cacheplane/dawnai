"use client"
import { useRenderActivityMessage, useRenderToolCall } from "@copilotkit/react-core/v2"
import { useEffect, useRef } from "react"
import {
  buildTranscriptItems,
  type TranscriptItem,
  type TranscriptMessage,
} from "../lib/transcript"
import { EmptyState } from "./EmptyState"
import { PermissionInterrupt } from "./PermissionInterrupt"
import { RunError } from "./RunError"

export interface TranscriptProps {
  readonly messages: readonly TranscriptMessage[]
  readonly isRunning: boolean
  readonly onSelectSuggestion: (message: string) => void
  /** The last run failure, or null. Owned by `AppShell`. */
  readonly runError: string | null
  readonly onDismissRunError: () => void
  readonly onRunError: (error: unknown) => void
}

/**
 * The message list.
 *
 * The two `use*` hooks here are the manual half of what `<CopilotChat>` does
 * internally, and both are required now that this app renders its own
 * transcript:
 *
 * - `useRenderActivityMessage()` resolves an activity message against the
 *   renderers registered on the provider (`renderActivityMessages`), validating
 *   `content` with the renderer's schema. It is exported from
 *   `@copilotkit/react-core/v2` but NOT from `.../v2/headless`.
 * - `useRenderToolCall()` returns a render function for a
 *   `{ toolCall, toolMessage }` pair, resolved against the renderers registered
 *   by `useRenderTool` — that is `ToolCallCard`. Note the near-namesake:
 *   `useRenderTool` registers, `useRenderToolCall` renders.
 *
 * `PermissionInterrupt` is rendered at the end of the list, after the messages,
 * because that is where the run actually stopped. It is a `renderInChat: false`
 * interrupt, so it appears exactly where it is placed and nowhere else — with
 * the default (`true`) it would be published into `<CopilotChat>`, which this
 * app no longer mounts, and the permission gate would render nowhere at all.
 *
 * It is mounted UNCONDITIONALLY — outside the empty/non-empty branch — and that
 * is a correctness requirement, not tidiness. `useInterrupt` subscribes to the
 * agent from a mount effect, so branching on `items.length` would make the
 * subscription's existence depend on render timing: it would only be listening
 * if a commit happened between the send and the run finishing with an
 * interrupt. That happens to hold today (`addMessage` notifies and the
 * throttler is leading-edge, so the commit lands long before the round-trip),
 * but it is a race, not a guarantee, and it stops holding the moment a thread
 * is hydrated already parked — the run would have finished before the mount and
 * the gate would render nowhere, silently. Mounted unconditionally, there is no
 * window at all. The wrapper is `empty:hidden` so it costs no layout when
 * neither the gate nor an error is showing.
 */
export function Transcript({
  messages,
  isRunning,
  onSelectSuggestion,
  runError,
  onDismissRunError,
  onRunError,
}: TranscriptProps) {
  const { renderActivityMessage } = useRenderActivityMessage()
  const renderToolCall = useRenderToolCall()
  // NOT memoized on `messages`, and that is load-bearing. `AbstractAgent`
  // mutates its `messages` array in place (`addMessage` does `push`), so the
  // reference is stable across a run and `useMemo(..., [messages])` would keep
  // serving the list from before the push. The visible symptom is precise and
  // easy to misread: the user's own message never appears in the transcript,
  // because nothing replaces the array until the first server event does.
  // Rebuilding every render is cheap, and the provider's `defaultThrottleMs`
  // already caps how often that happens.
  const items = buildTranscriptItems(messages)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Follow the stream. No dependency array on purpose: a run appends text to an
  // existing message as often as it adds a new one, so "the messages changed"
  // is not a value this component can watch — every render is the signal.
  // Renders are already coalesced by the provider's `defaultThrottleMs`.
  useEffect(() => {
    const node = scrollRef.current
    if (node === null) return
    // Only follow if the reader is already at the bottom. Yanking someone who
    // scrolled up to re-read a citation is worse than not following at all.
    if (node.scrollHeight - node.scrollTop - node.clientHeight > 120) return
    node.scrollTop = node.scrollHeight
  })

  function renderItem(item: TranscriptItem) {
    switch (item.kind) {
      case "user":
        return (
          <div key={item.id} className="flex justify-end">
            <p className="max-w-[85%] whitespace-pre-wrap rounded-[var(--wb-radius)] border border-[var(--wb-border)] bg-[var(--wb-surface)] px-3.5 py-2 text-sm leading-6">
              {item.text}
            </p>
          </div>
        )
      case "assistant":
        return (
          <p key={item.id} className="whitespace-pre-wrap text-sm leading-7 tracking-tight">
            {item.text}
          </p>
        )
      case "reasoning":
        return (
          <p
            key={item.id}
            className="whitespace-pre-wrap border-l border-[var(--wb-border)] pl-3 text-[13px] italic leading-6 text-[var(--wb-muted)]"
          >
            {item.text}
          </p>
        )
      case "activity":
        return (
          <div key={item.id}>
            {renderActivityMessage({
              id: item.id,
              role: "activity",
              activityType: item.activityType,
              content: item.content,
            })}
          </div>
        )
      case "toolCall":
        return (
          <div key={item.id}>
            {renderToolCall({
              toolCall: item.toolCall,
              ...(item.toolResult !== undefined ? { toolMessage: item.toolResult } : {}),
            })}
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      {items.length === 0 ? (
        <EmptyState onSelectSuggestion={onSelectSuggestion} />
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8">
          {items.map(renderItem)}
          {isRunning ? (
            <p
              aria-live="polite"
              className="text-[13px] text-[var(--wb-muted)] motion-safe:animate-pulse"
            >
              Working…
            </p>
          ) : null}
        </div>
      )}
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 pb-8 empty:hidden">
        <PermissionInterrupt onError={onRunError} />
        {runError !== null ? <RunError message={runError} onDismiss={onDismissRunError} /> : null}
      </div>
    </div>
  )
}
