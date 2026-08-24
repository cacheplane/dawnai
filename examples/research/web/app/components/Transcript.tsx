"use client"
import {
  CopilotChatAssistantMessage,
  useRenderActivityMessage,
  useRenderToolCall,
} from "@copilotkit/react-core/v2"
import { useEffect, useRef } from "react"
import type { ThreadSource } from "../lib/thread-source"
import {
  buildTranscriptItems,
  type TranscriptItem,
  type TranscriptMessage,
} from "../lib/transcript"
import { EmptyState } from "./EmptyState"
import { HydratedInterrupts } from "./HydratedInterrupts"
import { PermissionInterrupt } from "./PermissionInterrupt"
import { RunError } from "./RunError"

/**
 * What a restore cannot bring back, said in the app rather than only in the
 * README. Subagent cards are derived from a live event stream the server does
 * not persist — the checkpoint holds messages, tool results and the plan, and
 * nothing else — so the cards the user watched appear are gone for good. The
 * wording is careful about that: new runs draw new cards, the old ones do not
 * come back. Exported so the tests assert the string the user reads.
 */
export const RESTORED_HISTORY_NOTICE =
  "Restored from this conversation's saved history. Subagent cards from earlier runs aren't saved — new ones appear as they run."

export interface TranscriptProps {
  /**
   * The active thread's id. Two consumers, both about permission gates:
   * `PermissionInterrupt`'s `key`, and `HydratedInterrupts`' fetch.
   *
   * `useInterrupt` keeps its OWN pending state: it is fed by
   * `onRunFinishedEvent` and cleared only by a *new* run, a failure, or
   * unmount — and its subscription effect is keyed `[agent]`, whose identity
   * does not change on a thread switch. Without a remount, thread A's
   * approve/deny card survives a switch to thread B and answers A's
   * interruptId against an agent now pointed at B's thread. Remounting happens
   * at switch time, long before any run, so it does not reintroduce the mount
   * race described below.
   */
  readonly threadKey: string | undefined
  readonly messages: readonly TranscriptMessage[]
  readonly isRunning: boolean
  readonly onSelectSuggestion: (message: string) => void
  /**
   * Whether these messages came back from the server's checkpoint rather than
   * from a live run — the condition for the note below about what a restore
   * cannot bring back.
   */
  readonly hasRestoredHistory: boolean
  /** The last run failure, or null. Owned by `AppShell`. */
  readonly runError: { readonly title: string; readonly message: string } | null
  readonly onDismissRunError: () => void
  readonly onRunError: (error: unknown) => void
  /** Passed straight to `HydratedInterrupts` — the seam it reads parked gates from. */
  readonly threadSource: ThreadSource | null
  /**
   * How many parked gates the hydrated source is showing. Reported up because
   * `AppShell` blocks the composer on it: `agent.pendingInterrupts` is empty
   * after a reload, so it cannot see them.
   */
  readonly onHydratedPendingChange: (count: number) => void
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
  threadKey,
  messages,
  isRunning,
  onSelectSuggestion,
  hasRestoredHistory,
  runError,
  onDismissRunError,
  onRunError,
  threadSource,
  onHydratedPendingChange,
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
            <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-wb border border-wb-border bg-wb-surface px-3.5 py-2 text-sm leading-6">
              {item.text}
            </p>
          </div>
        )
      case "assistant":
        // Markdown, not raw text. The agent is prompted to write cited reports,
        // so its answers arrive as `## Findings` / `- bullet` / `**bold**`, and
        // rendering them verbatim is the most visible thing lost when
        // `<CopilotSidebar>` went away.
        //
        // `CopilotChatAssistantMessage.MarkdownRenderer` is a pass-through to
        // Streamdown (already in the dependency graph via CopilotKit, and built
        // for *streaming* markdown — it tolerates the half-finished syntax that
        // arrives mid-token). Only the renderer, not `CopilotChatAssistantMessage`
        // itself, which would drag in the copy/thumbs/regenerate toolbar and its
        // `cpk:`-prefixed chrome. The look is `.wb-prose` in `app/theme.css`.
        return (
          <div key={item.id} className="wb-prose break-words">
            <CopilotChatAssistantMessage.MarkdownRenderer content={item.text} />
          </div>
        )
      case "reasoning":
        return (
          <p
            key={item.id}
            className="whitespace-pre-wrap break-words border-l border-wb-border pl-3 text-[13px] italic leading-6 text-wb-muted"
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
      default: {
        // Exhaustiveness, not a fallback. A new `TranscriptItem` kind must fail
        // to compile here rather than silently render as nothing.
        const unhandled: never = item
        return unhandled
      }
    }
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      {items.length === 0 ? <EmptyState onSelectSuggestion={onSelectSuggestion} /> : null}
      {/*
        Rendered OUTSIDE the live region below (see `RESTORED_HISTORY_NOTICE`):
        it is static context for what is already on screen, not an addition
        worth announcing.
      */}
      {hasRestoredHistory ? (
        <p className="mx-auto max-w-3xl px-6 pt-8 text-[12px] leading-5 text-wb-muted">
          {RESTORED_HISTORY_NOTICE}
        </p>
      ) : null}
      {/*
        The live region is the message list itself, and it is rendered in both
        states so it exists BEFORE its content changes — a region inserted at
        the same moment as its first content is unreliably announced across
        assistive tech, which is what the old `aria-live` on the "Working…"
        element was. `role="log"` is the right role for an append-only
        transcript, and `aria-relevant="additions text"` covers the answer
        streaming in character by character, not just whole new messages.
      */}
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        className={
          items.length === 0
            ? "mx-auto max-w-3xl px-6"
            : `mx-auto flex max-w-3xl flex-col gap-4 px-6 pb-8 ${hasRestoredHistory ? "pt-4" : "pt-8"}`
        }
      >
        {items.map(renderItem)}
        {/* Persistent, with toggling text — same reason as the region above. */}
        <p className="text-[13px] text-wb-muted empty:hidden motion-safe:animate-pulse">
          {isRunning ? "Working…" : ""}
        </p>
      </div>
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 pb-8 empty:hidden">
        {/*
          The two sources of permission gates, side by side and deliberately
          both mounted. `PermissionInterrupt` shows the ones this browser
          watched a run park on; `HydratedInterrupts` shows the ones the server
          was already holding when the page loaded — the reload case, which
          cannot go through `useInterrupt` at all (there is no public setter
          for its pending state). They cannot show the same interrupt twice:
          while a run is in flight the hydrated source shows only the card the
          user just answered, and at rest it filters out every id in
          `agent.pendingInterrupts` — the same set the live card renders from.

          `HydratedInterrupts` takes the thread id as a PROP rather than as its
          `key`: its own effect keys on that id, clears the previous thread's
          list and re-asks the server, so a remount would only throw away the
          answer it is about to fetch again.
        */}
        <PermissionInterrupt key={threadKey} onError={onRunError} isResuming={isRunning} />
        <HydratedInterrupts
          threadId={threadKey}
          threadSource={threadSource}
          onError={onRunError}
          onPendingChange={onHydratedPendingChange}
        />
        {runError !== null ? (
          <RunError
            title={runError.title}
            message={runError.message}
            onDismiss={onDismissRunError}
          />
        ) : null}
      </div>
    </div>
  )
}
