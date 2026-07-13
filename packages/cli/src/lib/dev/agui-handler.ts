import type { IncomingMessage, ServerResponse } from "node:http"
import { EventType, RunAgentInputSchema } from "@ag-ui/core"
import { createAgUiTranslator, encodeAgUiSse, mapRunInput } from "@dawn-ai/ag-ui"
import type { DawnMiddleware, MiddlewareRequest } from "@dawn-ai/sdk"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import { streamResolvedRoute } from "../runtime/execute-route.js"
import type { SandboxManager } from "../runtime/sandbox-manager.js"
import { extractRouteParams, parseHeaders, runMiddleware } from "./middleware.js"
import type { RuntimeRegistry } from "./runtime-registry.js"

interface AgUiRequestOptions {
  readonly appRoot: string
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  readonly threadsStore: ThreadsStore
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly routeKey: string
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString("utf8")
}

export async function handleAgUiRequest(options: AgUiRequestOptions): Promise<void> {
  const {
    appRoot,
    middleware,
    registry,
    threadsStore,
    sandboxManager,
    signal,
    request,
    response,
    routeKey,
  } = options

  const raw = await readBody(request)
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    response.statusCode = 400
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ error: { kind: "request_error", message: "Malformed body" } }))
    return
  }
  const parsed = RunAgentInputSchema.safeParse(parsedJson)
  if (!parsed.success) {
    response.statusCode = 400
    response.setHeader("content-type", "application/json")
    response.end(
      JSON.stringify({ error: { kind: "request_error", message: "Invalid RunAgentInput" } }),
    )
    return
  }
  const input = parsed.data

  const route = registry.lookup(routeKey)
  if (!route) {
    response.statusCode = 404
    response.setHeader("content-type", "application/json")
    response.end(
      JSON.stringify({ error: { kind: "request_error", message: `Unknown route: ${routeKey}` } }),
    )
    return
  }

  // Run app middleware before starting the run — parity with runs/stream and
  // runs/wait so auth/rate-limit/context middleware applies to /agui too.
  const mwRequest: MiddlewareRequest = {
    assistantId: route.assistantId,
    headers: parseHeaders(request),
    method: request.method ?? "POST",
    params: extractRouteParams(route.routeId, input),
    routeId: route.routeId,
    url: request.url ?? `/agui/${routeKey}`,
  }
  const mwResult = await runMiddleware(middleware, mwRequest)
  if (mwResult.action === "reject") {
    response.statusCode = mwResult.status
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(mwResult.body))
    return
  }

  const threadId = input.threadId
  const existing = await threadsStore.getThread(threadId)
  if (!existing) await threadsStore.createThread({ thread_id: threadId })
  await threadsStore.updateStatus(threadId, "busy")

  const { dawnInput, resumeDecision } = mapRunInput(input)
  const translator = createAgUiTranslator({ threadId, runId: input.runId })

  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  })
  for (const e of translator.begin()) response.write(encodeAgUiSse(e))

  try {
    for await (const chunk of streamResolvedRoute({
      appRoot,
      input: dawnInput,
      ...(mwResult.context ? { middlewareContext: mwResult.context } : {}),
      ...(resumeDecision ? { resumeDecision } : {}),
      routeFile: route.routeFile,
      routeId: route.routeId,
      routePath: route.routePath,
      ...(sandboxManager ? { sandboxManager } : {}),
      signal,
      threadId,
    })) {
      for (const e of translator.translate(chunk)) response.write(encodeAgUiSse(e))
    }
    for (const e of translator.end()) response.write(encodeAgUiSse(e))
    await threadsStore.updateStatus(threadId, "idle")
  } catch (error) {
    response.write(
      encodeAgUiSse({
        type: EventType.RUN_ERROR,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)
  }
  response.end()
}
