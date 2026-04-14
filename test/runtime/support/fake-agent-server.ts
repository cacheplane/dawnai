import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

// Keep the fake server around for isolated client-transport tests. Runtime parity now
// uses the real `dawn dev` helper under test/runtime/support/dev-server.ts.
export interface FakeAgentServerRequest {
  readonly jsonBody: Record<string, unknown>
  readonly request: IncomingMessage
  readonly url: string | null
}

export interface FakeAgentServerResponse {
  readonly body?: unknown
  readonly rawBody?: string
  readonly statusCode: number
}

export interface FakeAgentServer {
  readonly close: () => Promise<void>
  readonly requests: FakeAgentServerRequest[]
  readonly url: string
}

export async function startFakeAgentServer(
  handler: (request: FakeAgentServerRequest) => Promise<FakeAgentServerResponse>,
  requestPath = "/runs/wait",
): Promise<FakeAgentServer> {
  const requests: FakeAgentServerRequest[] = []
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== requestPath) {
      response.statusCode = 404
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ error: "not found" }))
      return
    }

    const rawBody = await readRequestBody(request)
    const jsonBody = JSON.parse(rawBody) as Record<string, unknown>
    const record = {
      jsonBody,
      request,
      url: request.url ?? null,
    }
    requests.push(record)

    const result = await handler(record)

    response.statusCode = result.statusCode
    response.setHeader("content-type", "application/json")
    response.end(result.rawBody ?? JSON.stringify(result.body))
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()

  if (!address || typeof address === "string") {
    throw new Error("Fake Agent Server did not bind to a TCP address")
  }

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
    },
    requests,
    url: `http://127.0.0.1:${(address as AddressInfo).port}`,
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }

  return Buffer.concat(chunks).toString("utf8")
}
