import { HttpAgent } from "@ag-ui/client"
import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const dawnUrl = process.env.DAWN_SERVER_URL ?? "http://127.0.0.1:3001"
const agUiUrl = `${dawnUrl}/agui/${encodeURIComponent("/chat#agent")}`

const handler = createCopilotRuntimeHandler({
  runtime: new CopilotRuntime({
    agents: { default: new HttpAgent({ url: agUiUrl }) },
  }),
  basePath: "/api/copilotkit",
})

export const GET = handler
export const POST = handler
