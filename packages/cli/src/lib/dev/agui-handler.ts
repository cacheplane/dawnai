import type { IncomingMessage, ServerResponse } from "node:http"
import { RunAgentInputSchema } from "@ag-ui/core"
import { type DawnAgentStreamChunk, fromRunAgentInput, toAguiEvents } from "@dawn-ai/ag-ui"
import { encodeAgUiSse } from "@dawn-ai/ag-ui/sse"
import type { MemoryStoreLike } from "@dawn-ai/core"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { DawnMiddleware, MiddlewareRequest, ThreadAccessPolicy } from "@dawn-ai/sdk"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { type BootResolvedInstances, streamResolvedRoute } from "../runtime/execute-route-core.js"
import type { SandboxManager } from "../runtime/sandbox-manager.js"
import type { DawnStaticModules } from "../runtime/static-modules-core.js"
import type { StreamChunk } from "../runtime/stream-types.js"
import { abortableAsyncIterable } from "./abortable-iterable.js"
import type { LiveTurnHub, LiveTurnProducer } from "./live-turn-hub.js"
import { headersToRecord, runMiddleware } from "./middleware.js"
import { toWebRequest, writeNodeResponse } from "./node-web-adapter.js"
import { readParkedRoute, settleParkedRoute } from "./parked-route.js"
import {
  type PendingResumeClaims,
  readPendingInterrupts,
  resolvePendingResume,
} from "./pending-interrupts.js"
import { extractRouteParams } from "./request-context.js"
import type { RunRegistry } from "./run-registry.js"
import type { RuntimeRegistry } from "./runtime-registry-core.js"
import { createRequestErrorBody } from "./server-errors.js"
import { statusResponse } from "./status-response.js"
import { terminalStatus } from "./terminal-status.js"
import type { Gate, GateSpec } from "./thread-gate.js"
import { createGatedThreadForRun, isThenable, makeThreadGate } from "./thread-gate.js"
import { assertNoReservedKey } from "./thread-metadata.js"

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
  readonly liveTurnHub: LiveTurnHub
  readonly middleware: DawnMiddleware | undefined
  /**
   * Boot-resolved permissions store (or a per-request factory in dev),
   * forwarded into route execution so no per-request store construction is
   * needed. Optional so direct callers (tests) keep their existing behavior.
   */
  readonly permissionsStore?: PermissionsStore | (() => Promise<PermissionsStore>)
  readonly registry: RuntimeRegistry
  readonly resumeClaims: PendingResumeClaims
  readonly runRegistry: RunRegistry
  /**
   * The boot-resolved policy. `undefined` means the app has no policy — the
   * gate below is then a no-op, exactly like every other gated endpoint.
   */
  readonly threadAccess: ThreadAccessPolicy | undefined
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

/**
 * Pass-through tap that records whether the turn parked.
 *
 * Separate from `normalizeDawnStream`, and upstream of it, because that one has
 * already translated chunks into AG-UI's vocabulary by the time anything
 * downstream sees them, while a park has to be recognised by Dawn's own
 * `interrupt` chunk — the same signal `handleApStreamRequest` watches for
 * inline. Being upstream also means the flag is set before the enqueue, so a
 * park observed after the client has gone — the controller closed, every write
 * a no-op — still counts.
 */
async function* observeInterrupts(
  chunks: AsyncIterable<StreamChunk>,
  onInterrupt: () => void,
): AsyncGenerator<StreamChunk> {
  for await (const chunk of chunks) {
    if (chunk.type === "interrupt") onInterrupt()
    yield chunk
  }
}

/**
 * Pass-through tap that publishes each raw `StreamChunk` to the live turn
 * BEFORE AG-UI translation, so an attacher on the AP wire sees AP-vocabulary
 * frames rather than encoded AG-UI events. Upstream of `normalizeDawnStream`
 * for the same reason `observeInterrupts` is: once translated, the chunk no
 * longer carries the vocabulary the hub stores. The terminal `done` chunk is
 * captured rather than published — see the `liveTurn?.close` call site for
 * why it is delivered exactly once, never through the digest.
 */
