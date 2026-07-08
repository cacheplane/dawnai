import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime"
import { HttpAgent } from "@ag-ui/client"
import type { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const dawnUrl = process.env.DAWN_SERVER_URL ?? "http://127.0.0.1:3001"
const agUiUrl = `${dawnUrl}/agui/${encodeURIComponent("/chat#agent")}`

const copilotRuntime = new CopilotRuntime({
  agents: { chat: new HttpAgent({ url: agUiUrl }) },
})

export const POST = async (req: NextRequest): Promise<Response> => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime: copilotRuntime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: "/api/copilotkit",
  })
  return handleRequest(req)
}
