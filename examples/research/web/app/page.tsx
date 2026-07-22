"use client"
import { CopilotKit, CopilotSidebar } from "@copilotkit/react-core/v2"
import { MemoryCandidates } from "./components/MemoryCandidates"
import { ToolCallCard } from "./components/ToolCallCard"

// Notes (verified against installed @copilotkit/react-core@1.62.3 types — see
// examples/chat/web/app/page.tsx for the original investigation):
// - Use the `CopilotKit` wrapper (not bare `CopilotKitProvider`) per CopilotKit's own v2
//   guidance: it adds the error boundary, toasts, and threads provider around the context.
//   Its props are a superset of CopilotKitProviderProps (so `runtimeUrl` applies).
// - `CopilotSidebar` ships from `@copilotkit/react-core/v2`, not `@copilotkit/react-ui`
//   (react-ui's root export is the v1 CopilotSidebar, incompatible with the v2 context;
//   react-ui exposes no `/v2` JS export, only `/v2/styles.css`).
// - Components/hooks that omit agentId resolve CopilotKit's default id ("default").
//   The runtime route (api/copilotkit/route.ts) registers the Dawn /research route
//   under "default", so the sidebar and memory panel bind without per-component
//   agentId wiring.
// - `labels` is `Partial<CopilotChatLabels>`, whose header title field is `modalHeaderTitle`.
// - `defaultThrottleMs` coalesces the useAgent re-renders that the sidebar transcript
//   and panels get from OnMessagesChanged/OnStateChanged. It defaults to UNTHROTTLED,
//   and a full research run streams hundreds of events, which pegs the renderer
//   (the UI froze outright). 100ms keeps it live-feeling while capping re-renders.
export default function Home() {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit" defaultThrottleMs={100}>
      <ToolCallCard />
      <div style={{ display: "flex", height: "100vh" }}>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 240 }}>
          <MemoryCandidates />
        </div>
        <main style={{ flex: 1 }}>
          <CopilotSidebar defaultOpen labels={{ modalHeaderTitle: "Dawn research" }} />
        </main>
      </div>
    </CopilotKit>
  )
}
