import type { IncomingMessage, ServerResponse } from "node:http"
import { RunAgentInputSchema } from "@ag-ui/core"
import { type DawnAgentStreamChunk, fromRunAgentInput, toAguiEvents } from "@dawn-ai/ag-ui"
import { encodeAgUiSse } from "@dawn-ai/ag-ui/sse"
import type { DawnMiddleware, MiddlewareRequest } from "@dawn-ai/sdk"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { streamResolvedRoute } from "../runtime/execute-route.js"
import type { SandboxManager } from "../runtime/sandbox-manager.js"
import type { StreamChunk } from "../runtime/stream-types.js"
import { abortableAsyncIterable } from "./abortable-iterable.js"
import { runMiddleware } from "./middleware.js"
import { readPendingInterrupts, resolveAgUiResume } from "./pending-interrupts.js"
import { extractRouteParams, parseHeaders } from "./request-context.js"
import type { RuntimeRegistry } from "./runtime-registry.js"
import { createRequestErrorBody } from "./server-errors.js"

interface AgUiRequestOptions {
  readonly appRoot: string
  readonly checkpointer: BaseCheckpointSaver
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  readonly threadsStore: ThreadsStore
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly routeKey: string
  readonly streamRoute?: typeof streamResolvedRoute
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString("utf8")
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(body))
}

async function* normalizeDawnStream(
  chunks: AsyncIterable<StreamChunk>,
): AsyncGenerator<DawnAgentStreamChunk> {
  for await (const chunk of chunks) {
    switch (chunk.type) {
      case "chunk":
        yield {
          type: "token",
          data: typeof chunk.data === "string" ? chunk.data : String(chunk.data ?? ""),
        }
        break
      case "tool_call": {
        const toolCall = chunk as Extract<StreamChunk, { readonly type: "tool_call" }>
        yield {
          type: "tool_call",
          data: {
            ...(toolCall.id ? { id: toolCall.id } : {}),
            name: toolCall.name,
            input: toolCall.input,
          },
        }
        break
      }
      case "tool_result": {
        const toolResult = chunk as Extract<StreamChunk, { readonly type: "tool_result" }>
        yield {
          type: "tool_result",
          data: {
            ...(toolResult.id ? { id: toolResult.id } : {}),
            name: toolResult.name,
            output: toolResult.output,
          },
        }
        break
      }
      case "done":
        yield {
          type: "done",
          data: (chunk as Extract<StreamChunk, { readonly type: "done" }>).output,
        }
        break
      default:
        yield {
          type: chunk.type,
          data: (chunk as { readonly type: string; readonly data: unknown }).data,
        }
    }
  }
}

export async function handleAgUiRequest(options: AgUiRequestOptions): Promise<void> {
  const {
    appRoot,
    checkpointer,
    middleware,
    registry,
    threadsStore,
    sandboxManager,
    signal: shutdownSignal,
    request,
    response,
    routeKey,
    streamRoute = streamResolvedRoute,
  } = options

  const requestController = new AbortController()
  const abortRequest = (message: string) => {
    if (!requestController.signal.aborted) requestController.abort(new Error(message))
  }
  const onRequestAborted = () => abortRequest("AG-UI request aborted")
  const onResponseClose = () => {
    if (!response.writableEnded) abortRequest("AG-UI response closed")
  }
  request.on("aborted", onRequestAborted)
  response.on("close", onResponseClose)
  const signal = AbortSignal.any([shutdownSignal, requestController.signal])

  try {
    const raw = await readBody(request)
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      sendJson(response, 400, createRequestErrorBody("Malformed body"))
      return
    }

    const parsed = RunAgentInputSchema.safeParse(parsedJson)
    if (!parsed.success) {
      sendJson(response, 400, createRequestErrorBody("Invalid RunAgentInput"))
      return
    }
    const input = parsed.data

    const route = registry.lookup(routeKey)
    if (!route) {
      sendJson(response, 404, createRequestErrorBody(`Unknown route: ${routeKey}`))
      return
    }

    const dawnInput = fromRunAgentInput(input)
    const middlewareRequest: MiddlewareRequest = {
      assistantId: route.assistantId,
      headers: parseHeaders(request),
      method: request.method ?? "POST",
      params: extractRouteParams(route.routeId, dawnInput.raw),
      routeId: route.routeId,
      url: request.url ?? `/agui/${routeKey}`,
    }
    const middlewareResult = await runMiddleware(middleware, middlewareRequest)
    if (middlewareResult.action === "reject") {
      sendJson(response, middlewareResult.status, middlewareResult.body)
      return
    }

    const newestUserMessage = [...dawnInput.messages]
      .reverse()
      .find((message) => message.role === "user")
    const pending = (await readPendingInterrupts(checkpointer, input.threadId)) ?? {
      interrupts: [],
      malformed: false,
    }
    const resumeResolution = resolveAgUiResume(dawnInput.resume, pending)
    if (!resumeResolution.ok) {
      sendJson(
        response,
        resumeResolution.status,
        createRequestErrorBody(resumeResolution.message, { code: resumeResolution.code }),
      )
      return
    }

    const threadId = input.threadId
    if (!(await threadsStore.getThread(threadId))) {
      await threadsStore.createThread({ thread_id: threadId })
    }
    await threadsStore.updateMetadata(threadId, { route: routeKey })
    await threadsStore.updateStatus(threadId, "busy")

    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    })

    try {
      const routeStream = streamRoute({
        appRoot,
        input: {
          messages: newestUserMessage ? [{ role: "user", content: newestUserMessage.content }] : [],
        },
        ...(resumeResolution.mode === "resume" ? { resume: resumeResolution.resume } : {}),
        ...(middlewareResult.context ? { middlewareContext: middlewareResult.context } : {}),
        routeFile: route.routeFile,
        routeId: route.routeId,
        routePath: route.routePath,
        ...(sandboxManager ? { sandboxManager } : {}),
        signal,
        threadId,
      })
      const abortableRouteStream = abortableAsyncIterable(routeStream, signal)
      for await (const event of toAguiEvents(normalizeDawnStream(abortableRouteStream), {
        threadId,
        runId: input.runId,
      })) {
        response.write(encodeAgUiSse(event, request.headers.accept))
      }
    } finally {
      await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)
    }
    response.end()
  } finally {
    request.removeListener("aborted", onRequestAborted)
    response.removeListener("close", onResponseClose)
  }
}
