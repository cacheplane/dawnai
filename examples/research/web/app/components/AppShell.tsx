"use client"
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2"
import { DAWN_PLAN_ACTIVITY_TYPE } from "@dawn-ai/ag-ui"
import { planActivityContentSchema } from "@dawn-ai/ag-ui/react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { HydratedThread } from "../lib/hydrate"
import type { ThreadSource, WorkbenchThread } from "../lib/thread-source"
import type { TranscriptMessage } from "../lib/transcript"
import { Composer } from "./Composer"
import { ThreadRail, UNTITLED_THREAD_LABEL } from "./ThreadRail"
import { Transcript } from "./Transcript"

/**
 * Which CopilotKit core errors are the user's problem, and what to call them.
 *
 * `onError` fires for the whole `CopilotKitCoreErrorCode` enum, not just runs:
 * transcription failures, tool-registration mistakes, and
 * `subscriber_callback_failed` — a bug thrown by one of *our* activity
 * renderers — all arrive on the same channel. Showing every one of them as
 * "The run failed" is a lie in both directions, so this is an allowlist, and
 * anything absent stays a console line.
 *
 * Keyed by the enum's string values rather than the enum itself: importing
 * `@copilotkit/core` for a comparison would add a direct dependency on a
 * package this app only has transitively, and TypeScript refuses to compare an
 * enum-typed value against a string literal anyway.
 */
const RUN_ERROR_TITLES: Readonly<Record<string, string>> = {
  agent_run_failed: "The run failed",
  agent_run_failed_event: "The run failed",
  agent_run_error_event: "The run failed",
  agent_connect_failed: "Lost the connection to the agent",
  agent_thread_locked: "This conversation is already running",
  agent_not_found: "The research agent is not registered",
  runtime_info_fetch_failed: "Cannot reach the Dawn server",
}

/**
 * The restored thread, with its checkpointed plan put back in front of it.
 *
 * `values.todos` arrives unvalidated (the stream path's plan activity is the
 * only one anything checks), so it goes through the same
 * `planActivityContentSchema` `activity-renderers.tsx` registers — a malformed
 * plan then renders no card at all rather than arbitrary JSON in a plan
 * shaped box. The id is minted here because the checkpoint has none; the
 * stream path uses `dawn:plan:${runId}`, and `hydrated:plan:${threadId}` is
 * the same idea for a read that has no run: stable across re-renders and
 * re-hydrations, unique per thread.
 */
function withRestoredPlan(thread: HydratedThread, threadId: string): readonly TranscriptMessage[] {
  if (thread.todos.length === 0) return thread.messages
  const parsed = planActivityContentSchema.safeParse({ todos: thread.todos })
  if (!parsed.success) return thread.messages
  return [
    {
      activityType: DAWN_PLAN_ACTIVITY_TYPE,
      content: { todos: parsed.data.todos },
      id: `hydrated:plan:${threadId}`,
      role: "activity",
    },
    ...thread.messages,
  ]
}

interface RunErrorState {
  readonly title: string
  readonly message: string
}

export interface AppShellProps {
  readonly threads: readonly WorkbenchThread[]
  readonly activeThreadId: string | undefined
  readonly onSelectThread: (threadId: string) => void
  readonly onCreateThread: () => void
  /** Reported so the rail can title the thread from its first user message. */
  readonly onUserMessage: (message: string) => void
  /**
   * Where a thread's stored history comes from. Null only during SSR, where
   * `page.tsx` cannot build the localStorage-backed source — there is nothing
   * to hydrate on the server anyway, since the active thread id is undefined
   * until the browser's first effect.
   */
  readonly threadSource: ThreadSource | null
}

/**
 * The two-column shell, and the only place that talks to the agent.
 *
 * `useAgent()` is deliberately called with NO arguments. Its props have exactly
 * two legal shapes: unscoped (`useAgent()` / `useAgent({ agentId })`), which
 * takes its thread from the surrounding chat configuration, or thread-scoped
 * (`{ agentId, runtimeAgentId, threadId }` — all three, or it throws at
 * runtime), which registers a *private proxied* agent. The unscoped form is
 * what this app wants: `useInterrupt`, `useSuggestions` and the tool-call
 * renderers all resolve their agent the same way, so one
 * `CopilotChatConfigurationProvider` (mounted in `page.tsx`) keeps every hook
 * bound to the same agent and the same thread. A private per-thread agentId
 * would move the transcript off the agent the other three still watch.
 *
 * The hook does not return messages — it subscribes and re-renders, and the
 * state is read off `agent` (`agent.messages`, `agent.isRunning`).
 */
