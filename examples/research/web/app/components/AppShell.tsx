"use client"
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2"
import { DAWN_PLAN_ACTIVITY_TYPE } from "@dawn-ai/ag-ui"
import { planActivityContentSchema } from "@dawn-ai/ag-ui/react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { HydratedThread } from "../lib/hydrate"
import type { ThreadSource, WorkbenchThread } from "../lib/thread-source"
import type { TranscriptMessage } from "../lib/transcript"
import { Composer } from "./Composer"
import { ConnectScreen } from "./ConnectScreen"
import { MemoryPanel } from "./MemoryPanel"
import { ThreadRail, UNTITLED_THREAD_LABEL } from "./ThreadRail"
import { Transcript } from "./Transcript"

/**
 * THE ERROR-SURFACE NOTE. Four surfaces can report a failure in this app, and
 * they are stated once here so the sites that implement them can cite this
 * instead of each re-arguing why they are not the others.
 *
 * 1. `ConnectScreen` — the server is KNOWN to be down. Two ways to learn that:
 *    a probe through the proxy came back 502 (`probeDawnServer`), or a real
 *    hydrate hit the same dead proxy first (`isProxyUnreachableError` in
 *    `reportHydrateFailure`). It replaces the entire shell, because nothing in
 *    the shell works without a server.
 * 2. The `RunError` row inside `Transcript` — something failed while the shell
 *    is UP and there is a conversation on screen to attach it to: a run
 *    (`RUN_ERROR_TITLES`, via the `copilotkit.subscribe` seam below), a resume,
 *    or a restore that failed for a reason other than an unreachable server.
 *    This is also where a restore that read NOTHING out of a non-empty
 *    checkpoint lands (see `applyRestored`).
 * 3. The memory panel's quiet muted line — `MemoryPanel`'s own candidate read
 *    failing for a reason that is NOT a 502. A 502 there is surface 1's fact,
 *    so the panel stays silent for it rather than competing.
 * 4. Silence, deliberately — a hydrate 404 (a thread that has never run has no
 *    checkpoint, which is not an error) and `HydratedInterrupts`' own fetch
 *    failures (nothing the reader could do, and the transcript's restore
 *    already reports a genuinely unreachable server).
 *
 * The rule that generates all four: report a fact once, on the surface that
 * owns it, at the size of the thing that broke.
 */

/**
 * The default `api/copilotkit/route.ts` and `api/dawn/[...path]/route.ts` fall
 * back to when `DAWN_SERVER_URL` is unset. Those two are the SHAREABLE copies
 * — one source, read from the env at request time on the server. This one is
 * not: it ships inside the client bundle, can only ever be a literal, and
 * only coincides with the real value because both default the same env var
 * the same way. A client component cannot read `DAWN_SERVER_URL` itself (it
 * is server-side only), and this app has deliberately not grown a
 * `NEXT_PUBLIC_` twin for it (a second value that can drift from the real one
 * is worse than an honest default). `ConnectScreen` shows this value labeled
 * as a default, not asserted as the confirmed target.
 */
const DEFAULT_SERVER_URL = "http://127.0.0.1:3002"

/** How often the connect screen re-probes Dawn while it is showing. */
const SERVER_PROBE_INTERVAL_MS = 5000

/** The allowlisted read this app probes Dawn's own liveness through (see `probeDawnServer`). */
const SERVER_PROBE_PATH = "/api/dawn/memory/candidates"

/**
 * True if the Dawn server itself answered — not just this Next process.
 *
 * `useCopilotKit().runtimeConnectionStatus` looks like the right predicate
 * and is not, which is what shipped here first and was caught live: the
 * CopilotKit runtime route (`api/copilotkit/route.ts`) runs in the SAME Next
 * process as this page, its `/info` handler enumerates the registered
 * `HttpAgent`s without ever contacting Dawn (`HttpAgent` implements no
 * `getCapabilities`), and any failure to reach Dawn along that path is
 * swallowed rather than surfaced. Verified live: with Dawn completely down,
 * `runtimeConnectionStatus` stayed `"connected"`, the empty workbench
 * rendered, and no connect screen ever showed.
 *
 * The only route that actually talks to Dawn is the same-origin proxy
 * (`api/dawn/[...path]/route.ts`), so this probes through IT instead: `GET
 * /api/dawn/memory/candidates` is on the proxy's allowlist
 * (`lib/proxy-allowlist.ts`) and is a cheap read. The proxy's one dedicated
 * "I could not reach Dawn" signal is a 502 with an ECONNREFUSED-shaped body
 * (`route.ts`'s catch branch); any other status — even a Dawn-side error —
 * means the process answered, which is all this needs to know.
 */