async function* tapLiveTurn(
  chunks: AsyncIterable<StreamChunk>,
  liveTurn: LiveTurnProducer | undefined,
  onTerminal: (chunk: StreamChunk) => void,
): AsyncGenerator<StreamChunk> {
  for await (const chunk of chunks) {
    if (chunk.type === "done") onTerminal(chunk)
    else liveTurn?.publish(chunk)
    yield chunk
  }
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
    liveTurnHub,
    middleware,
    permissionsStore,
    registry,
    resumeClaims,
    runRegistry,
    threadAccess,
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

  let releaseResumeClaim: (() => void) | undefined
  let releaseRunBeforeStream: (() => void) | undefined
  let claimTransferredToStream = false
  let runTransferredToStream = false
  let streamOwnsSignalCleanup = false
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
    // The one place this turn decides it is a resume. Computed HERE, above
    // every gate site, because this endpoint gates up to twice per request and
    // a turn that reported `resuming: true` at one gate and `false` at another
    // would be describing two different requests. `fromRunAgentInput` leaves
    // `resume` undefined for an absent OR empty array, so this is exactly the
    // condition the resume claim below takes itself on.
    const resuming = dawnInput.resume !== undefined
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

    // `update` on a row that exists, `create` on one this turn is about to
    // make — see ThreadOperation. AFTER the middleware reject above and BEFORE
    // every side effect below (`resumeClaims.tryClaim`, `runRegistry.begin`,
    // `threadsStore.createThread`): a denial must take no claim, no run slot,
    // and create no row. This route has no `threads` segment — the
    // client-supplied `input.threadId` is the only thread identity a caller
    // controls here, and it names any thread id it likes.
    //
    // The create itself lands below, once `resolvePendingResume` has run — but
    // BEFORE `runRegistry.begin`, so a caller the row recheck ultimately denies
    // never holds the victim thread's run slot for the width of that recheck.
    // These two carry the `create` decision down to it. Both stay `undefined` on
    // a row that already exists and on a hook-less app, which is what the create
    // site branches on.
    let createGate: ((spec: GateSpec) => Gate | Promise<Gate>) | undefined
    let createStamp: Record<string, unknown> | undefined
    if (threadAccess) {
      const existing = await threadsStore.getThread(input.threadId)
      const gate = makeThreadGate(threadAccess, request)
      const g = gate({
        action: existing ? "update" : "create",
        operation: "run.agui",
        resuming,
        threadId: input.threadId,
        ...(existing ? { thread: existing } : {}),
      })
      const settled = isThenable(g) ? await g : g
      if (!settled.ok) return settled.response
      if (!existing) {
        createGate = gate
        createStamp = settled.stamp
      }
    }

    if (resuming) {
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

    // Authorize — and, when this turn must, create — the concrete row BEFORE
    // claiming the run slot, mirroring the Agent Protocol run handlers. Doing it
    // after `runRegistry.begin` (where it used to sit) let a caller the recheck
    // ultimately denies hold the victim thread's slot for the width of that
    // recheck: a client-chosen id means the row that turned up may be anybody's,
    // and a denied caller would brick a concurrent authorized run on the same
    // thread with a transient `run_in_flight` 409. Read once here; only the
    // CLEAR consults `previousParkedRoute`, with the same staleness caveat the
    // Agent Protocol handlers carry.
    const existingThread = await threadsStore.getThread(threadId)
    const previousParkedRoute = readParkedRoute(existingThread)
    if (createGate && existingThread) {
      // A row appeared between the gate and here. The window still exists — a
      // resume claim and a checkpointer read sit inside it — and the id is
      // client-chosen, so the row that turned up may be anybody's. The `create`
      // decision authorized a thread that did not exist; this one does, so it is
      // authorized as what it now is. Skipping this on the strength of the
      // earlier decision would run the turn on a thread nothing admitted this
      // caller to.
      const recheck = createGate({
        action: "update",
        operation: "run.agui",
        resuming,
        thread: existingThread,
        threadId,
      })
      const settled = isThenable(recheck) ? await recheck : recheck
      if (!settled.ok) return settled.response
    } else if (createGate) {
      const created = await createGatedThreadForRun({
        gate: createGate,
        operation: "run.agui",
        resuming,
        stamp: createStamp,
        store: threadsStore,
        threadId,
      })
      if (!created.ok) return created.response
    } else if (!existingThread) {
      // Hook-less: unchanged.
      await threadsStore.createThread({ thread_id: threadId })
    }

    const run = runRegistry.begin(threadId, signal)
    if (!run) {
      return Response.json(
        createRequestErrorBody(`A run is already in flight for thread "${threadId}"`, {
          code: "run_in_flight",
        }),
        { status: 409 },
      )
    }
    releaseRunBeforeStream = run.release

    // Live-turn anchor: one latest-tuple read, taken before the route stream
    // begins executing so it races nothing the run itself writes. A failed
    // read degrades attach to the durable path for this turn — it must never
    // fail the run or leak the run slot, so the failure is only logged.
    let liveTurn: LiveTurnProducer | undefined
    try {
      const anchorTuple = await checkpointer.getTuple({
        configurable: { checkpoint_ns: "", thread_id: threadId },
      })
      liveTurn = liveTurnHub.open({
        anchorCheckpointId: anchorTuple?.checkpoint?.id ?? null,
        input: resumeResolution.mode === "resume" ? resumeResolution.resume : dawnInput,
        resume: resumeResolution.mode === "resume",
        runStartedAt: new Date().toISOString(),
        threadId,
      })
    } catch (error) {
      console.warn(
        `Dawn: live-turn anchor read failed for ${threadId}; attach degrades to the durable path.`,
        error,
      )
    }

    // The last-run route, and therefore NOT the identity
    // GET /threads/:id/pending_interrupts gates on — any run the caller is
    // allowed to start overwrites it. See PARKED_ROUTE_KEY. This endpoint is the
    // one the CopilotKit UIs drive, so it is where most parks are born; a park
    // it failed to record would be a park that endpoint could not protect.
    const routePatch = { route: routeKey }
    // See the same guard in runtime-fetch-core.ts: the metadata merge is
    // shallow, so nothing the runtime writes may carry the access stamp's key.
    assertNoReservedKey(routePatch)
    try {
      await threadsStore.updateMetadata(threadId, routePatch)
      await threadsStore.updateStatus(threadId, "busy")
    } catch (error) {
      // The live-turn entry cannot leak open with the run slot about to be
      // released by the outer `finally` below: a viewer that raced this
      // failure gets a terminal frame instead of a hanging heartbeat.
      liveTurn?.close({ output: { error: String(error) }, type: "done" })
      throw error
    }

    const accept = request.headers.get("accept") ?? undefined
    const encoder = new TextEncoder()
    const releaseClaimWhenSettled = releaseResumeClaim
    let sourceCleanup: Promise<void> | undefined
    // A parked turn takes the NORMAL completion path — the adapter yields the
    // interrupt chunk and then `done` — so a drained loop does not mean the turn
    // finished. The handler's own flag, so parked-status honesty depends on
    // nothing outside this request.
    //
    // This is the change #443's note about the "idle" status write being
    // "deliberately left alone (tracked separately)" was pointing at; that note
    // is gone because this is the separate tracking, landed.
    let sawInterrupt = false
    // The terminal `done` chunk this turn ends with — captured (never
    // published to the live turn's digest) so the outer `finally` can close
    // the live turn with the SAME terminal, unconditionally. AG-UI's own
    // completion path never throws into this stream (see the inner `finally`
    // below), so a raw `StreamChunk` of type "done" is the only terminal this
    // handler ever produces.
    let terminalChunk: StreamChunk | undefined
    // From here on, the stream owns both the request listeners and any resume
    // claim. Its execution-finally path releases the claim only after the
    // interrupted route has actually unwound.
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
              signal: run.signal,
              ...(staticModules ? { staticModules } : {}),
              threadId,
              threadsStore,
            })
            const abortableRouteStream = abortableAsyncIterable(
              routeStream,
              run.signal,
              (cleanup) => {
                sourceCleanup = cleanup
              },
            )
            const observedRouteStream = observeInterrupts(abortableRouteStream, () => {
              sawInterrupt = true
            })
            const liveTappedStream = tapLiveTurn(observedRouteStream, liveTurn, (chunk) => {
              terminalChunk = chunk
            })
            for await (const event of toAguiEvents(normalizeDawnStream(liveTappedStream), {
              threadId,
              runId: input.runId,
            })) {
              safeEnqueue(controller, encoder.encode(encodeAgUiSse(event, accept)))
            }
          } finally {
            // Unconditional, same as handleApStreamRequest: attachers must see
            // the terminal frame exactly when the primary client does. The
            // identity guard inside `close` means a zombie route can never
            // write into a successor turn that has already replaced this
            // entry.
            liveTurn?.close(terminalChunk ?? { output: null, type: "done" })
            // This finally covers BOTH the drained and the failed turn, which is
            // exactly the pair the Agent Protocol handlers cover with a
            // success-path call plus a catch-path retry: a turn that parked
            // before failing is still parked. Errors are swallowed rather than
            // propagated because throwing from here would replace whatever
            // error brought us into the finally, masking the real failure.
            await settleParkedRoute({
              canPark: route.mode === "agent",
              checkpointer,
              parked: sawInterrupt,
              previousParkedRoute,
              routeKey,
              threadId,
              threadsStore,
            }).catch(() => undefined)
            // One write covers the drained turn, the failed one and the
            // disconnected one, because `toAguiEvents` never throws into its
            // consumer: an upstream error or abort arrives as a RUN_ERROR event
            // and the loop above ends normally. All three want the same answer —
            // a turn that parked and then failed, or parked and then lost its
            // client, is still parked.
            //
            // Deliberately not `run.cancelled`. AG-UI ends the run when the
            // client goes away, and a disconnect leaves nothing durable to come
            // back to, so it is not an interruption; what survives a disconnect
            // is the park, which this already reports.
            //
            // Bounded by what the stream can see: a client that disconnects
            // mid-superstep can abort the route after LangGraph has durably
            // written `__interrupt__` but before the adapter yields the chunk
            // for it, and that park still reads back as idle. Closing that needs
            // a checkpoint read here rather than a flag.
            await threadsStore
              .updateStatus(threadId, terminalStatus({ cancelled: false, sawInterrupt }))
              .catch(() => undefined)
            releaseSignalListeners()
          }
          safeClose(controller)
        } catch (error) {
          // Mirrors the pre-refactor behavior: a mid-stream failure propagated
          // out of the handler after headers were sent, tearing the stream down
          // rather than framing an error event.
          controller.error(error)
        } finally {
          const releaseExecutionClaims = () => {
            run.release()
            releaseClaimWhenSettled?.()
          }
          if (sourceCleanup) void sourceCleanup.finally(releaseExecutionClaims)
          else releaseExecutionClaims()
        }
      },
      cancel() {
        // AG-UI is ephemeral: a disconnected client ends the run. The start
        // finally releases any resume claim after execution settles.
        abortRequest("AG-UI response closed")
        releaseSignalListeners()
      },
    })

    claimTransferredToStream = true
    runTransferredToStream = true
    streamOwnsSignalCleanup = true
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
    if (!runTransferredToStream) releaseRunBeforeStream?.()
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
