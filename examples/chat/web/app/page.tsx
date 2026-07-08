"use client"
import { CopilotKitProvider, CopilotSidebar } from "@copilotkit/react-core/v2"
import { PermissionInterrupt } from "./components/PermissionInterrupt"
import { TodosPanel } from "./components/TodosPanel"

// Deviations from the plan (verified against installed @copilotkit/react-core@1.62.2 types):
// - `CopilotSidebar` ships from `@copilotkit/react-core/v2`, not `@copilotkit/react-ui`
//   (react-ui's root export is the v1 CopilotSidebar, which is not compatible with the
//   v2 CopilotKitProvider context; react-ui's package.json exposes no `/v2` JS export,
//   only `/v2/styles.css`).
// - `CopilotKitProvider` has no `agent` prop (see CopilotKitProviderProps) — there is no
//   ambient "default agent" mechanism. Every hook/component resolves its own agent id,
//   defaulting to the literal string "default" (@copilotkit/shared's DEFAULT_AGENT_ID) if
//   not passed explicitly. So `agentId="chat"` is set directly on `CopilotSidebar`, and
//   in `TodosPanel`/`PermissionInterrupt` on their respective hooks.
// - `labels` is `Partial<CopilotChatLabels>`, whose sidebar/header title field is
//   `modalHeaderTitle`, not `title`.
export default function Home() {
  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit">
      <PermissionInterrupt />
      <div style={{ display: "flex", height: "100vh" }}>
        <TodosPanel />
        <main style={{ flex: 1 }}>
          <CopilotSidebar agentId="chat" defaultOpen labels={{ modalHeaderTitle: "Dawn chat" }} />
        </main>
      </div>
    </CopilotKitProvider>
  )
}