async function probeDawnServer(): Promise<boolean> {
  try {
    const response = await fetch(SERVER_PROBE_PATH)
    return response.status !== 502
  } catch {
    // The proxy route itself not responding at all is the same "show the
    // connect screen" situation from the user's point of view.
    return false
  }
}

/**
 * True when `error` is the shape `thread-source.ts`'s `hydrate` throws for
 * the proxy's own "cannot reach Dawn" response — a 502 whose message embeds
 * `(HTTP 502)` (see `route.ts`'s catch branch and `hydrate`'s own message
 * template). Matched on that substring rather than a typed/coded error
 * because the proxy has no structured error channel today. Deliberately
 * narrow in the safe direction: a genuine `HTTP 502` from Dawn itself for an
 * unrelated reason would also match, which is an acceptable false positive
 * (the connect screen shows for a real but rare Dawn-side 502) against the
 * alternative of missing the common case this exists for.
 */
function isProxyUnreachableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("(HTTP 502)")
}

/**
 * Which CopilotKit core errors are the user's problem, and what to call them.
 *
 * `onError` fires for the whole `CopilotKitCoreErrorCode` enum, not just runs:
 * transcription failures, tool-registration mistakes, and
 * `subscriber_callback_failed` — a bug thrown by one of *our* activity
 * renderers — all arrive on the same channel. Showing every one of them as
 * "The run failed" is a lie in both directions, so this is an allowlist, and
 * anything absent stays a console line.
 *
 * Keyed by the enum's string values rather than the enum itself: importing
 * `@copilotkit/core` for a comparison would add a direct dependency on a
 * package this app only has transitively, and TypeScript refuses to compare an
 * enum-typed value against a string literal anyway.
 */
const RUN_ERROR_TITLES: Readonly<Record<string, string>> = {
  agent_run_failed: "The run failed",
  agent_run_failed_event: "The run failed",
  agent_run_error_event: "The run failed",
  agent_connect_failed: "Lost the connection to the agent",
  agent_thread_locked: "This conversation is already running",
  agent_not_found: "The research agent is not registered",
  // NOT "Cannot reach the Dawn server" — this code means `/api/copilotkit`'s
  // own `/info` sync broke inside the Next process, which is a different
  // failure from Dawn being down (see `probeDawnServer`'s comment for why
  // that route cannot tell the two apart at all).
  runtime_info_fetch_failed: "The chat runtime failed to initialize",
}

/**
 * The restored thread, with its checkpointed plan put back in front of it.
 *
 * `hydrate.ts` already filters `values.todos`, so the schema here is not
 * re-checking the mapper: it is the last gate in front of the renderer on a
 * SWAPPABLE seam. `ThreadSource` has a second implementation coming
 * (LangGraph Platform), and every implementation after this one is only ever
 * type-checked — a `HydratedThread` that satisfies the types and lies about
 * its todos would otherwise reach `PlanCard` unexamined. Validated with the
 * same `planActivityContentSchema` `activity-renderers.tsx` registers, so a
 * malformed plan renders no card at all rather than arbitrary JSON in a
 * plan-shaped box. The id is minted here because the checkpoint has none; the
 * stream path uses `dawn:plan:${runId}`, and `hydrated:plan:${threadId}` is
 * the same idea for a read that has no run: stable across re-renders and
 * re-hydrations, unique per thread.
 */
function withRestoredPlan(thread: HydratedThread, threadId: string): readonly TranscriptMessage[] {
  if (thread.todos.length === 0) return thread.messages
  const parsed = planActivityContentSchema.safeParse({ todos: thread.todos })
  if (!parsed.success) return thread.messages
  return [
    {
      activityType: DAWN_PLAN_ACTIVITY_TYPE,
      content: { todos: parsed.data.todos },
      id: `hydrated:plan:${threadId}`,
      role: "activity",
    },
    ...thread.messages,
  ]
}

