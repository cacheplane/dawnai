import type { IncomingMessage, ServerResponse } from "node:http"
import { RunAgentInputSchema } from "@ag-ui/core"
import { type DawnAgentStreamChunk, fromRunAgentInput, toAguiEvents } from "@dawn-ai/ag-ui"
import { encodeAgUiSse } from "@dawn-ai/ag-ui/sse"
import type { MemoryStoreLike } from "@dawn-ai/core"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { DawnMiddleware, MiddlewareRequest } from "@dawn-ai/sdk"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { streamResolvedRoute } from "../runtime/execute-route.js"
import type { SandboxManager } from "../runtime/sandbox-manager.js"
import type { StreamChunk } from "../runtime/stream-types.js"
import { abortableAsyncIterable } from "./abortable-iterable.js"
import { headersToRecord, runMiddleware } from "./middleware.js"
import { toWebRequest, writeNodeResponse } from "./node-web-adapter.js"
import { readPendingInterrupts, resolveAgUiResume } from "./pending-interrupts.js"
import { extractRouteParams } from "./request-context.js"
import type { RuntimeRegistry } from "./runtime-registry.js"
import { createRequestErrorBody } from "./server-errors.js"
import { statusResponse } from "./status-response.js"

export interface AgUiFetchRequestOptions {
  readonly appRoot: string
  readonly checkpointer: BaseCheckpointSaver
  /**
   * Lazy, memoized, boot-built thunk for the shared memory store — forwarded
   * into route execution so the memory capability reuses the same store the
   * `/memory/candidates*` HTTP routes use, instead of opening its own.
   * Optional so direct callers (tests) keep their existing behavior.
   */
  readonly getMemoryStore?: () => Promise<MemoryStoreLike>
  readonly middleware: DawnMiddleware | undefined
  /**
   * Boot-resolved permissions store (or a per-request factory in dev),
   * forwarded into route execution so no per-request store construction is
   * needed. Optional so direct callers (tests) keep their existing behavior.
   */
  readonly permissionsStore?: PermissionsStore | (() => Promise<PermissionsStore>)
  readonly registry: RuntimeRegistry
  readonly threadsStore: ThreadsStore
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly request: Request
  readonly routeKey: string
  readonly streamRoute?: typeof streamResolvedRoute
}

