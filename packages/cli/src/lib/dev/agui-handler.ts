import type { IncomingMessage, ServerResponse } from "node:http"
import { RunAgentInputSchema } from "@ag-ui/core"
import { type DawnAgentStreamChunk, fromRunAgentInput, toAguiEvents } from "@dawn-ai/ag-ui"
import { encodeAgUiSse } from "@dawn-ai/ag-ui/sse"
import type { MemoryStoreLike } from "@dawn-ai/core"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { DawnMiddleware, MiddlewareRequest } from "@dawn-ai/sdk"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { type BootResolvedInstances, streamResolvedRoute } from "../runtime/execute-route-core.js"
import type { SandboxManager } from "../runtime/sandbox-manager.js"
import type { DawnStaticModules } from "../runtime/static-modules-core.js"
import type { StreamChunk } from "../runtime/stream-types.js"
import { abortableAsyncIterable } from "./abortable-iterable.js"
import { headersToRecord, runMiddleware } from "./middleware.js"
import { toWebRequest, writeNodeResponse } from "./node-web-adapter.js"
import {
  type PendingResumeClaims,
  readPendingInterrupts,
  resolvePendingResume,
} from "./pending-interrupts.js"
import { extractRouteParams } from "./request-context.js"
import type { RuntimeRegistry } from "./runtime-registry.js"
import { createRequestErrorBody } from "./server-errors.js"
import { statusResponse } from "./status-response.js"

export interface AgUiFetchRequestOptions {
  readonly appRoot: string
  /** Boot state (supplied config + node fallbacks) forwarded to route execution. */
  readonly boot?: Pick<BootResolvedInstances, "bootFallbacks" | "config">
  readonly checkpointer: BaseCheckpointSaver
  /**
   * Lazy, memoized, boot-built thunk for the shared memory store, forwarded
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
  readonly resumeClaims: PendingResumeClaims
  readonly threadsStore: ThreadsStore
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  /**
   * Boot-time static module manifest, when the server booted from one,
   * forwarded into route execution so subagents descriptor maps are derived
   * without entry-file imports. Optional so direct callers (tests) keep
   * their existing behavior.
   */
  readonly staticModules?: DawnStaticModules
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
    boot,
    checkpointer,
    getMemoryStore,
    middleware,
    permissionsStore,
    registry,
    resumeClaims,
    threadsStore,
    sandboxManager,
    signal: shutdownSignal,
    staticModules,
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
  const signal = AbortSignal.any([shutdownSignal, requestController.signal])

  let releaseResumeClaim: (() => void) | undefined
  let claimTransferredToStream = false
  try {
    const raw = await request.text()
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      return Response.json(createRequestErrorBody("Malformed body"), {
        status: 400,
      })
    }

    const parsed = RunAgentInputSchema.safeParse(parsedJson)
    if (!parsed.success) {
      return Response.json(createRequestErrorBody("Invalid RunAgentInput"), {
        status: 400,
      })
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

    if (dawnInput.resume !== undefined) {
      releaseResumeClaim = resumeClaims.tryClaim(input.threadId)
      if (!releaseResumeClaim) {
        return Response.json(
          createRequestErrorBody("A resume is already in progress for this thread", {
            code: "resume_in_progress",
          }),
          { status: 409 },
        )
      }
    }

    const newestUserMessage = [...dawnInput.messages]
      .reverse()
      .find((message) => message.role === "user")
    const pending = (await readPendingInterrupts(checkpointer, input.threadId)) ?? {
      interrupts: [],
      malformed: false,
    }
    const resumeResolution = resolvePendingResume(dawnInput.resume, pending)
    if (!resumeResolution.ok) {
      return Response.json(
        createRequestErrorBody(resumeResolution.message, {
          code: resumeResolution.code,
        }),
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
    const releaseClaimWhenSettled = releaseResumeClaim
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          try {
            const routeStream = streamRoute({
              appRoot,
              ...boot,
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
              ...(staticModules ? { staticModules } : {}),
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
          }
          safeClose(controller)
        } catch (error) {
          // Mirrors the pre-refactor behavior: a mid-stream failure propagated
          // out of the handler after headers were sent, tearing the stream down
          // rather than framing an error event.
          controller.error(error)
        } finally {
          releaseClaimWhenSettled?.()
        }
      },
      cancel() {
        // Client disconnected - stop the run exactly as the old response-close
        // handler did. The stream start finally releases any resume claim.
        abortRequest("AG-UI response closed")
      },
    })

    claimTransferredToStream = true
    return new Response(stream, {
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      },
      status: 200,
    })
  } finally {
    // Failures before stream ownership transfers must not leave the thread
    // claimed. Successful streams release from their execution-finally path.
    if (!claimTransferredToStream) releaseResumeClaim?.()
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
    // The consumer already canceled the stream - writes become no-ops, exactly
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