interface RunErrorState {
  readonly title: string
  readonly message: string
}

export interface AppShellProps {
  readonly threads: readonly WorkbenchThread[]
  readonly activeThreadId: string | undefined
  readonly onSelectThread: (threadId: string) => void
  readonly onCreateThread: () => void
  /** Reported so the rail can title the thread from its first user message. */
  readonly onUserMessage: (message: string) => void
  /**
   * Where a thread's stored history comes from. Null only during SSR, where
   * `page.tsx` cannot build the localStorage-backed source — there is nothing
   * to hydrate on the server anyway, since the active thread id is undefined
   * until the browser's first effect.
   */
  readonly threadSource: ThreadSource | null
}

/**
 * The two-column shell, and the only place that talks to the agent.
 *
 * `useAgent()` is deliberately called with NO arguments. Its props have exactly
 * two legal shapes: unscoped (`useAgent()` / `useAgent({ agentId })`), which
 * takes its thread from the surrounding chat configuration, or thread-scoped
 * (`{ agentId, runtimeAgentId, threadId }` — all three, or it throws at
 * runtime), which registers a *private proxied* agent. The unscoped form is
 * what this app wants: `useInterrupt`, `useSuggestions` and the tool-call
 * renderers all resolve their agent the same way, so one
 * `CopilotChatConfigurationProvider` (mounted in `page.tsx`) keeps every hook
 * bound to the same agent and the same thread. A private per-thread agentId
 * would move the transcript off the agent the other three still watch.
 *
 * The hook does not return messages — it subscribes and re-renders, and the
 * state is read off `agent` (`agent.messages`, `agent.isRunning`).
 */
