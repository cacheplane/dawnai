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
// - There is no ambient "default agent": every hook/component resolves its own agent id,
//   falling back to the literal "default" (@copilotkit/shared's DEFAULT_AGENT_ID) if
//   omitted. Our runtime registers `agents: { chat }`, so `agentId="chat"` is set
//   explicitly on `CopilotSidebar` and in `TodosPanel`/`PermissionInterrupt`'s hooks.
// - `labels` is `Partial<CopilotChatLabels>`, whose header title field is `modalHeaderTitle`.
export default function Home() {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
      <PermissionInterrupt />
      <div style={{ display: "flex", height: "100vh" }}>
        <TodosPanel />
        <main style={{ flex: 1 }}>
          <CopilotSidebar agentId="chat" defaultOpen labels={{ modalHeaderTitle: "Dawn chat" }} />
        </main>
      </div>
    </CopilotKit>
  )
}