interface AgUiRequestOptions extends Omit<AgUiFetchRequestOptions, "request"> {
  readonly request: IncomingMessage
  readonly response: ServerResponse
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

export async function handleAgUiFetchRequest(options: AgUiFetchRequestOptions): Promise<Response> {
  const {
    appRoot,
    checkpointer,
    getMemoryStore,
    middleware,
    permissionsStore,
    registry,
    threadsStore,
    sandboxManager,
    signal: shutdownSignal,
    request,
    routeKey,
    streamRoute = streamResolvedRoute,
  } = options

  const requestController = new AbortController()
  const abortRequest = (message: string) => {
    if (!requestController.signal.aborted) requestController.abort(new Error(message))
  }
  const onRequestAborted = () => abortRequest("AG-UI request aborted")
  if (request.signal.aborted) onRequestAborted()
  else request.signal.addEventListener("abort", onRequestAborted, { once: true })

  // Deliberately a manual listener rather than AbortSignal.any: a composed
  // signal is retained for the lifetime of its SOURCE, and the shutdown signal
  // lives as long as the process. With one composition per request that leaks
  // without bound (measured: 92 MB retained per 200k requests on Node 24 — see
  // run-registry.ts for the identical fix applied to the runs registry).
  // releaseSignalListeners() below removes both listeners once the request is
  // done. Every exit path releases it: the try/finally around the pre-stream
  // work covers the early returns, and once the stream is constructed,
  // ownership passes to its own finally/cancel.
  const onShutdown = () => abortRequest("Server shutting down")
  if (shutdownSignal.aborted) onShutdown()
  else shutdownSignal.addEventListener("abort", onShutdown, { once: true })
  const signal = requestController.signal
  const releaseSignalListeners = () => {
    shutdownSignal.removeEventListener("abort", onShutdown)
    request.signal.removeEventListener("abort", onRequestAborted)
  }

  let streamOwnsSignalCleanup = false
  try {
    const raw = await request.text()
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      return Response.json(createRequestErrorBody("Malformed body"), { status: 400 })
    }

    const parsed = RunAgentInputSchema.safeParse(parsedJson)
    if (!parsed.success) {
      return Response.json(createRequestErrorBody("Invalid RunAgentInput"), { status: 400 })
    }
    const input = parsed.data

    const route = registry.lookup(routeKey)
    if (!route) {
      return Response.json(createRequestErrorBody(`Unknown route: ${routeKey}`), { status: 404 })
    }

    const requestUrl = new URL(request.url)
    const dawnInput = fromRunAgentInput(input)
    const middlewareRequest: MiddlewareRequest = {
      assistantId: route.assistantId,
      headers: headersToRecord(request.headers),
      method: request.method,
      params: extractRouteParams(route.routeId, dawnInput.raw),
      routeId: route.routeId,
      url: `${requestUrl.pathname}${requestUrl.search}`,
    }
    const middlewareResult = await runMiddleware(middleware, middlewareRequest)
    if (middlewareResult.action === "reject") {
      return statusResponse(middlewareResult.status, middlewareResult.body)
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
      return Response.json(
        createRequestErrorBody(resumeResolution.message, { code: resumeResolution.code }),
        { status: resumeResolution.status },
      )
    }

    const threadId = input.threadId
    if (!(await threadsStore.getThread(threadId))) {
      await threadsStore.createThread({ thread_id: threadId })
    }
    await threadsStore.updateMetadata(threadId, { route: routeKey })
    await threadsStore.updateStatus(threadId, "busy")

    const accept = request.headers.get("accept") ?? undefined
    const encoder = new TextEncoder()
    // From here on, the request is committed to the stream: releasing the
    // signal listeners is this ReadableStream's job (finally/cancel below),
    // not the outer try/finally's.
    streamOwnsSignalCleanup = true
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          try {
            const routeStream = streamRoute({
              appRoot,
              checkpointer,
              input: {
                messages: newestUserMessage
                  ? [{ role: "user", content: newestUserMessage.content }]
                  : [],
              },
              ...(resumeResolution.mode === "resume" ? { resume: resumeResolution.resume } : {}),
              ...(middlewareResult.context ? { middlewareContext: middlewareResult.context } : {}),
              ...(getMemoryStore ? { memoryStore: getMemoryStore } : {}),
              ...(permissionsStore ? { permissionsStore } : {}),
              routeFile: route.routeFile,
              routeId: route.routeId,
              ...(registry.manifest ? { routeManifest: registry.manifest } : {}),
              routePath: route.routePath,
              ...(sandboxManager ? { sandboxManager } : {}),
              signal,
              threadId,
              threadsStore,
            })
            const abortableRouteStream = abortableAsyncIterable(routeStream, signal)
            for await (const event of toAguiEvents(normalizeDawnStream(abortableRouteStream), {
              threadId,
              runId: input.runId,
            })) {
              safeEnqueue(controller, encoder.encode(encodeAgUiSse(event, accept)))
            }
          } finally {
            await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)
            releaseSignalListeners()
          }
          safeClose(controller)
        } catch (error) {
          // Mirrors the pre-refactor behavior: a mid-stream failure propagated
          // out of the handler after headers were sent, tearing the stream down
          // rather than framing an error event.
          controller.error(error)
        }
      },
      cancel() {
        // Client disconnected — stop the run. AG-UI is the ephemeral surface:
        // there is no reattach and no run to resume, so a dropped socket really
        // does end the work. The Agent Protocol endpoints deliberately take the
        // opposite default and keep running; see the disconnect note in
        // runtime-fetch-handler.ts.
        abortRequest("AG-UI response closed")
        // Belt-and-suspenders: the abort above drives the running iterable to
        // exit and hit the `finally` above (which also releases), but release
        // here too in case cancel() ever fires without a run in flight to
        // unwind. Safe to call twice — removeEventListener is idempotent.
        releaseSignalListeners()
      },
    })

    return new Response(stream, {
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      },
      status: 200,
    })
  } finally {
    if (!streamOwnsSignalCleanup) releaseSignalListeners()
  }
}

/**
 * Node-transport adapter over {@link handleAgUiFetchRequest}. Kept with its
 * original `(IncomingMessage, ServerResponse)` signature for direct callers.
 */
export async function handleAgUiRequest(options: AgUiRequestOptions): Promise<void> {
  const { request, response, ...rest } = options
  const webResponse = await handleAgUiFetchRequest({
    ...rest,
    request: toWebRequest(request, response),
  })
  await writeNodeResponse(response, webResponse)
}

function safeEnqueue(controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) {
  try {
    controller.enqueue(chunk)
  } catch {
    // The consumer already canceled the stream — writes become no-ops, exactly
    // like `response.write` on a disconnected socket did.
  }
}

function safeClose(controller: ReadableStreamDefaultController<Uint8Array>) {
  try {
    controller.close()
  } catch {
    // Already canceled/errored.
  }
}
