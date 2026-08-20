"use client"
import { CopilotChatConfigurationProvider, CopilotKit } from "@copilotkit/react-core/v2"
import { useCallback, useEffect, useState } from "react"
import { AppShell } from "./components/AppShell"
import { workbenchActivityRenderers } from "./components/activity-renderers"
import { DemoSuggestions } from "./components/DemoSuggestions"
import { ToolCallCard } from "./components/ToolCallCard"
import {
  createLocalThreadSource,
  type ThreadSource,
  type WorkbenchThread,
} from "./lib/thread-source"

// Notes (verified against installed @copilotkit/react-core@1.68.3 types — see
// examples/chat/web/app/page.tsx for the original investigation):
// - Use the `CopilotKit` wrapper (not bare `CopilotKitProvider`) per CopilotKit's own v2
//   guidance: it adds the error boundary, toasts, and threads provider around the context.
//   Its props are a superset of CopilotKitProviderProps (so `runtimeUrl` applies).
// - The compatibility wrapper still defaults `useSingleEndpoint` to true. V2 transport
//   requires false so `/info` reaches the catch-all `api/copilotkit/[...path]/route.ts`.
// - `CopilotSidebar` ships from `@copilotkit/react-core/v2`, not `@copilotkit/react-ui`
//   (react-ui's root export is the v1 CopilotSidebar, incompatible with the v2 context;
//   react-ui exposes no `/v2` JS export, only `/v2/styles.css`). This app no longer uses
//   it — the workbench renders its own transcript and composer — but the import path is
//   recorded because the mistake is easy to repeat.
// - Components/hooks that omit agentId resolve CopilotKit's default id ("default").
//   The catch-all route (api/copilotkit/[...path]/route.ts) registers the Dawn /research route
//   under "default", so every hook binds without per-component agentId wiring.
// - `defaultThrottleMs` coalesces the useAgent re-renders that the transcript and panels
//   get from OnMessagesChanged/OnStateChanged. It defaults to UNTHROTTLED,
//   and a full research run streams hundreds of events, which pegs the renderer
//   (the UI froze outright). 100ms keeps it live-feeling while capping re-renders.
//
// Why `CopilotChatConfigurationProvider` is mounted here: `CopilotKit` does not
// provide one — `<CopilotChat>`/`<CopilotSidebar>` did, and those are gone. Without
// it `useCopilotChatConfiguration()` returns null and every thread-aware hook falls
// back to the default agent's own auto-minted thread, so selecting a row in the rail
// would change nothing. With `threadId` set, the provider is thread-controlled and
// `useAgent()` writes that id onto the agent (it only does so when the configuration
// reports `hasExplicitThreadId`, which a `threadId` prop implies).
export default function Home() {
  // `createLocalThreadSource` touches localStorage, which does not exist during
  // SSR — hence the guard. It stays null on the server; the effect below runs
  // only in the browser, so the server and the first client render agree
  // (no threads, no active id).
  const [source] = useState<ThreadSource | null>(() =>
    typeof window === "undefined" ? null : createLocalThreadSource(window.localStorage),
  )
  const [threads, setThreads] = useState<readonly WorkbenchThread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (source === null) return
    const existing = source.list()
    // Most-recent-first, so resuming means resuming the last conversation.
    const active = existing[0] ?? source.create()
    setThreads(source.list())
    setActiveThreadId(active.id)
  }, [source])

  const handleCreate = useCallback(() => {
    if (source === null) return
    // Clicking "New conversation" twice used to leave two identical untitled
    // rows. A thread stays untitled until its first user message lands, so
    // "the active thread has no title" is exactly "it is already the blank
    // conversation you are asking for" — make the second click a no-op.
    const active = threads.find((thread) => thread.id === activeThreadId)
    if (active !== undefined && active.title === undefined) return
    const created = source.create()
    setThreads(source.list())
    setActiveThreadId(created.id)
  }, [source, threads, activeThreadId])

  const handleSelect = useCallback((threadId: string) => {
    setActiveThreadId(threadId)
  }, [])

  const handleUserMessage = useCallback(
    (message: string) => {
      if (source === null || activeThreadId === undefined) return
      source.touch(activeThreadId, message)
      setThreads(source.list())
    },
    [source, activeThreadId],
  )

  return (
    <CopilotKit
      runtimeUrl="/api/copilotkit"
      useSingleEndpoint={false}
      defaultThrottleMs={100}
      renderActivityMessages={workbenchActivityRenderers}
    >
      <CopilotChatConfigurationProvider threadId={activeThreadId}>
        {/* Registration-only: both publish into CopilotKit's registries rather
            than rendering. `DemoSuggestions` is read back by `EmptyState`
            (useSuggestions), `ToolCallCard` by `Transcript` (useRenderToolCall). */}
        <DemoSuggestions />
        <ToolCallCard />
        <AppShell
          threads={threads}
          activeThreadId={activeThreadId}
          onSelectThread={handleSelect}
          onCreateThread={handleCreate}
          onUserMessage={handleUserMessage}
          threadSource={source}
        />
      </CopilotChatConfigurationProvider>
    </CopilotKit>
  )
}
