import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime"
import { HttpAgent } from "@ag-ui/client"
import type { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const dawnUrl = process.env.DAWN_SERVER_URL ?? "http://127.0.0.1:3002"
const agUiUrl = `${dawnUrl}/agui/${encodeURIComponent("/research#agent")}`

// Register the Dawn /research agent under CopilotKit's default agent id ("default").
// CopilotKit components/hooks that don't specify an agentId resolve "default", so
// registering it there means the sidebar and memory panel bind to this agent with
// no per-component wiring. (When a second agent is added, switch to named ids and
// explicit agentId on each consumer.)
const copilotRuntime = new CopilotRuntime({
  agents: { default: new HttpAgent({ url: agUiUrl }) },
})

export const POST = async (req: NextRequest): Promise<Response> => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime: copilotRuntime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: "/api/copilotkit",
  })
  return handleRequest(req)
}
