import { HttpAgent } from "@ag-ui/client"
import {
  CopilotRuntime,
  copilotRuntimeNextJSAppRouterEndpoint,
  ExperimentalEmptyAdapter,
} from "@copilotkit/runtime"
import type { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const dawnUrl = process.env.DAWN_SERVER_URL ?? "http://127.0.0.1:3001"
const agUiUrl = `${dawnUrl}/agui/${encodeURIComponent("/chat#agent")}`

// Register the Dawn /chat agent under CopilotKit's default agent id ("default").
// CopilotKit's sidebar resolves "default" when no agentId is specified.
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
