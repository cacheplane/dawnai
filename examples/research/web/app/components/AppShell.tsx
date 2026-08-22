"use client"
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2"
import { useCallback, useEffect, useRef } from "react"
import type { WorkbenchThread } from "../lib/thread-source"
import { Composer } from "./Composer"
import { ThreadRail, UNTITLED_THREAD_LABEL } from "./ThreadRail"
import { Transcript } from "./Transcript"

export interface AppShellProps {
  readonly threads: readonly WorkbenchThread[]
  readonly activeThreadId: string | undefined
  readonly onSelectThread: (threadId: string) => void
  readonly onCreateThread: () => void
  /** Reported so the rail can title the thread from its first user message. */
  readonly onUserMessage: (message: string) => void
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
}: AppShellProps) {
  const { agent } = useAgent()
  const { copilotkit } = useCopilotKit()

  // Switching threads does not restore that thread's history in this slice —
  // there is no hydration from the server yet — but the previous thread's
  // messages must not sit there looking like they belong to the new one, so
  // the transcript is cleared. `pendingInterrupts` goes with them: leaving a
  // parked interrupt from the abandoned thread on the shared agent makes the
  // next run throw ("pending interrupt(s) not addressed by resume").
  const renderedThreadIdRef = useRef(activeThreadId)
  useEffect(() => {
    if (renderedThreadIdRef.current === activeThreadId) return
    renderedThreadIdRef.current = activeThreadId
    if (agent.isRunning) agent.abortRun()
    agent.pendingInterrupts = []
    agent.setMessages([])
  }, [activeThreadId, agent])

  const send = useCallback(
    async (message: string) => {
      agent.addMessage({ id: globalThis.crypto.randomUUID(), role: "user", content: message })
      onUserMessage(message)
      try {
        // `copilotkit.runAgent`, not `agent.runAgent`: the core call is what
        // attaches the frontend tools, agent context and run bookkeeping that
        // the registered renderers depend on.
        await copilotkit.runAgent({ agent })
      } catch (error) {
        console.error("AppShell: runAgent failed", error)
      }
    },
    [agent, copilotkit, onUserMessage],
  )

  const activeThread = threads.find((thread) => thread.id === activeThreadId)

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-64 shrink-0 flex-col gap-1 border-r border-[var(--wb-border)] bg-[var(--wb-rail)] py-4">
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
        <header className="flex h-13 shrink-0 items-center gap-2 border-b border-[var(--wb-border)] px-6">
          <h1 className="truncate text-[13px] font-medium tracking-tight">
            {activeThread?.title ?? UNTITLED_THREAD_LABEL}
          </h1>
          {agent.isRunning ? (
            <span className="shrink-0 text-[11px] uppercase tracking-[0.08em] text-[var(--wb-muted)]">
              running
            </span>
          ) : null}
        </header>
        <Transcript
          messages={agent.messages}
          isRunning={agent.isRunning}
          onSelectSuggestion={send}
        />
        <Composer onSend={send} isRunning={agent.isRunning} />
      </main>
    </div>
  )
}