export function AppShell({
  threads,
  activeThreadId,
  onSelectThread,
  onCreateThread,
  onUserMessage,
  threadSource,
}: AppShellProps) {
  const { agent } = useAgent()
  const { copilotkit } = useCopilotKit()
  const [runError, setRunError] = useState<RunErrorState | null>(null)
  // True only once a hydrate has actually put something back on screen, which
  // is the condition for the "what did not come back" note in `Transcript`.
  const [restoredHistory, setRestoredHistory] = useState(false)

  // The agent instance a hydrate that is already in flight should apply to.
  //
  // `useAgent` swaps the provisional stand-in for the real agent once the
  // runtime `/info` sync resolves, and the effect below deliberately does not
  // re-run for that (see `renderedThreadIdRef`) — so a hydrate started before
  // the swap closes over an agent nobody is rendering any more, and its
  // messages would land nowhere. Reading the latest instance out of a ref at
  // resolution time is what makes the restore survive the swap, without
  // re-issuing the request and racing the one in flight. Written from an
  // effect, not during render: a render can be thrown away.
  const agentRef = useRef(agent)
  useEffect(() => {
    agentRef.current = agent
  }, [agent])

  // `pendingInterrupts` is populated while the RUN_FINISHED event is applied,
  // which is strictly before `onRunFinalized` fires — and `onRunFinalized` is
  // one of the notifications `useAgent` re-renders on. So by the time this
  // component re-renders after a parked run, the count below is already right.
  //
  // `&& !agent.isRunning` because the flag would otherwise stay true for the
  // whole resumed run: `pendingInterrupts` is not cleared until that run's own
  // RUN_FINISHED lands, which for a research turn can be a minute later. The
  // user decided long ago; insisting they have not — and showing "running" and
  // "awaiting approval" side by side — is just wrong. The composer stays
  // blocked either way, via `isRunning`, but now for the true reason.
  const isAwaitingApproval = agent.pendingInterrupts.length > 0 && !agent.isRunning

  const reportRunError = useCallback((error: unknown) => {
    setRunError({
      title: "The run failed",
      message: error instanceof Error ? error.message : String(error),
    })
  }, [])

  const dismissRunError = useCallback(() => {
    setRunError(null)
  }, [])

  // THE seam for run failures — not the `catch` around `runAgent`.
  // `copilotkit.runAgent` does not reject when a run fails: it catches, calls
  // `emitError`, and returns `{ result: undefined, newMessages: [] }`. So an
  // unreachable server, a 500 from `/api/copilotkit`, or the pending-interrupt
  // throw all resolve normally and a `try/catch` alone would show the user
  // nothing (verified live: the row never appeared until this subscription
  // existed). Errors surface only here, as `CopilotKitCoreErrorCode` events.
  // `<CopilotSidebar>` was the previous subscriber; deleting it is what left
  // the shell with no failure state at all.
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: ({ error, code }) => {
        const title = RUN_ERROR_TITLES[String(code)]
        if (title === undefined) {
          console.error(`AppShell: unshown CopilotKit error (${String(code)})`, error)
          return
        }
        setRunError({ title, message: error.message })
      },
    })
    return () => {
      subscription.unsubscribe()
    }
  }, [copilotkit])

  // Switching threads clears the transcript, then refills it from the server.
  //
  // Worth stating precisely, because CopilotKit has a replay path that looks
  // like it would apply and does not. `copilotkit.connectAgent()` asks the
  // runtime to replay a thread's historic events, but the only two callers of
  // it live inside `<CopilotChat>`, which this app does not mount, and
  // `useAgent`'s own thread effect does exactly one thing in 1.66.4:
  // `agent.threadId = resolvedThreadId`. Verified live: switching away from a
  // three-message thread and back leaves it empty and fires no network request
  // at all. The server holds that history and this client has to ask for it
  // itself, which is what the `threadSource.hydrate` call below does.
  //
  // So the previous thread's messages must not sit there looking like they
  // belong to the new one. `pendingInterrupts` goes with them: leaving a
  // parked interrupt from the abandoned thread on the shared agent makes the
  // next run throw ("pending interrupt(s) not addressed by resume").
  //
  // The ref is not redundant with the dependency array, and deleting it breaks
  // the app: `agent` is a dependency too, and its identity CHANGES when
  // `useAgent` swaps the provisional stand-in for the real agent once the
  // runtime `/info` sync resolves. Without the ref, that swap re-runs this
  // effect and wipes a transcript nobody asked to leave.
  const renderedThreadIdRef = useRef(activeThreadId)
  useEffect(() => {
    if (renderedThreadIdRef.current === activeThreadId) return
    renderedThreadIdRef.current = activeThreadId
    if (agent.isRunning) agent.abortRun()
    agent.pendingInterrupts = []
    agent.setMessages([])
    setRunError(null)
    setRestoredHistory(false)
    if (activeThreadId === undefined || threadSource === null) return

    // `AppShell` does not fetch: the seam does, so the LangGraph Platform
    // implementation is a swap rather than a rewrite of this effect.
    const hydratingThreadId = activeThreadId
    void threadSource.hydrate(hydratingThreadId).then(
      (thread) => {
        // Staleness is checked against the ref, NOT against a flag flipped in
        // the effect's cleanup: this effect re-runs (and would therefore clean
        // up) whenever `agent`'s identity changes, which would cancel a
        // perfectly good hydrate for the thread still on screen. The ref only
        // moves when the user actually switches threads, which is exactly the
        // case where thread A's history must not be painted into thread B.
        if (renderedThreadIdRef.current !== hydratingThreadId) return
        const messages = withRestoredPlan(thread, hydratingThreadId)
        // An empty result is the normal answer for a thread that has never
        // run, so it is silent: no error row, and no `setMessages` either,
        // since the clear above already left the transcript empty. Leaving it
        // alone also means a user who started typing into a brand-new thread
        // does not have their own message wiped by its own 404.
        if (messages.length === 0) return
        // The user got ahead of the network: they typed into the thread while
        // its history was still loading. Their message is the live one, and
        // it may already have a run attached to it — replacing the list under
        // that run would drop the message and orphan the run's appends. The
        // restore is what gets skipped.
        if (agentRef.current.messages.length > 0) return
        // `TranscriptMessage` is a deliberate supertype of AG-UI's own
        // `Message` union (see `transcript.ts`) so that either installed copy
        // of `@ag-ui/core` assigns INTO it; going the other way needs the
        // cast. The shapes `hydrate.ts` builds are the real ones — verified
        // against `MessageSchema` — so this widens nothing at runtime.
        agentRef.current.setMessages(messages as Parameters<typeof agentRef.current.setMessages>[0])
        setRestoredHistory(true)
      },
      (error: unknown) => {
        if (renderedThreadIdRef.current !== hydratingThreadId) return
        setRunError({
          title: "Could not restore this conversation",
          message: error instanceof Error ? error.message : String(error),
        })
      },
    )
  }, [activeThreadId, agent, threadSource])

  const send = useCallback(
    async (message: string) => {
      setRunError(null)
      agent.addMessage({ id: globalThis.crypto.randomUUID(), role: "user", content: message })
      onUserMessage(message)
      try {
        // `copilotkit.runAgent`, not `agent.runAgent`: the core call is what
        // attaches the frontend tools, agent context and run bookkeeping that
        // the registered renderers depend on.
        await copilotkit.runAgent({ agent })
      } catch (error) {
        // A backstop, not the main path (see the subscription above): only the
        // rejections core rethrows rather than swallows land here.
        console.error("AppShell: runAgent failed", error)
        reportRunError(error)
      }
    },
    [agent, copilotkit, onUserMessage, reportRunError],
  )

  const stop = useCallback(() => {
    agent.abortRun()
  }, [agent])

  const activeThread = threads.find((thread) => thread.id === activeThreadId)

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="flex w-64 shrink-0 flex-col gap-1 border-r border-wb-border bg-wb-rail py-4">
        <div className="px-4 pb-4">
          <span className="wb-brand-mark text-[15px] font-semibold tracking-tight">
            Dawn research
          </span>
        </div>
        <ThreadRail
          threads={threads}
          activeThreadId={activeThreadId}
          onSelect={onSelectThread}
          onCreate={onCreateThread}
        />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-13 shrink-0 items-center gap-2 border-b border-wb-border px-6">
          <h1 className="truncate text-[13px] font-medium tracking-tight">
            {activeThread?.title ?? UNTITLED_THREAD_LABEL}
          </h1>
          {agent.isRunning || isAwaitingApproval ? (
            <span className="shrink-0 text-[11px] uppercase tracking-[0.08em] text-wb-muted">
              {agent.isRunning ? "running" : "awaiting approval"}
            </span>
          ) : null}
        </header>
        {/*
          `threadKey` and the `Composer` key below both end component state at a
          thread boundary, and both are bug fixes rather than hygiene — see
          `Transcript` for what `useInterrupt` does with its own state, and
          `Composer` for the draft.

          `Transcript` takes the id as a PROP rather than as its own `key`
          because only `PermissionInterrupt`, deep inside it, needs the
          remount; keying the whole transcript would also throw away the scroll
          position and remount the empty state on every switch.
        */}
        <Transcript
          threadKey={activeThreadId}
          messages={agent.messages}
          isRunning={agent.isRunning}
          onSelectSuggestion={send}
          restoredHistory={restoredHistory}
          runError={runError}
          onDismissRunError={dismissRunError}
          onRunError={reportRunError}
        />
        <Composer
          key={activeThreadId}
          onSend={send}
          onStop={stop}
          isRunning={agent.isRunning}
          isAwaitingApproval={isAwaitingApproval}
        />
      </main>
    </div>
  )
}
