"use client"
import { CopilotKit, CopilotSidebar } from "@copilotkit/react-core/v2"
import { PermissionInterrupt } from "./components/PermissionInterrupt"
import { TodosPanel } from "./components/TodosPanel"

// Notes (verified against installed @copilotkit/react-core@1.62.2 types):
// - Use the `CopilotKit` wrapper (not bare `CopilotKitProvider`) per CopilotKit's own v2
//   guidance: it adds the error boundary, toasts, and threads provider around the context.
//   Its props are a superset of CopilotKitProviderProps (so `runtimeUrl` applies).
// - `CopilotSidebar` ships from `@copilotkit/react-core/v2`, not `@copilotkit/react-ui`
//   (react-ui's root export is the v1 CopilotSidebar, incompatible with the v2 context;
//   react-ui exposes no `/v2` JS export, only `/v2/styles.css`).
// - Components/hooks that omit agentId resolve CopilotKit's default id ("default").
//   The runtime route (api/copilotkit/route.ts) registers the Dawn /chat agent under
//   "default", so the sidebar, useAgent, and useInterrupt all bind to it with no
//   per-component agentId. (Setting agentId on the sidebar alone did NOT reach the
//   chat component's internal useAgent, which raised "Agent 'default' not found".)
// - `labels` is `Partial<CopilotChatLabels>`, whose header title field is `modalHeaderTitle`.
export default function Home() {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
      <PermissionInterrupt />
      <div style={{ display: "flex", height: "100vh" }}>
        <TodosPanel />
        <main style={{ flex: 1 }}>
          <CopilotSidebar defaultOpen labels={{ modalHeaderTitle: "Dawn chat" }} />
        </main>
      </div>
    </CopilotKit>
  )
}