export function AppShell({
  threads,
  activeThreadId,
  onSelectThread,
  onCreateThread,
  onUserMessage,
  threadSource,
}: AppShellProps) {
  const { agent } = useAgent()
  const { copilotkit } = useCopilotKit()

  // "checking" first paint, never "down" — see `probeDawnServer` and the
  // effects below for why nothing but an actual probe through the proxy may
  // set this to "down", and why "checking" (not "up") is the honest starting
  // value: nothing has answered yet, and defaulting to "up" would flash the
  // normal shell for a beat on every load even when Dawn is genuinely down.
  const [serverStatus, setServerStatus] = useState<"checking" | "up" | "down">("checking")
  // Guards `setServerStatus` calls whose probe resolves after this component
  // is gone — the interval below already stops new probes on unmount, but a
  // probe already in flight at that moment still has to be told not to write
  // into unmounted state.
  //
  // RE-ARMED on setup, not just cleared on cleanup, and that is a bug fix
  // rather than symmetry-for-its-own-sake. Next 16's App Router runs
  // StrictMode by default (this app sets no `reactStrictMode` key), and
  // StrictMode's dev double-invoke is setup -> cleanup -> setup. A flag whose
  // only write is `= false` in the cleanup latches false forever on the second
  // setup, which pins `serverStatus` at "checking": with Dawn completely down,
  // the connect screen NEVER appears in dev and the shell sits there looking
  // fine. Verified in jsdom against a non-Strict control.
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const runProbe = useCallback(() => {
    void probeDawnServer().then((up) => {
      if (isMountedRef.current) setServerStatus(up ? "up" : "down")
    })
  }, [])

  // The one probe every load gets regardless of status: without it, a
  // freshly mounted shell would sit in "checking" forever.
  useEffect(() => {
    runProbe()
  }, [runProbe])

  // Recovery, not just detection: `runtimeConnectionStatus` (the previous,
  // wrong predicate) could never un-latch from "error" without a remount —
  // this probe can, because it is ours to re-run. Polls only while "down":
  // no interval running while "checking" (the initial probe owns that) or
  // "up". That last one is a scope choice, not an absence of things to
  // watch: a server that dies mid-session is NOT noticed by this poll, and
  // the surface for it is a failed run rather than the connect screen (see
  // the error-surface note at the top of this file). Polling a healthy
  // server forever to pre-empt a failure the next send reports anyway is
  // not worth the request.
  useEffect(() => {
    if (serverStatus !== "down") return
    const id = setInterval(runProbe, SERVER_PROBE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [serverStatus, runProbe])

  // The half that makes recovery actually restore the conversation, not just
  // the chrome. A hydrate issued while "down" fails via
  // `isProxyUnreachableError` below and is never retried on its own — nothing
  // else asks again. `hydrateNonce` is what re-asks: bumping it re-runs the
  // thread-switch effect below for the SAME thread id, which already knows
  // how to issue a hydrate and apply the result, just without the "thread
  // actually changed" clear step (see `threadChanged` inside that effect).
  const previousServerStatusRef = useRef(serverStatus)
  const [hydrateNonce, setHydrateNonce] = useState(0)
  useEffect(() => {
    if (previousServerStatusRef.current === "down" && serverStatus === "up") {
      setHydrateNonce((n) => n + 1)
    }
    previousServerStatusRef.current = serverStatus
  }, [serverStatus])

  const [runError, setRunError] = useState<RunErrorState | null>(null)
  // True only once a hydrate has actually put something back on screen, which
  // is the condition for the "what did not come back" note in `Transcript`.
  const [hasRestoredHistory, setHasRestoredHistory] = useState(false)
  // Gates this browser never saw park, restored from the server by
  // `HydratedInterrupts`. Kept here rather than derived because there is
  // nothing on the agent to derive it from — see `isAwaitingApproval`. The
  // setter is passed down as-is: a `useState` setter is referentially stable,
  // so it will not re-fire the reporting effect on the way down.
  const [hydratedPendingCount, setHydratedPendingCount] = useState(0)

  // The agent instance a hydrate that is already in flight should apply to.
  //
  // `useAgent` swaps the provisional stand-in for the real agent once the
  // runtime `/info` sync resolves, and the effect below deliberately does not
  // re-run for that (see `renderedThreadIdRef`) — so a hydrate started before
  // the swap closes over an agent nobody is rendering any more, and its
  // messages would land nowhere. Reading the latest instance out of a ref at
  // resolution time is what makes the restore survive the swap, without
  // re-issuing the request and racing the one in flight. Written from an
  // effect, not during render: a render can be thrown away.
  const agentRef = useRef(agent)
  useEffect(() => {
    agentRef.current = agent
  }, [agent])

  // `pendingInterrupts` is populated while the RUN_FINISHED event is applied,
  // which is strictly before `onRunFinalized` fires — and `onRunFinalized` is
  // one of the notifications `useAgent` re-renders on. So by the time this
  // component re-renders after a parked run, the count below is already right.
  //
  // `&& !agent.isRunning` because the flag would otherwise stay true for the
  // whole resumed run: `pendingInterrupts` is not cleared until that run's own
  // RUN_FINISHED lands, which for a research turn can be a minute later. The
  // user decided long ago; insisting they have not — and showing "running" and
  // "awaiting approval" side by side — is just wrong. The composer stays
  // blocked either way, via `isRunning`, but now for the true reason.
  //
  // Two sources, ORed, because `pendingInterrupts` only knows about gates this
  // browser watched park. After a reload it is empty while the server is still
  // holding one — and the composer would be live under a card that says
  // "Permission required", with a send from there starting a fresh run against
  // a parked checkpoint (`Thread has N pending interrupt(s) not addressed by
  // resume`, thrown once the user's message is already in the transcript).
  const isAwaitingApproval =
    !agent.isRunning && (agent.pendingInterrupts.length > 0 || hydratedPendingCount > 0)

  const reportRunError = useCallback((error: unknown) => {
    setRunError({
      title: "The run failed",
      message: error instanceof Error ? error.message : String(error),
    })
  }, [])

  const dismissRunError = useCallback(() => {
    setRunError(null)
  }, [])

  // THE seam for run failures — not the `catch` around `runAgent`.
  // `copilotkit.runAgent` does not reject when a run fails: it catches, calls
  // `emitError`, and returns `{ result: undefined, newMessages: [] }`. So an
  // unreachable server, a 500 from `/api/copilotkit`, or the pending-interrupt
  // throw all resolve normally and a `try/catch` alone would show the user
  // nothing (verified live: the row never appeared until this subscription
  // existed). Errors surface only here, as `CopilotKitCoreErrorCode` events.
  // `<CopilotSidebar>` was the previous subscriber; deleting it is what left
  // the shell with no failure state at all.
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: ({ error, code }) => {
        const title = RUN_ERROR_TITLES[String(code)]
        if (title === undefined) {
          console.error(`AppShell: unshown CopilotKit error (${String(code)})`, error)
          return
        }
        setRunError({ title, message: error.message })
      },
    })
    return () => {
      subscription.unsubscribe()
    }
  }, [copilotkit])

  // Switching threads clears the transcript, then refills it from the server.
  //
  // Worth stating precisely, because CopilotKit has a replay path that looks
  // like it would apply and does not. `copilotkit.connectAgent()` asks the
  // runtime to replay a thread's historic events, but the only two callers of
  // it live inside `<CopilotChat>`, which this app does not mount, and
  // `useAgent`'s own thread effect does exactly one thing in 1.68.3:
  // `agent.threadId = resolvedThreadId`. Verified live: switching away from a
  // three-message thread and back leaves it empty and fires no network request
  // at all. The server holds that history and this client has to ask for it
  // itself, which is what the `threadSource.hydrate` call below does.
  //
  // So the previous thread's messages must not sit there looking like they
  // belong to the new one. `pendingInterrupts` goes with them: leaving a
  // parked interrupt from the abandoned thread on the shared agent makes the
  // next run throw ("pending interrupt(s) not addressed by resume").
  //
  // The ref is not redundant with the dependency array, and deleting it breaks
  // the app: `agent` is a dependency too, and its identity CHANGES when
  // `useAgent` swaps the provisional stand-in for the real agent once the
  // runtime `/info` sync resolves. Without the ref, that swap re-runs this
  // effect and wipes a transcript nobody asked to leave.
  //
  // Seeding the ref with the FIRST `activeThreadId` also means the mount
  // render never hydrates. That is correct today only because `page.tsx`
  // starts the id `undefined` and sets the real one from a browser effect; if
  // it ever resolves an id synchronously (a deep link, say), the thread it
  // opens on would silently never restore.
  const renderedThreadIdRef = useRef(activeThreadId)
  // Mirrors `renderedThreadIdRef`, but for `hydrateNonce`: this effect fires
  // when EITHER changes, and only the thread-changed case gets the clear
  // step below (a nonce bump is a request to retry the same thread's
  // hydrate, not to leave it).
  const hydratedNonceRef = useRef(hydrateNonce)
  useEffect(() => {
    const threadChanged = renderedThreadIdRef.current !== activeThreadId
    const nonceChanged = hydratedNonceRef.current !== hydrateNonce
    if (!threadChanged && !nonceChanged) return
    renderedThreadIdRef.current = activeThreadId
    hydratedNonceRef.current = hydrateNonce
    if (threadChanged) {
      if (agent.isRunning) agent.abortRun()
      agent.pendingInterrupts = []
      agent.setMessages([])
      setRunError(null)
      setHasRestoredHistory(false)
      // `HydratedInterrupts` reports 0 for the new thread on its own, but only
      // after its effects run; clearing here keeps the composer from staying
      // blocked across the gap on the previous thread's count.
      setHydratedPendingCount(0)
    }
    if (activeThreadId === undefined || threadSource === null) return

    // Captured, not read from the ref later: this is the instance this
    // hydrate was issued against, and telling it apart from a replacement is
    // what makes the "user typed ahead" check below sound. Named for the
    // hydrate rather than the clear because only the thread-changed path
    // above actually cleared it — a nonce-driven retry captures the same
    // instance with everything still on it.
    const hydratingAgent = agent
    const hydratingThreadId = activeThreadId

    // Staleness is checked against the ref, NOT against a flag flipped in the
    // effect's cleanup: this effect re-runs (and would therefore clean up)
    // whenever `agent`'s identity changes, which would cancel a perfectly good
    // hydrate for the thread still on screen. The ref only moves when the user
    // actually switches threads, which is exactly the case where thread A's
    // history must not be painted into thread B.
    const isStale = () => renderedThreadIdRef.current !== hydratingThreadId

    // NO `isMountedRef` guard in these two continuations, unlike the probe
    // above and `MemoryPanel`'s read, and the difference is deliberate: those
    // two write React state and re-arm their flag for StrictMode, while these
    // are keyed off `isStale()` — a ref that only moves on a real thread
    // switch — and write mostly onto the agent, which outlives this component.
    // A late `setRunError` on an unmounted shell is a no-op under React 19.
    const applyRestored = (thread: HydratedThread) => {
      if (isStale()) return
      const messages = withRestoredPlan(thread, hydratingThreadId)
      if (messages.length === 0) {
        // Nothing mapped. Two very different situations, and `hydrate.ts`'s
        // `rawMessageCount` is the only thing that tells them apart.
        //
        // The checkpoint was genuinely empty (a thread that has never run,
        // whose `/state` 404s or answers with no messages): the normal case,
        // and silent — no error row, and no `setMessages` either, since the
        // clear above already left the transcript empty.
        //
        // The checkpoint HAD entries and none of them survived the mapper:
        // that is a wire-shape drift, and it would otherwise restore every
        // conversation in the app blank and indistinguishable from a new one.
        // Loud, on the run-error row — surface 2 in the error-surface note at
        // the top of this file, because the shell is up and this is about the
        // conversation on screen.
        if (thread.rawMessageCount > 0) {
          setRunError({
            title: "Could not restore this conversation",
            message:
              "Could not read this conversation's saved history — its format may be newer than this app.",
          })
        }
        return
      }
      const target = agentRef.current
      // Two different situations, and only one of them is a reason to skip.
      //
      // Same instance with messages on it. Usually that means the user got
      // ahead of the network and typed while the history was loading: their
      // message is the live one and may already have a run attached, and
      // replacing the list under that run would drop it and orphan the run's
      // appends. The nonce/recovery path reaches this same guard with nothing
      // cleared at all — the messages are simply the conversation that was
      // already on screen — and skipping is right there too, for the same
      // reason: what is mounted is live and the restore has nothing to add.
      // Either way, skip.
      //
      // A DIFFERENT instance (`useAgent` swapped the provisional agent for the
      // real one mid-flight): whatever it holds was never cleared by this
      // effect, so it is the old agent's leftovers rather than anything the
      // user did. Restoring over it is right — but its `pendingInterrupts` are
      // leftovers too, and a parked interrupt from the abandoned instance
      // makes the next run throw, so they get the same clear the switch gave
      // the original.
      if (target === hydratingAgent && target.messages.length > 0) return
      if (target !== hydratingAgent) target.pendingInterrupts = []
      // `TranscriptMessage` is a deliberate supertype of AG-UI's own `Message`
      // union (see `transcript.ts`) so that either installed copy of
      // `@ag-ui/core` assigns INTO it; going the other way needs the cast. The
      // one shape it asserts that `hydrate.ts` does not check is a user
      // message's `content`, typed `unknown` there — `userText` narrows it
      // downstream, so an odd checkpoint renders as empty text rather than
      // crashing the transcript.
      target.setMessages(messages as Parameters<typeof target.setMessages>[0])
      setHasRestoredHistory(true)
    }

    const reportHydrateFailure = (error: unknown) => {
      if (isStale()) return
      if (isProxyUnreachableError(error)) {
        // The same fact the probe exists to catch, noticed a different way —
        // a real hydrate hit the dead proxy before the next poll did. Flip
        // state rather than surfacing a row: this is surface 1's fact, not
        // surface 2's (see the error-surface note at the top of this file).
        setServerStatus("down")
        return
      }
      setRunError({
        title: "Could not restore this conversation",
        message: error instanceof Error ? error.message : String(error),
      })
    }

    // `AppShell` does not fetch: the seam does, so the LangGraph Platform
    // implementation is a swap rather than a rewrite of this effect.
    void threadSource.hydrate(hydratingThreadId).then(applyRestored, reportHydrateFailure)
  }, [activeThreadId, agent, threadSource, hydrateNonce])

  const send = useCallback(
    async (message: string) => {
      setRunError(null)
      agent.addMessage({ id: globalThis.crypto.randomUUID(), role: "user", content: message })
      onUserMessage(message)
      try {
        // `copilotkit.runAgent`, not `agent.runAgent`: the core call is what
        // attaches the frontend tools, agent context and run bookkeeping that
        // the registered renderers depend on.
        await copilotkit.runAgent({ agent })
      } catch (error) {
        // A backstop, not the main path (see the subscription above): only the
        // rejections core rethrows rather than swallows land here.
        console.error("AppShell: runAgent failed", error)
        reportRunError(error)
      }
    },
    [agent, copilotkit, onUserMessage, reportRunError],
  )

  const stop = useCallback(() => {
    agent.abortRun()
  }, [agent])

  const activeThread = threads.find((thread) => thread.id === activeThreadId)

  // Every hook above has run unconditionally on every render — this return
  // has to come after all of them, or React throws on the next render whose
  // status differs (rules of hooks). It is deliberately keyed on `"down"`
  // alone, not on the absence of `"up"`: `"checking"` is the normal shape of
  // a first paint (the initial probe has not resolved yet), and showing
  // "cannot connect" for that beat would be a lie for the common case, not
  // just an ugly flash.
  //
  // The rail and header disappear with the transcript and composer: the whole
  // point of this screen is that nothing in the shell works without a server,
  // including thread switching, so a rail that responds to clicks with
  // nothing happening is worse than no rail. `ConnectScreen` carries its own
  // brand mark so the app still has a header-equivalent identity on screen.
  //
  // The hydrate effect above still runs — it is keyed on `activeThreadId`
  // (and now `hydrateNonce`), not on this flag — and will fail against the
  // same unreachable server; `reportHydrateFailure`'s own
  // `isProxyUnreachableError` branch is what keeps that failure from landing
  // in `runError` while this screen is up (see its comment), by flipping
  // `serverStatus` instead. `HydratedInterrupts`, unmounted along with
  // `Transcript` here, simply does not run its fetch at all.
  if (serverStatus === "down") {
    return <ConnectScreen serverUrl={DEFAULT_SERVER_URL} onRetry={runProbe} />
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="flex w-64 shrink-0 flex-col gap-1 border-r border-wb-border bg-wb-rail py-4">
        <div className="px-4 pb-4">
          <span className="wb-brand-mark text-[15px] font-semibold tracking-tight">
            Dawn research
          </span>
        </div>
        <ThreadRail
          threads={threads}
          activeThreadId={activeThreadId}
          onSelect={onSelectThread}
          onCreate={onCreateThread}
        />
        {/*
          Beneath the rail, and not rendered while the server is KNOWN to be
          down — this return is already past the `serverStatus === "down"`
          branch. It does render during "checking", which is why the panel
          still has a 502 branch of its own (a silent one: see its `load`).

          Deliberately NOT thread-scoped: memory candidates are the agent's,
          not a conversation's, and the endpoint has no thread parameter.
          Switching threads leaves the panel exactly as it was, which is
          correct — the queue did not change.
        */}
        <MemoryPanel />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-13 shrink-0 items-center gap-2 border-b border-wb-border px-6">
          <h1 className="truncate text-[13px] font-medium tracking-tight">
            {activeThread?.title ?? UNTITLED_THREAD_LABEL}
          </h1>
          {agent.isRunning || isAwaitingApproval ? (
            <span className="shrink-0 text-[11px] uppercase tracking-[0.08em] text-wb-muted">
              {agent.isRunning ? "running" : "awaiting approval"}
            </span>
          ) : null}
        </header>
        {/*
          `threadKey` and the `Composer` key below both end component state at a
          thread boundary, and both are bug fixes rather than hygiene — see
          `Transcript` for what `useInterrupt` does with its own state, and
          `Composer` for the draft.

          `Transcript` takes the id as a PROP rather than as its own `key`
          because only `PermissionInterrupt`, deep inside it, needs the
          remount; keying the whole transcript would also throw away the scroll
          position and remount the empty state on every switch.
        */}
        <Transcript
          threadKey={activeThreadId}
          messages={agent.messages}
          isRunning={agent.isRunning}
          onSelectSuggestion={send}
          hasRestoredHistory={hasRestoredHistory}
          runError={runError}
          onDismissRunError={dismissRunError}
          onRunError={reportRunError}
          threadSource={threadSource}
          onHydratedPendingChange={setHydratedPendingCount}
        />
        <Composer
          key={activeThreadId}
          onSend={send}
          onStop={stop}
          isRunning={agent.isRunning}
          isAwaitingApproval={isAwaitingApproval}
        />
      </main>
    </div>
  )
}
