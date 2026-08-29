"use client"
import { CopilotKit, CopilotSidebar } from "@copilotkit/react-core/v2"
import { dawnActivityRenderers } from "@dawn-ai/ag-ui/react"
import { DemoSuggestions } from "./components/DemoSuggestions"
import { PermissionInterrupt } from "./components/PermissionInterrupt"

// Notes (verified against installed @copilotkit/react-core@1.68.3 types):
// - Use the `CopilotKit` wrapper (not bare `CopilotKitProvider`) per CopilotKit's own v2
//   guidance: it adds the error boundary, toasts, and threads provider around the context.
//   Its props are a superset of CopilotKitProviderProps (so `runtimeUrl` applies).
// - The compatibility wrapper still defaults `useSingleEndpoint` to true. V2 transport
//   requires false so `/info` reaches the catch-all `api/copilotkit/[...path]/route.ts`.
// - `CopilotSidebar` ships from `@copilotkit/react-core/v2`, not `@copilotkit/react-ui`
//   (react-ui's root export is the v1 CopilotSidebar, incompatible with the v2 context;
//   react-ui exposes no `/v2` JS export, only `/v2/styles.css`).
// - The runtime route registers the Dawn /chat agent under CopilotKit's default id.
// - `labels` is `Partial<CopilotChatLabels>`, whose header title field is `modalHeaderTitle`.
// - `renderActivityMessages` is required here, not optional polish: this route ships
//   `src/app/chat/plan.md`, so the agent plans with `writeTodos`, and Dawn presents
//   planning (and subagent delegation) ONLY as an activity — no generic tool frames.
//   CopilotKit renders nothing for an activity it has no renderer for, so without
//   `dawnActivityRenderers` the user would see the agent go silent while it plans.
export default function Home() {
  return (
    <CopilotKit
      runtimeUrl="/api/copilotkit"
      useSingleEndpoint={false}
      defaultThrottleMs={100}
      renderActivityMessages={dawnActivityRenderers}
    >
      <DemoSuggestions />
      <PermissionInterrupt />
      <main style={{ height: "100vh" }}>
        <CopilotSidebar defaultOpen labels={{ modalHeaderTitle: "Dawn chat" }} />
      </main>
    </CopilotKit>
  )
}
