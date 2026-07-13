"use client"
import { CopilotKit, CopilotSidebar } from "@copilotkit/react-core/v2"

// Notes (verified against installed @copilotkit/react-core@1.62.3 types):
// - Use the `CopilotKit` wrapper (not bare `CopilotKitProvider`) per CopilotKit's own v2
//   guidance: it adds the error boundary, toasts, and threads provider around the context.
//   Its props are a superset of CopilotKitProviderProps (so `runtimeUrl` applies).
// - `CopilotSidebar` ships from `@copilotkit/react-core/v2`, not `@copilotkit/react-ui`
//   (react-ui's root export is the v1 CopilotSidebar, incompatible with the v2 context;
//   react-ui exposes no `/v2` JS export, only `/v2/styles.css`).
// - The runtime route registers the Dawn /chat agent under CopilotKit's default id.
// - `labels` is `Partial<CopilotChatLabels>`, whose header title field is `modalHeaderTitle`.
export default function Home() {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
      <main style={{ height: "100vh" }}>
        <CopilotSidebar defaultOpen labels={{ modalHeaderTitle: "Dawn chat" }} />
      </main>
    </CopilotKit>
  )
}
