import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { afterEach, expect, test } from "vitest"

import { createArtifactRoot } from "../../packages/devkit/src/testing/index.ts"
import { createAimock, script } from "../../packages/testing/dist/index.js"
import { getTestRegistryUrl } from "../harness/local-registry.ts"
import {
  cleanupTrackedTempDirs,
  createTrackedTempDir,
  GENERATED_APP_UNSET_ENV,
  httpOkReadiness,
  installRegistryScaffolderWithNpm,
  markTrackedTempDirForPreserve,
  runGeneratedAppNpmCommand,
  runPackagedNpmCommand,
  type TrackedTempDir,
  withPackagedNpmServer,
} from "../harness/packaged-app.ts"
import { writeRegistryNpmrc } from "../harness/scaffold-packaging.ts"

const tempDirs: TrackedTempDir[] = []
// Measured on 2026-08-26, two-process session (macOS, node 24.19.0 / npm
// 11.17.0, warm npm cache, Verdaccio uplink already populated, box running
// other agents' builds). Body totals across three green runs: 174s / 203s /
// 230s. Per-command, from the 203s run:
//   root `npm install` 136.6s          `npm run build` 23.1s
//   `dawn dev` boot+readiness 4.9s     `npm start` boot+readiness 1.6s
//   dev session total 12.3s, of which the NESTED web client is:
//     `npm run dev:web` boot + /api/dawn/memory/candidates readiness  2.6s
//     the six web assertions (incl. a 3.8s cold /api/copilotkit compile) 3.9s
//     web teardown 87ms; the Dawn child's own teardown after it, 58ms
// So the web tier costs ~6.6s. Do not read a body total as a regression signal:
// `npm install` alone swung 92-137s across measurements, several times the
// web tier's whole cost.
// (2026-08-25 single-process reference, body 144s: install 92.2s, typegen 2.0s,
// check 1.2s, typecheck 4.0s, `npm test` 4.4s, eval 1.6s, verify 1.6s, build
// 16.1s, dev session 3.2s, start session 1.6s.)
// Raised from 600_000 because the workspace restructure added the web client's
// dependency set to the install and a `next build` to the build. A cold CI
// runner is the pessimistic case: ~3x on the network-bound install, ~4x on the
// rest. Off the 144s reference that landed near 350s; off the slowest install
// measured here it lands near 670s, which still leaves ~1.8x headroom.
const ACTIVATION_TIMEOUT_MS = 1_200_000
// Covers everything after the lifecycle deadline fires. The non-aborted cost is
// tiny — 87ms + 58ms + 29ms to reap all three children — but the ABORTED path is
// what this reserves for: each nesting level waits up to
// PACKAGED_NPM_ACTION_SETTLE_MS (5s) for its action to unwind, then up to a 2s
// grace plus a 2s force window per child, plus the transcript appends.
const ACTIVATION_CLEANUP_RESERVE_MS = 30_000
// The install is the one command with no headroom under the harness-wide
// PACKAGED_COMMAND_TIMEOUT_MS (180_000): 92.2-136.6s measured warm, and it
// resolves ~1.3GB across both workspace members through Verdaccio's npmjs
// uplink, so a cold registry plausibly overruns 180s. Nothing else does —
// `npm run build` measured 16.1-23.1s against that same 180s budget — so this
// is the only override.
const WORKSPACE_INSTALL_TIMEOUT_MS = 600_000
const SAFE_PROMPT = "What are common agent architectures? Write a short cited report."
const SUBQUESTION = "Identify common agent architectures and cite the corpus."
const CHILD_REPLY =
  "ReAct and plan-and-execute are common agent architectures. [corpus/agent-architectures.md]"
const GATED_PROMPT =
  "The corpus has nothing on quantum computing — run the external fetch script for it with runBash."
const FETCH_COMMAND = "node scripts/fetch-source.mjs quantum computing"
const BUILT_PROMPT = "Built artifact environment smoke."
const GATED_REPLY = "Fetched external context after approval."
const BUILT_REPLY = "built-env-smoke-ok"
const FETCH_STDOUT =
  'No external source configured for "quantum computing". Edit workspace/scripts/fetch-source.mjs to fetch real content.\n'
// The web hop's own journeys. Dedicated prompts, not SAFE_PROMPT/GATED_PROMPT:
// they keep the three direct journeys' aimock accounting untouched and remove
// any dependence on whether an aimock fixture is consumed or reusable.
const WEB_PROMPT = "Web hop smoke: outline the workbench check."
const WEB_REPLY = "Workbench reached the Dawn server through the CopilotKit runtime."
const WEB_TODOS = [
  { content: "Confirm the web client reaches the Dawn server", status: "completed" },
]
const WEB_GATED_PROMPT = "Web hop gate: run the external fetch script for the workbench check."
const WEB_FETCH_COMMAND = "node scripts/fetch-source.mjs workbench hop"
const WEB_GATED_REPLY = "Fetched external context after approval through the web client."
// CopilotKit's fetch-router matches `agent/<agentId>/run`; `default` is the id
// the runtime route registers and every CopilotKit hook resolves.
const COPILOTKIT_RUN_PATH = "/api/copilotkit/agent/default/run"
// The allowlisted read the generated app itself treats as "the Dawn server
// answered" (`AppShell.tsx`'s SERVER_PROBE_PATH). A 2xx means the route's whole
// module graph compiled AND the proxy reached a Dawn server.
const WEB_READY_PATH = "/api/dawn/memory/candidates"
const todos = [
  { content: "Restate the question and list the sub-questions to research", status: "completed" },
  { content: "Search the corpus for each sub-question", status: "in_progress" },
  { content: "Read the most relevant documents in full", status: "pending" },
  { content: "Synthesize a cited report and write it to the workspace", status: "pending" },
]
const report = `# Common agent architectures

- ReAct interleaves reasoning with tool use.
- Plan-and-execute separates planning from execution.

[corpus/agent-architectures.md]
`

type AgUiEvent = Record<string, unknown>
type AgUiIdKind = "interrupt" | "message" | "run" | "thread" | "tool-call"

interface AgUiExchange {
  readonly events: readonly AgUiEvent[]
  readonly rawSse: string
  readonly status: number
}

interface AgUiTranscriptRecorder {
  append(entry: unknown): Promise<void>
  registerServerUrl(url: string): void
}

function createSafeResearchFixtures() {
  const root = script()
    .user(SAFE_PROMPT)
    .callsTool("recall", { query: "agent architectures report preferences" })
    .callsTool("writeTodos", { todos })
    .callsTool("task", { subagent: "researcher", input: SUBQUESTION })
    .callsTool("searchCorpus", { query: "agent architectures" })
    .callsTool("readDoc", { path: "corpus/agent-architectures.md" })
    .callsTool("writeFile", { path: "reports/agent-architectures.md", content: report })
    .replies(
      "I wrote a short report covering ReAct and plan-and-execute architectures. [corpus/agent-architectures.md]",
    )
    .build()
  const child = script()
    .user(SUBQUESTION)
    .callsTool("searchCorpus", { query: "agent architectures" })
    .callsTool("readDoc", { path: "corpus/agent-architectures.md" })
    .replies(CHILD_REPLY)
    .build()
  return [...root, ...child]
}

function createGatedAndBuiltFixtures() {
  return [
    ...script()
      .user(GATED_PROMPT)
      .callsTool("runBash", { command: FETCH_COMMAND })
      .replies(GATED_REPLY)
      .build(),
    ...script().user(BUILT_PROMPT).replies(BUILT_REPLY).build(),
  ]
}

function createWebHopFixtures() {
  return [
    ...script()
      .user(WEB_PROMPT)
      .callsTool("writeTodos", { todos: WEB_TODOS })
      .replies(WEB_REPLY)
      .build(),
    ...script()
      .user(WEB_GATED_PROMPT)
      .callsTool("runBash", { command: WEB_FETCH_COMMAND })
      .replies(WEB_GATED_REPLY)
      .build(),
  ]
}

function correlateRootToolCalls(events: readonly AgUiEvent[]): Map<string, unknown> {
  const toolEvents = events.filter((event) =>
    ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"].includes(
      String(event.type),
    ),
  )
  const starts = events.flatMap((event, index) =>
    event.type === "TOOL_CALL_START" ? [{ event, index }] : [],
  )
  // `writeTodos` and `task` are absent by design: each presents once, as its
  // dawn.plan / dawn.subagent activity, with no generic tool frames.
  expect(starts.map(({ event }) => event.toolCallName)).toEqual([
    "recall",
    "searchCorpus",
    "readDoc",
    "writeFile",
  ])

  const startIds = starts.map(({ event }) => event.toolCallId)
  expect(startIds.every((id) => typeof id === "string")).toBe(true)
  expect(new Set(startIds).size).toBe(startIds.length)
  const knownIds = new Set(startIds)
  for (const event of toolEvents) {
    expect(typeof event.toolCallId).toBe("string")
    expect(knownIds.has(event.toolCallId)).toBe(true)
  }
  for (const { event } of starts) {
    expect(String(event.toolCallId)).toMatch(/^call_/)
  }

  const parsedArgsByName = new Map<string, unknown>()
  for (const { event: start } of starts) {
    const toolCallId = start.toolCallId
    const toolCallName = start.toolCallName
    if (typeof toolCallId !== "string" || typeof toolCallName !== "string") {
      throw new Error("AG-UI tool start omitted its string id or name")
    }
    const correlated = events.filter((event) => event.toolCallId === toolCallId)
    const argEvents = correlated.filter((event) => event.type === "TOOL_CALL_ARGS")
    expect(argEvents.length).toBeGreaterThan(0)
    expect(correlated.map((event) => event.type)).toEqual([
      "TOOL_CALL_START",
      ...argEvents.map(() => "TOOL_CALL_ARGS"),
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
    ])
    const encodedArgs = argEvents
      .map((event) => {
        if (typeof event.delta !== "string") {
          throw new Error(`AG-UI ${toolCallName} args delta was not a string`)
        }
        return event.delta
      })
      .join("")
    const outerArgs = JSON.parse(encodedArgs) as unknown
    const parsedArgs =
      outerArgs !== null &&
      typeof outerArgs === "object" &&
      !Array.isArray(outerArgs) &&
      Object.keys(outerArgs).length === 1 &&
      typeof Reflect.get(outerArgs, "input") === "string"
        ? (JSON.parse(Reflect.get(outerArgs, "input") as string) as unknown)
        : outerArgs
    parsedArgsByName.set(toolCallName, parsedArgs)
  }
  return parsedArgsByName
}

function reconstructAssistantText(events: readonly AgUiEvent[]): string {
  return events
    .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
    .map((event) => {
      if (typeof event.delta !== "string") {
        throw new Error("AG-UI text delta was not a string")
      }
      return event.delta
    })
    .join("")
}

function expectNoActivitySnapshots(events: readonly AgUiEvent[]): void {
  expect(events.filter((event) => event.type === "ACTIVITY_SNAPSHOT")).toEqual([])
}

function parseAgUiSse(rawSse: string): AgUiEvent[] {
  return rawSse.split(/\r?\n\r?\n/).flatMap((frame) =>
    frame.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith("data: ")) return []
      const decoded = JSON.parse(line.slice("data: ".length)) as unknown
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new Error("AG-UI SSE data was not a JSON object")
      }
      return [decoded as AgUiEvent]
    }),
  )
}

function createAgUiTranscriptRecorder(options: {
  readonly aimockUrl: string
  readonly path: string
  readonly tempRoot: string
}): AgUiTranscriptRecorder {
  const ids: Record<AgUiIdKind, Map<string, string>> = {
    interrupt: new Map(),
    message: new Map(),
    run: new Map(),
    thread: new Map(),
    "tool-call": new Map(),
  }
  const replacements: Array<readonly [literal: string, marker: string]> = []
  const addReplacement = (literal: string, marker: string): void => {
    if (literal.length === 0 || replacements.some(([existing]) => existing === literal)) return
    replacements.push([literal, marker])
    replacements.sort(([left], [right]) => right.length - left.length)
  }
  if (options.tempRoot.startsWith("/var/")) {
    addReplacement(`/private${options.tempRoot}`, "<temp-root>")
  }
  addReplacement(options.tempRoot, "<temp-root>")
  addReplacement(options.aimockUrl, "<aimock-url>")
  addReplacement(new URL(options.aimockUrl).origin, "<aimock-origin>")

  const mappedId = (kind: AgUiIdKind, value: string): string => {
    const existing = ids[kind].get(value)
    if (existing !== undefined) return existing
    const mapped = `<${kind}-${ids[kind].size + 1}>`
    ids[kind].set(value, mapped)
    return mapped
  }
  const sanitizeString = (value: string): string => {
    let sanitized = value
    for (const [literal, marker] of replacements) {
      sanitized = sanitized.split(literal).join(marker)
    }
    for (const mapping of Object.values(ids)) {
      for (const [literal, marker] of mapping) {
        sanitized = sanitized.split(literal).join(marker)
      }
    }
    return sanitized
  }
  const sanitize = (value: unknown, parentKey?: string): unknown => {
    if (typeof value === "string") return sanitizeString(value)
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry, parentKey))
    if (value === null || typeof value !== "object") return value

    const record = value as Record<string, unknown>
    const isMessage =
      (parentKey === "messages" || parentKey === "kwargs") && typeof record.id === "string"
    const isToolCall =
      (parentKey === "tool_calls" || parentKey === "tool_call_chunks") &&
      typeof record.id === "string"
    const isInterrupt =
      (parentKey === "interrupts" || parentKey === "resume") && typeof record.id === "string"
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => {
        if (key === "rawSse" && typeof entry === "string") {
          for (const line of entry.split(/\r?\n/)) {
            if (!line.startsWith("data: ")) continue
            try {
              sanitize(JSON.parse(line.slice("data: ".length)) as unknown)
            } catch {
              // Cancellation can leave a partial frame; earlier complete frames still map.
            }
          }
          return [key, sanitizeString(entry)]
        }
        if (typeof entry === "string") {
          try {
            const decoded = JSON.parse(entry) as unknown
            if (decoded !== null && typeof decoded === "object") sanitize(decoded, key)
          } catch {
            // Most transcript strings are prose; parse only embedded JSON envelopes.
          }
        }
        let kind: AgUiIdKind | undefined
        if (key === "threadId" || key === "thread_id") kind = "thread"
        else if (
          key === "runId" ||
          key === "run_id" ||
          key === "parentRunId" ||
          key === "parent_run_id"
        ) {
          kind = "run"
        } else if (
          key === "messageId" ||
          key === "message_id" ||
          key === "parentMessageId" ||
          key === "parent_message_id"
        ) {
          kind = "message"
        } else if (
          key === "toolCallId" ||
          key === "tool_call_id" ||
          key === "callId" ||
          key === "call_id"
        ) {
          kind = "tool-call"
        } else if (key === "interruptId" || key === "interrupt_id") kind = "interrupt"
        else if (key === "id" && isMessage) kind = "message"
        else if (key === "id" && isToolCall) kind = "tool-call"
        else if (key === "id" && isInterrupt) kind = "interrupt"
        return [
          key,
          kind !== undefined && typeof entry === "string"
            ? mappedId(kind, entry)
            : sanitize(entry, key),
        ]
      }),
    )
  }

  const transcript: unknown[] = [
    sanitize({
      type: "context",
      tempRoot: options.tempRoot,
      aimockUrl: options.aimockUrl,
      aimockOrigin: new URL(options.aimockUrl).origin,
    }),
  ]
  return {
    async append(entry) {
      transcript.push(sanitize(entry))
      await writeFile(options.path, `${JSON.stringify(transcript, null, 2)}\n`, "utf8")
    },
    registerServerUrl(url) {
      const sequence =
        replacements.filter(([, marker]) => marker.startsWith("<server-url-")).length + 1
      addReplacement(url, `<server-url-${sequence}>`)
    },
  }
}

async function appendAgUiFailure(
  recorder: AgUiTranscriptRecorder,
  entry: unknown,
  originalError: unknown,
): Promise<never> {
  try {
    await recorder.append(entry)
  } catch (transcriptError) {
    throw new AggregateError(
      [originalError, transcriptError],
      "AG-UI request and transcript recording both failed",
      { cause: originalError },
    )
  }
  throw originalError
}

async function postAgui(options: {
  readonly baseUrl: string
  /**
   * Where to POST. Defaults to the Dawn server's own AG-UI route; the web hop
   * points it at CopilotKit's runtime instead. Nothing else changes: the
   * runtime accepts a plain AG-UI `RunAgentInput` — the same object built below
   * — and answers `text/event-stream` of raw `data: {...}` AG-UI frames.
   */
  readonly endpointPath?: string
  readonly messages: readonly {
    readonly content: string
    readonly id: string
    readonly role: string
  }[]
  readonly recorder: AgUiTranscriptRecorder
  readonly resumeFields?: Readonly<Record<string, unknown>>
  readonly runId: string
  readonly signal: AbortSignal
  readonly threadId: string
}): Promise<AgUiExchange> {
  const body = {
    threadId: options.threadId,
    runId: options.runId,
    messages: options.messages,
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
    ...options.resumeFields,
  }
  const routeKey = encodeURIComponent("/research#agent")
  const endpoint = new URL(options.endpointPath ?? `/agui/${routeKey}`, options.baseUrl)
  const requestSignal = AbortSignal.any([options.signal, AbortSignal.timeout(60_000)])
  await options.recorder.append({ type: "request", endpoint: endpoint.href, body })

  let response: Response | undefined
  let rawSse = ""
  let events: AgUiEvent[] = []
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    })
    if (response.body === null) throw new Error("AG-UI response omitted its SSE body")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        requestSignal.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        rawSse += decoder.decode(chunk.value, { stream: true })
      }
      rawSse += decoder.decode()
      requestSignal.throwIfAborted()
    } finally {
      reader.releaseLock()
    }
    events = parseAgUiSse(rawSse)
  } catch (error) {
    return await appendAgUiFailure(
      options.recorder,
      {
        type: "response-error",
        ...(response !== undefined ? { status: response.status } : {}),
        ...(rawSse.length > 0 ? { rawSse } : {}),
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      },
      error,
    )
  }

  const transcriptEntry = {
    type: "response",
    status: response.status,
    events,
    rawSse,
  }
  if (!response.ok) {
    const error = new Error(`AG-UI request failed with HTTP ${response.status}`)
    return await appendAgUiFailure(options.recorder, transcriptEntry, error)
  }
  await options.recorder.append(transcriptEntry)
  return { events, rawSse, status: response.status }
}

function assertSuccessfulTerminal(
  events: readonly AgUiEvent[],
  ids: { readonly runId: string; readonly threadId: string },
): void {
  expect(events[0]).toMatchObject({
    type: "RUN_STARTED",
    runId: ids.runId,
    threadId: ids.threadId,
  })
  expect(events.filter((event) => event.type === "RUN_ERROR")).toEqual([])
  const finished = events.filter((event) => event.type === "RUN_FINISHED")
  expect(finished).toHaveLength(1)
  expect(finished[0]).toMatchObject({
    runId: ids.runId,
    threadId: ids.threadId,
  })
  expect(finished[0]?.outcome).toEqual({ type: "success" })
  expect(events.at(-1)).toEqual(finished[0])
}

function assertSafeResearchJourney(
  events: readonly AgUiEvent[],
  ids: { readonly runId: string; readonly threadId: string },
): void {
  assertSuccessfulTerminal(events, ids)

  const parsedArgsByName = correlateRootToolCalls(events)
  // `task`'s arguments no longer reach the wire — the subagent activity is its
  // only presentation — so an ordinary tool carries the args-decoding pin.
  expect(parsedArgsByName.has("task")).toBe(false)
  expect(parsedArgsByName.has("writeTodos")).toBe(false)
  expect(parsedArgsByName.get("searchCorpus")).toEqual({ query: "agent architectures" })
  const assistantText = reconstructAssistantText(events)
  expect(assistantText).toContain("[corpus/agent-architectures.md]")
  expect(assistantText).not.toContain(CHILD_REPLY)

  const activities = events.filter((event) => event.type === "ACTIVITY_SNAPSHOT")
  expect(activities).toEqual([
    {
      type: "ACTIVITY_SNAPSHOT",
      messageId: `dawn:plan:${ids.runId}`,
      activityType: "dawn.plan",
      replace: true,
      content: { todos },
    },
    {
      type: "ACTIVITY_SNAPSHOT",
      messageId: "dawn:subagent:call_task_0_2",
      activityType: "dawn.subagent",
      replace: true,
      content: {
        name: "researcher",
        depth: 1,
        status: "running",
        tools: [],
        totalToolCount: 0,
      },
    },
    {
      type: "ACTIVITY_SNAPSHOT",
      messageId: "dawn:subagent:call_task_0_2",
      activityType: "dawn.subagent",
      replace: true,
      content: {
        name: "researcher",
        depth: 1,
        status: "running",
        tools: [{ name: "searchCorpus", status: "running" }],
        totalToolCount: 1,
      },
    },
    {
      type: "ACTIVITY_SNAPSHOT",
      messageId: "dawn:subagent:call_task_0_2",
      activityType: "dawn.subagent",
      replace: true,
      content: {
        name: "researcher",
        depth: 1,
        status: "running",
        tools: [{ name: "searchCorpus", status: "completed" }],
        totalToolCount: 1,
      },
    },
    {
      type: "ACTIVITY_SNAPSHOT",
      messageId: "dawn:subagent:call_task_0_2",
      activityType: "dawn.subagent",
      replace: true,
      content: {
        name: "researcher",
        depth: 1,
        status: "running",
        tools: [
          { name: "searchCorpus", status: "completed" },
          { name: "readDoc", status: "running" },
        ],
        totalToolCount: 2,
      },
    },
    {
      type: "ACTIVITY_SNAPSHOT",
      messageId: "dawn:subagent:call_task_0_2",
      activityType: "dawn.subagent",
      replace: true,
      content: {
        name: "researcher",
        depth: 1,
        status: "running",
        tools: [
          { name: "searchCorpus", status: "completed" },
          { name: "readDoc", status: "completed" },
        ],
        totalToolCount: 2,
      },
    },
    {
      type: "ACTIVITY_SNAPSHOT",
      messageId: "dawn:subagent:call_task_0_2",
      activityType: "dawn.subagent",
      replace: true,
      content: {
        name: "researcher",
        depth: 1,
        status: "completed",
        tools: [
          { name: "searchCorpus", status: "completed" },
          { name: "readDoc", status: "completed" },
        ],
        totalToolCount: 2,
      },
    },
  ])

  // The generic frames for the two built-in orchestration calls are gone: the
  // activities above are the only presentation of that work.
  const toolFrames = events.filter((event) =>
    ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"].includes(
      String(event.type),
    ),
  )
  for (const suppressedId of ["call_writeTodos_0_1", "call_task_0_2"]) {
    expect(toolFrames.map((event) => event.toolCallId)).not.toContain(suppressedId)
  }
  expect(
    events.filter((event) => event.type === "TOOL_CALL_START").map((event) => event.toolCallName),
  ).not.toContain("writeTodos")
  expect(
    events.filter((event) => event.type === "TOOL_CALL_START").map((event) => event.toolCallName),
  ).not.toContain("task")

  const activityIndices = activities.map((activity) => events.indexOf(activity))
  const firstFinalTextIndex = events.findIndex((event) => event.type === "TEXT_MESSAGE_CONTENT")
  expect(firstFinalTextIndex).toBeGreaterThanOrEqual(0)
  expect(activityIndices.every((index) => index < firstFinalTextIndex)).toBe(true)

  const serializedActivityContent = JSON.stringify(activities.map((activity) => activity.content))
  for (const privateValue of [
    SUBQUESTION,
    CHILD_REPLY,
    report,
    "corpus/agent-architectures.md",
    "call_task_0_2",
    "call_searchCorpus_0_0",
    "call_readDoc_0_1",
    '"call_id"',
    '"route_id"',
    '"id"',
    '"input"',
    '"output"',
    '"final_message"',
  ]) {
    expect(serializedActivityContent).not.toContain(privateValue)
  }
  // Logical tool-call ids are the public tool identity now (amended AG-UI
  // orchestration projection design): present as toolCallId, but never
  // inside activity content.
  for (const activity of events.filter((event) => event.type === "ACTIVITY_SNAPSHOT")) {
    expect(JSON.stringify(activity.content)).not.toMatch(/call_[A-Za-z]+_\d+_\d+/)
  }
  const kinds = events.map((event) => event.type)
  expect(kinds).not.toContain("ACTIVITY_DELTA")
  expect(kinds).not.toContain("CUSTOM")
  expect(kinds).not.toContain("RAW")
  expect(kinds).not.toContain("STATE_SNAPSHOT")
}

function assertGatedResearchInterrupt(
  events: readonly AgUiEvent[],
  ids: { readonly runId: string; readonly threadId: string },
): { readonly gatedToolCallId: string; readonly interruptId: string } {
  expect(events[0]).toMatchObject({
    type: "RUN_STARTED",
    runId: ids.runId,
    threadId: ids.threadId,
  })
  expect(events.filter((event) => event.type === "RUN_ERROR")).toEqual([])
  const finished = events.filter((event) => event.type === "RUN_FINISHED")
  expect(finished).toHaveLength(1)
  expect(finished[0]).toMatchObject({
    outcome: { type: "interrupt" },
    runId: ids.runId,
    threadId: ids.threadId,
  })
  expect(finished[0]).not.toHaveProperty("result")
  expect(events.at(-1)).toEqual(finished[0])

  const outcome = finished[0]?.outcome as
    | { readonly interrupts?: readonly unknown[]; readonly type?: unknown }
    | undefined
  expect(outcome?.type).toBe("interrupt")
  expect(outcome?.interrupts).toHaveLength(1)
  const interrupt = outcome?.interrupts?.[0]
  if (interrupt === null || typeof interrupt !== "object" || Array.isArray(interrupt)) {
    throw new Error("Gated AG-UI journey omitted its permission interrupt")
  }
  const interruptRecord = interrupt as Record<string, unknown>
  const interruptId = interruptRecord.id
  const metadata = interruptRecord.metadata
  if (
    typeof interruptId !== "string" ||
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new Error("Gated AG-UI permission interrupt omitted its id or metadata")
  }
  expect(interruptRecord.reason).toBe("command")
  expect(metadata).toMatchObject({
    interruptId,
    type: "permission-request",
    kind: "command",
    detail: { command: FETCH_COMMAND },
  })

  const starts = events.filter((event) => event.type === "TOOL_CALL_START")
  expect(starts.map((event) => event.toolCallName)).toEqual(["runBash"])
  const toolCallId = starts[0]?.toolCallId
  if (typeof toolCallId !== "string") {
    throw new Error("Gated runBash start omitted its tool-call id")
  }
  expect(toolCallId).toBe("call_runBash_0_0")
  const correlated = events.filter((event) => event.toolCallId === toolCallId)
  const argEvents = correlated.filter((event) => event.type === "TOOL_CALL_ARGS")
  expect(argEvents.length).toBeGreaterThan(0)
  expect(correlated.map((event) => event.type)).toEqual([
    "TOOL_CALL_START",
    ...argEvents.map(() => "TOOL_CALL_ARGS"),
    "TOOL_CALL_END",
  ])
  const encodedArgs = argEvents
    .map((event) => {
      if (typeof event.delta !== "string") {
        throw new Error("Gated runBash args delta was not a string")
      }
      return event.delta
    })
    .join("")
  // The re-keyed projection announces root tool calls from the model turn,
  // so ARGS carry the model's parsed args directly (no ToolNode {input} wrapper).
  expect(JSON.parse(encodedArgs)).toEqual({ command: FETCH_COMMAND })
  expect(events.filter((event) => event.type === "TOOL_CALL_RESULT")).toEqual([])
  expect(
    events.filter(
      (event) => event.type === "TOOL_CALL_START" && event.toolCallName === "writeFile",
    ),
  ).toEqual([])
  expect(events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT")).toEqual([])
  expectNoActivitySnapshots(events)

  return { gatedToolCallId: toolCallId, interruptId }
}

function assertResumedGatedJourney(
  events: readonly AgUiEvent[],
  ids: { readonly runId: string; readonly threadId: string },
  gatedToolCallId: string,
): void {
  assertSuccessfulTerminal(events, ids)

  const starts = events.filter((event) => event.type === "TOOL_CALL_START")
  expect(starts.map((event) => event.toolCallName)).toEqual(["runBash"])
  const toolCallId = starts[0]?.toolCallId
  if (typeof toolCallId !== "string") {
    throw new Error("Resumed runBash start omitted its tool-call id")
  }
  expect(toolCallId).toBe(gatedToolCallId)
  const correlated = events.filter((event) => event.toolCallId === toolCallId)
  const argEvents = correlated.filter((event) => event.type === "TOOL_CALL_ARGS")
  expect(argEvents.length).toBeGreaterThan(0)
  expect(correlated.map((event) => event.type)).toEqual([
    "TOOL_CALL_START",
    ...argEvents.map(() => "TOOL_CALL_ARGS"),
    "TOOL_CALL_END",
    "TOOL_CALL_RESULT",
  ])
  const encodedArgs = argEvents
    .map((event) => {
      if (typeof event.delta !== "string") {
        throw new Error("Resumed runBash args delta was not a string")
      }
      return event.delta
    })
    .join("")
  const outerArgs = JSON.parse(encodedArgs) as { readonly input?: unknown }
  expect(Object.keys(outerArgs)).toEqual(["input"])
  expect(typeof outerArgs.input).toBe("string")
  expect(JSON.parse(String(outerArgs.input))).toEqual({ command: FETCH_COMMAND })

  const toolResult = correlated.find((event) => event.type === "TOOL_CALL_RESULT")
  if (toolResult === undefined || typeof toolResult.content !== "string") {
    throw new Error("Resumed runBash omitted its string tool result")
  }
  const serializedToolMessage = JSON.parse(toolResult.content) as unknown
  if (
    serializedToolMessage === null ||
    typeof serializedToolMessage !== "object" ||
    Array.isArray(serializedToolMessage)
  ) {
    throw new Error("Resumed runBash result was not a serialized ToolMessage")
  }
  const toolMessage = serializedToolMessage as Record<string, unknown>
  expect(toolMessage).toMatchObject({ lc: 1, type: "constructor" })
  expect(toolMessage.id).toEqual(expect.arrayContaining(["langchain_core", "messages"]))
  expect(Array.isArray(toolMessage.id) ? toolMessage.id.at(-1) : undefined).toBe("ToolMessage")
  const kwargs = toolMessage.kwargs
  if (kwargs === null || typeof kwargs !== "object" || Array.isArray(kwargs)) {
    throw new Error("Serialized runBash ToolMessage omitted its kwargs")
  }
  expect(kwargs).toMatchObject({ status: "success", name: "runBash" })
  const commandResult = Reflect.get(kwargs, "content")
  if (typeof commandResult !== "string") {
    throw new Error("Serialized runBash ToolMessage omitted its string content")
  }
  expect(JSON.parse(commandResult)).toEqual({
    stdout: FETCH_STDOUT,
    stderr: "",
    exitCode: 0,
  })
  const resultIndex = events.indexOf(toolResult)
  const firstTextIndex = events.findIndex((event) => event.type === "TEXT_MESSAGE_CONTENT")
  expect(resultIndex).toBeGreaterThanOrEqual(0)
  expect(firstTextIndex).toBeGreaterThan(resultIndex)
  expect(reconstructAssistantText(events)).toBe(GATED_REPLY)
  expectNoActivitySnapshots(events)
}

function assertBuiltArtifactJourney(
  events: readonly AgUiEvent[],
  ids: { readonly runId: string; readonly threadId: string },
): void {
  assertSuccessfulTerminal(events, ids)
  expect(events.filter((event) => event.type === "TOOL_CALL_START")).toEqual([])
  expect(reconstructAssistantText(events)).toBe(BUILT_REPLY)
  expectNoActivitySnapshots(events)
}

/**
 * W4 — Dawn's events survive a third-party runtime that re-validates and
 * re-encodes every frame.
 *
 * Deliberately without run/thread id equality on the terminal frames: CopilotKit
 * adds an `input` echo to RUN_STARTED, and id echo is a property of a
 * third-party runtime rather than of Dawn. The thread-state read at the call
 * site proves the id round-trip in a way that does not depend on it.
 */
function assertWebHopJourney(events: readonly AgUiEvent[]): void {
  expect(events.filter((event) => event.type === "RUN_ERROR")).toEqual([])
  const finished = events.filter((event) => event.type === "RUN_FINISHED")
  expect(finished).toHaveLength(1)
  expect(finished[0]?.outcome).toEqual({ type: "success" })
  expect(events.at(-1)).toEqual(finished[0])
  expect(reconstructAssistantText(events)).toBe(WEB_REPLY)

  // CONTENT equality, not mere presence: a runtime that dropped `content` would
  // still emit the event, and this assertion would still be green.
  const activities = events.filter((event) => event.type === "ACTIVITY_SNAPSHOT")
  expect(activities).toHaveLength(1)
  expect(activities[0]).toMatchObject({
    activityType: "dawn.plan",
    content: { todos: WEB_TODOS },
    replace: true,
  })
  expect(String(activities[0]?.messageId)).toMatch(/^dawn:plan:/)
  expect(
    events.filter((event) => event.type === "TOOL_CALL_START").map((event) => event.toolCallName),
  ).not.toContain("writeTodos")
}

/**
 * W5, first half — the interrupt outcome survives the CopilotKit hop. Mirrors
 * `assertGatedResearchInterrupt` minus the run/thread id equality.
 */
function assertWebGatedInterrupt(events: readonly AgUiEvent[]): {
  readonly gatedToolCallId: string
  readonly interruptId: string
} {
  expect(events.filter((event) => event.type === "RUN_ERROR")).toEqual([])
  const finished = events.filter((event) => event.type === "RUN_FINISHED")
  expect(finished).toHaveLength(1)
  expect(finished[0]).toMatchObject({ outcome: { type: "interrupt" } })
  expect(events.at(-1)).toEqual(finished[0])

  const outcome = finished[0]?.outcome as
    | { readonly interrupts?: readonly unknown[]; readonly type?: unknown }
    | undefined
  expect(outcome?.interrupts).toHaveLength(1)
  const interrupt = outcome?.interrupts?.[0]
  if (interrupt === null || typeof interrupt !== "object" || Array.isArray(interrupt)) {
    throw new Error("Web gated journey omitted its permission interrupt")
  }
  const interruptRecord = interrupt as Record<string, unknown>
  const interruptId = interruptRecord.id
  if (typeof interruptId !== "string") {
    throw new Error("Web gated permission interrupt omitted its id")
  }
  expect(interruptRecord.reason).toBe("command")
  expect(interruptRecord.metadata).toMatchObject({
    type: "permission-request",
    kind: "command",
    detail: { command: WEB_FETCH_COMMAND },
  })

  const starts = events.filter((event) => event.type === "TOOL_CALL_START")
  expect(starts.map((event) => event.toolCallName)).toEqual(["runBash"])
  const toolCallId = starts[0]?.toolCallId
  if (typeof toolCallId !== "string") {
    throw new Error("Web gated runBash start omitted its tool-call id")
  }
  expect(events.filter((event) => event.type === "TOOL_CALL_RESULT")).toEqual([])
  expect(events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT")).toEqual([])
  expectNoActivitySnapshots(events)

  return { gatedToolCallId: toolCallId, interruptId }
}

/**
 * W5, second half — the resume envelope survives the hop and lands on the SAME
 * tool call. The serialized ToolMessage envelope is deliberately not re-checked:
 * `assertResumedGatedJourney` already pins that against the server directly.
 */
function assertWebResumedJourney(events: readonly AgUiEvent[], gatedToolCallId: string): void {
  expect(events.filter((event) => event.type === "RUN_ERROR")).toEqual([])
  const finished = events.filter((event) => event.type === "RUN_FINISHED")
  expect(finished).toHaveLength(1)
  expect(finished[0]?.outcome).toEqual({ type: "success" })
  expect(events.at(-1)).toEqual(finished[0])

  const starts = events.filter((event) => event.type === "TOOL_CALL_START")
  expect(starts.map((event) => event.toolCallName)).toEqual(["runBash"])
  expect(starts[0]?.toolCallId).toBe(gatedToolCallId)
  const correlated = events.filter((event) => event.toolCallId === gatedToolCallId)
  const result = correlated.find((event) => event.type === "TOOL_CALL_RESULT")
  if (result === undefined) {
    throw new Error("Resumed web runBash omitted its tool result")
  }
  const resultIndex = events.indexOf(result)
  const firstTextIndex = events.findIndex((event) => event.type === "TEXT_MESSAGE_CONTENT")
  expect(firstTextIndex).toBeGreaterThan(resultIndex)
  expect(reconstructAssistantText(events)).toBe(WEB_GATED_REPLY)
}

function assertRecordedServerExit(
  transcript: string,
  options: { readonly appRoot: string; readonly script: "dev" | "dev:web" | "start" },
): void {
  // `npm run dev` is a PREFIX of `npm run dev:web`, and the two-process dev
  // session records both. `lastIndexOf` on a bare prefix happens to land on the
  // right block today only because nesting appends the inner child FIRST — a
  // green-by-accident that would flip the day the ordering changes. Match the
  // whole command line instead.
  const lines = transcript.split("\n")
  const opening = `$ (cd ${options.appRoot} && npm run ${options.script}`
  const commandLineIndex = lines.findLastIndex(
    (line) =>
      line.startsWith(opening) && (line[opening.length] === " " || line[opening.length] === ")"),
  )
  expect(commandLineIndex).toBeGreaterThanOrEqual(0)
  // Bound the block at the NEXT recorded command too. Nesting appends the inner
  // (web) child FIRST, so a slice that ran to the end of the file would read the
  // SERVER block's exit line and pronounce the web child recorded no matter what
  // the web block actually says.
  const nextCommandOffset = lines
    .slice(commandLineIndex + 1)
    .findIndex((line) => /^\$ \(cd .+ && .+\)$/.test(line))
  const commandBlock = (
    nextCommandOffset < 0
      ? lines.slice(commandLineIndex)
      : lines.slice(commandLineIndex, commandLineIndex + 1 + nextCommandOffset)
  ).join("\n")
  expect(commandBlock).not.toContain("[exit pending")
  expect(commandBlock).not.toContain("[exit unavailable")
  expect(commandBlock).toMatch(/\[exit (?:-?\d+|null) signal (?:[A-Z0-9]+|none)\]/)
}

async function assertReadyHealth(baseUrl: string, signal: AbortSignal): Promise<void> {
  const healthSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  const response = await fetch(new URL("/healthz", baseUrl), { signal: healthSignal })
  const body = (await response.json()) as unknown
  healthSignal.throwIfAborted()
  expect(response.status).toBe(200)
  expect(body).toEqual({ status: "ready" })
}

async function fetchWeb(baseUrl: string, path: string, signal: AbortSignal): Promise<Response> {
  // 60s, not the 10s `assertReadyHealth` uses: Next compiles route handlers
  // lazily and `/api/copilotkit/*` took 2.4-8.6s on its first hit, worst
  // immediately after a `next build` — which is exactly the sequence this lane
  // runs. Never request `/`: 15-36s cold, and a prior `next build` does not warm
  // the dev compile.
  return await fetch(new URL(path, baseUrl), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  })
}

afterEach(async () => {
  await cleanupTrackedTempDirs(tempDirs)
})

// Proves the anchor before the lane has a second block to disambiguate: the
// `dev:web` line starts with the whole `npm run dev` prefix, so an unanchored
// `lastIndexOf` selects the WRONG block the moment a web child is recorded after
// the server child.
test("anchors the recorded server exit to a whole command line", () => {
  const appRoot = "/tmp/anchored-activation-app"
  const serverBlock = [
    `$ (cd ${appRoot} && npm run dev -- --port 4711)`,
    "dawn dev stdout",
    "[exit 0 signal none]",
    "",
  ]
  const leakedWebBlock = [
    `$ (cd ${appRoot} && npm run dev:web -- --port 4712 -H 127.0.0.1)`,
    "next dev stdout",
    "[exit pending signal pending]",
    "",
  ]

  // A `dev:web` block recorded AFTER the server block must not be mistaken for it.
  const webLast = [...serverBlock, ...leakedWebBlock].join("\n")
  assertRecordedServerExit(webLast, { appRoot, script: "dev" })
  expect(() => assertRecordedServerExit(webLast, { appRoot, script: "dev:web" })).toThrow()

  // And in the order nesting actually produces — inner (web) first, server last —
  // a web block whose own exit line never landed must not borrow the server's.
  const webFirst = [
    `$ (cd ${appRoot} && npm run dev:web -- --port 4712 -H 127.0.0.1)`,
    "next dev stdout",
    "",
    ...serverBlock,
  ].join("\n")
  assertRecordedServerExit(webFirst, { appRoot, script: "dev" })
  expect(() => assertRecordedServerExit(webFirst, { appRoot, script: "dev:web" })).toThrow()
})

test("activates the default research scaffold through the complete npm lifecycle", {
  timeout: ACTIVATION_TIMEOUT_MS,
}, async ({ signal: testSignal }) => {
  const tempRoot = await createTrackedTempDir("dawn-generated-research-activation-", tempDirs)
  const appRoot = join(tempRoot, "app")
  const installerRoot = join(tempRoot, "installer")
  const expectedArtifactRoot = join(
    tempRoot,
    "artifacts/testing/generated-research-activation/research",
  )
  const commandsTranscriptPath = join(expectedArtifactRoot, "transcripts", "commands.log")
  const agUiTranscriptPath = join(expectedArtifactRoot, "transcripts", "ag-ui.json")
  const childServer = {
    active: undefined as { stop(): Promise<void> } | undefined,
  }
  let aimock: Awaited<ReturnType<typeof createAimock>> | undefined
  let scenarioError: unknown
  let scenarioFailed = false
  let cleanupError: unknown
  let lifecycleDeadline: NodeJS.Timeout | undefined
  const inheritedRuntimeEnv = GENERATED_APP_UNSET_ENV.map((name) => ({
    hadOwnProperty: Object.hasOwn(process.env, name),
    name,
    value: Reflect.get(process.env, name),
  }))

  try {
    const lifecycleController = new AbortController()
    lifecycleDeadline = setTimeout(
      () =>
        lifecycleController.abort(
          new Error(
            `Generated research activation reached its command deadline with ${ACTIVATION_CLEANUP_RESERVE_MS}ms reserved for cleanup`,
          ),
        ),
      ACTIVATION_TIMEOUT_MS - ACTIVATION_CLEANUP_RESERVE_MS,
    )
    lifecycleDeadline.unref()
    const lifecycleSignal = AbortSignal.any([testSignal, lifecycleController.signal])

    Reflect.set(process.env, "DAWN_DEMO_DOCKER_SANDBOX", "1")
    Reflect.set(process.env, "OPENAI_BASE_URL", "http://127.0.0.1:1/v1")
    Reflect.set(process.env, "OPENAI_API_KEY", "ambient-secret")

    const artifactRoot = await createArtifactRoot({
      baseDir: tempRoot,
      runId: "generated-research-activation",
      lane: "research",
    })
    expect(artifactRoot).toBe(expectedArtifactRoot)
    await mkdir(dirname(commandsTranscriptPath), { recursive: true })
    await writeFile(agUiTranscriptPath, "", "utf8")

    aimock = await createAimock({ fixtures: [] })
    aimock.addFixtures([
      ...createSafeResearchFixtures(),
      ...createGatedAndBuiltFixtures(),
      ...createWebHopFixtures(),
    ])
    const activeAimock = aimock
    const agUiRecorder = createAgUiTranscriptRecorder({
      aimockUrl: activeAimock.baseUrl,
      path: agUiTranscriptPath,
      tempRoot,
    })

    const npmVersion = await runPackagedNpmCommand({
      args: ["--version"],
      cwd: tempRoot,
      signal: lifecycleSignal,
      transcriptPath: commandsTranscriptPath,
    })
    expect(Number(process.versions.node.split(".")[0])).toBe(24)
    expect(Number(npmVersion.stdout.trim().split(".")[0])).toBe(11)

    const { installerDir } = await installRegistryScaffolderWithNpm({
      signal: lifecycleSignal,
      tempRoot,
      transcriptPath: commandsTranscriptPath,
    })
    expect(installerDir).toBe(installerRoot)
    const creatorResult = await runPackagedNpmCommand({
      args: ["exec", "--", "create-dawn-ai-app", appRoot],
      cwd: installerDir,
      signal: lifecycleSignal,
      transcriptPath: commandsTranscriptPath,
    })

    await expect(
      access(join(appRoot, "server/src/app/research/index.ts"), constants.F_OK),
    ).resolves.toBeUndefined()
    // Proves the RESEARCH template was generated, not the BASIC one: the basic
    // template's marker route must be absent from where the server actually
    // lives. Pointed at `server/` deliberately — asserting against the app root
    // would pass vacuously now that nothing but the orchestrator lives there.
    await expect(
      access(join(appRoot, "server/src/app/(public)/hello/[tenant]/index.ts"), constants.F_OK),
    ).rejects.toThrow()
    // The other half of the workspace: the scaffold ships a web client too.
    await expect(access(join(appRoot, "web/app/page.tsx"), constants.F_OK)).resolves.toBeUndefined()
    expect(creatorResult.stdout).toContain("(research template)")

    const scaffoldTranscript = await readFile(commandsTranscriptPath, "utf8")
    const creatorCommandLines = scaffoldTranscript
      .split("\n")
      .filter((line) => line.startsWith(`$ (cd ${installerDir} && npm exec `))
    expect(creatorCommandLines).toEqual([
      `$ (cd ${installerDir} && npm exec -- create-dawn-ai-app ${appRoot})`,
    ])
    expect(creatorCommandLines[0]?.split(/\s+/)).not.toContain("--template")

    await writeRegistryNpmrc(appRoot, getTestRegistryUrl())
    // The Dawn server lives in `server/`, and its `start` script is
    // `node --env-file-if-exists=.env …` resolved from ITS cwd. A `.env` left at
    // the workspace root is invisible to it: `npm run verify` starts warning
    // about missing environment variables, and the built-artifact journey boots
    // a server that never learns the aimock URL — which surfaces far away, as a
    // request-count mismatch on the aimock journal.
    const envContent = `OPENAI_BASE_URL=${aimock.baseUrl}\nOPENAI_API_KEY=test-not-used\n`
    await writeFile(join(appRoot, "server/.env"), envContent, "utf8")

    await runGeneratedAppNpmCommand({
      args: ["install"],
      cwd: appRoot,
      signal: lifecycleSignal,
      // The workspace install now resolves the web client's dependency set
      // (next, react, CopilotKit, tailwind) on top of the server's, through
      // Verdaccio's npmjs uplink. That overruns the shared per-command budget on
      // a cold registry cache, so this one call carries its own.
      timeoutMs: WORKSPACE_INSTALL_TIMEOUT_MS,
      transcriptPath: commandsTranscriptPath,
    })

    const rootManifest = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as {
      readonly scripts: Record<string, string>
      readonly workspaces: readonly string[]
    }
    const serverManifest = JSON.parse(
      await readFile(join(appRoot, "server/package.json"), "utf8"),
    ) as { readonly name: string; readonly scripts: Record<string, string> }
    const webManifest = JSON.parse(await readFile(join(appRoot, "web/package.json"), "utf8")) as {
      readonly name: string
    }
    expect(rootManifest.workspaces).toEqual(["server", "web"])
    // npm links every workspace member into the root `node_modules`. Following
    // those links is the proof both packages actually installed rather than the
    // web half being skipped as an unreferenced directory.
    for (const workspaceName of [serverManifest.name, webManifest.name]) {
      await expect(
        access(join(appRoot, "node_modules", workspaceName), constants.F_OK),
      ).resolves.toBeUndefined()
    }

    const typegenResult = await runGeneratedAppNpmCommand({
      args: ["run", "typegen"],
      cwd: appRoot,
      signal: lifecycleSignal,
      transcriptPath: commandsTranscriptPath,
    })
    expect(typegenResult.stdout).toContain("Wrote types for")
    const generatedTypesPath = join(appRoot, "server/.dawn/dawn.generated.d.ts")
    await expect(access(generatedTypesPath, constants.F_OK)).resolves.toBeUndefined()
    const generatedTypes = await readFile(generatedTypesPath, "utf8")
    const checkSentinel = "// sentinel: dawn check must not generate types\n"
    await writeFile(generatedTypesPath, checkSentinel, "utf8")

    const checkResult = await runGeneratedAppNpmCommand({
      args: ["run", "check"],
      cwd: appRoot,
      signal: lifecycleSignal,
      transcriptPath: commandsTranscriptPath,
    })
    expect(checkResult.stdout).toContain("Dawn app is valid:")
    expect(checkResult.stdout).not.toContain("Wrote types for")
    await expect(readFile(generatedTypesPath, "utf8")).resolves.toBe(checkSentinel)
    await writeFile(generatedTypesPath, generatedTypes, "utf8")
    await expect(readFile(generatedTypesPath, "utf8")).resolves.toBe(generatedTypes)

    await runGeneratedAppNpmCommand({
      args: ["run", "typecheck"],
      cwd: appRoot,
      signal: lifecycleSignal,
      transcriptPath: commandsTranscriptPath,
    })
    await runGeneratedAppNpmCommand({
      args: ["test"],
      cwd: appRoot,
      signal: lifecycleSignal,
      transcriptPath: commandsTranscriptPath,
    })
    await runGeneratedAppNpmCommand({
      args: ["run", "eval"],
      cwd: appRoot,
      signal: lifecycleSignal,
      transcriptPath: commandsTranscriptPath,
    })
    const verifyResult = await runGeneratedAppNpmCommand({
      args: ["run", "verify"],
      cwd: appRoot,
      signal: lifecycleSignal,
      transcriptPath: commandsTranscriptPath,
    })
    expect(verifyResult.stdout).not.toContain("Missing environment variables")
    // The workspace restructure hoisted every dependency to the root
    // node_modules while appRoot stayed at <app>/server, so verify's package
    // probe warned "Missing packages: @langchain/core, ..." on a fully installed
    // app — and this lane ran green through all of it because nothing asserted
    // on the deps warning. It does now.
    expect(verifyResult.stdout).not.toContain("Missing packages")
    await runGeneratedAppNpmCommand({
      args: ["run", "build"],
      cwd: appRoot,
      signal: lifecycleSignal,
      transcriptPath: commandsTranscriptPath,
    })

    // One root `npm run build` fans out across both workspace members, so both
    // halves must have produced their artifact.
    await expect(
      access(join(appRoot, "server/.dawn/build/server.mjs"), constants.F_OK),
    ).resolves.toBeUndefined()
    await expect(access(join(appRoot, "web/.next"), constants.F_OK)).resolves.toBeUndefined()

    // The root manifest is pure orchestration: every entry delegates into a
    // workspace member. The trailing ` --` on each single-workspace delegator is
    // load-bearing — without it npm swallows the flag NAME out of
    // `npm run dev -- --port 4123` and `dawn dev` hard-errors — which is why the
    // harness can boot these apps at all. `packages/devkit/test/template-root-scripts.test.ts`
    // guards the rule at the template; this pins what a real scaffold produced.
    expect(rootManifest.scripts).toEqual({
      dev: "npm run dev --workspace server --",
      "dev:server": "npm run dev --workspace server --",
      "dev:web": "npm run dev --workspace web --",
      verify: "npm run verify --workspace server --",
      typegen: "npm run typegen --workspace server --",
      check: "npm run check --workspace server --",
      typecheck: "npm run typecheck --workspaces --if-present",
      test: "npm run test --workspaces --if-present",
      eval: "npm run eval --workspace server --",
      build: "npm run build --workspaces --if-present",
      start: "npm start --workspace server --",
      "memory:list": "npm run memory:list --workspace server --",
      "memory:approve": "npm run memory:approve --workspace server --",
    })
    // The delegation targets. Pinned separately so a rename on either side of
    // the hand-off reds here rather than silently going nowhere.
    expect(serverManifest.scripts).toEqual({
      dev: "dawn dev --port 3002",
      verify: "dawn verify",
      typegen: "dawn typegen",
      check: "dawn check",
      typecheck: "tsc --noEmit",
      test: "vitest run",
      eval: "dawn eval",
      build: "dawn build",
      start: "node --env-file-if-exists=.env .dawn/build/server.mjs",
      "test:sandbox:docker": "DAWN_DEMO_DOCKER_SANDBOX=1 vitest run test/sandbox-docker.test.ts",
      "memory:list": "dawn memory list",
      "memory:approve": "dawn memory approve",
    })
    await expect(
      readFile(join(appRoot, "server/src/app/research/index.ts"), "utf8"),
    ).resolves.toContain("recursionLimit: 100")

    const safeThreadId = `safe-thread-${randomUUID()}`
    const safeRunId = `safe-run-${randomUUID()}`
    const safeMessageId = `safe-message-${randomUUID()}`
    const gatedThreadId = `gated-thread-${randomUUID()}`
    const gatedRunId = `gated-run-${randomUUID()}`
    const gatedMessageId = `gated-message-${randomUUID()}`
    const resumeRunId = `resume-run-${randomUUID()}`
    const builtThreadId = `built-thread-${randomUUID()}`
    const builtRunId = `built-run-${randomUUID()}`
    const builtMessageId = `built-message-${randomUUID()}`
    const webThreadId = `web-thread-${randomUUID()}`
    const webRunId = `web-run-${randomUUID()}`
    const webMessageId = `web-message-${randomUUID()}`
    const webGatedThreadId = `web-gated-thread-${randomUUID()}`
    const webGatedRunId = `web-gated-run-${randomUUID()}`
    const webGatedMessageId = `web-gated-message-${randomUUID()}`
    const webResumeRunId = `web-resume-run-${randomUUID()}`
    let devServerUrl: string | undefined
    let webClientUrl: string | undefined
    const devResult = await withPackagedNpmServer(
      {
        appRoot,
        script: "dev",
        signal: lifecycleSignal,
        env: {
          OPENAI_BASE_URL: activeAimock.baseUrl,
          OPENAI_API_KEY: "test-not-used",
        },
        transcriptPath: commandsTranscriptPath,
      },
      async ({ url }) => {
        devServerUrl = url
        agUiRecorder.registerServerUrl(url)
        const safeJourney = await postAgui({
          baseUrl: url,
          messages: [{ id: safeMessageId, role: "user", content: SAFE_PROMPT }],
          recorder: agUiRecorder,
          runId: safeRunId,
          signal: lifecycleSignal,
          threadId: safeThreadId,
        })
        expect(safeJourney.status).toBe(200)
        assertSafeResearchJourney(safeJourney.events, {
          runId: safeRunId,
          threadId: safeThreadId,
        })

        const gatedJournalStart = activeAimock.getRequests().length
        const gatedJourney = await postAgui({
          baseUrl: url,
          messages: [{ id: gatedMessageId, role: "user", content: GATED_PROMPT }],
          recorder: agUiRecorder,
          runId: gatedRunId,
          signal: lifecycleSignal,
          threadId: gatedThreadId,
        })
        expect(gatedJourney.status).toBe(200)
        expect(activeAimock.getRequests()).toHaveLength(gatedJournalStart + 1)
        const { gatedToolCallId, interruptId } = assertGatedResearchInterrupt(gatedJourney.events, {
          runId: gatedRunId,
          threadId: gatedThreadId,
        })

        const resumeJournalStart = activeAimock.getRequests().length
        const resumedJourney = await postAgui({
          baseUrl: url,
          messages: [],
          recorder: agUiRecorder,
          resumeFields: {
            resume: [{ interruptId, status: "resolved", payload: "once" }],
          },
          runId: resumeRunId,
          signal: lifecycleSignal,
          threadId: gatedThreadId,
        })
        expect(resumedJourney.status).toBe(200)
        expect(activeAimock.getRequests()).toHaveLength(resumeJournalStart + 1)
        expect(resumeRunId).not.toBe(gatedRunId)
        assertResumedGatedJourney(
          resumedJourney.events,
          {
            runId: resumeRunId,
            threadId: gatedThreadId,
          },
          gatedToolCallId,
        )

        // The generated web client, against the SAME Dawn server. Nested rather
        // than sequential: the server is already BOUND when the web child
        // allocates its port, and LIFO teardown kills the web half first.
        const webResult = await withPackagedNpmServer(
          {
            appRoot,
            env: {
              DAWN_SERVER_URL: url,
              // Both route handlers read DAWN_SERVER_URL at module scope under
              // `runtime = "nodejs"`, and Next does NOT inline it — the built
              // chunk carries `process.env.DAWN_SERVER_URL??"http://127.0.0.1:3002"`
              // verbatim — so injecting it at spawn is what points this child at
              // this server rather than at that hard-coded default.
              //
              // Without the two below, the CopilotKit runtime prints "anonymous
              // telemetry enabled" and makes an outbound call, in a lane whose
              // whole claim is that a generated app inherits no ambient
              // endpoints or credentials.
              COPILOTKIT_TELEMETRY_DISABLED: "true",
              DO_NOT_TRACK: "1",
            },
            // Next has no `/healthz`, and readying on its stdout is not merely
            // imprecise — it is wrong in a way that HANGS: `Ready in Xms` prints
            // 12-29s before the process can serve, and a request issued at that
            // line blocked 20.7s. A 2xx on the proxy route means the route's
            // whole module graph compiled AND the proxy reached a Dawn server.
            readiness: httpOkReadiness(WEB_READY_PATH),
            script: "dev:web",
            signal: lifecycleSignal,
            transcriptPath: commandsTranscriptPath,
          },
          async ({ url: webUrl }) => {
            webClientUrl = webUrl
            agUiRecorder.registerServerUrl(webUrl)
            expect(new URL(webUrl).port).not.toBe(new URL(url).port)

            const webIdleJournalStart = activeAimock.getRequests().length

            // W1 — the allowlist denies by default in a real Next process.
            const denied = await fetchWeb(webUrl, "/api/dawn/threads", lifecycleSignal)
            expect(denied.status).toBe(403)
            await expect(denied.json()).resolves.toEqual({ error: "Not proxied" })

            // W2 — the proxy reached THIS server. A mis-wired DAWN_SERVER_URL
            // cannot pass: only this server has a checkpoint for the thread the
            // safe journey just drove, so a stray Dawn server on the hard-coded
            // :3002 default answers 404 here while W1 and W3 stay green. Do not
            // weaken the 200 to a "not 502" check — that is the whole assertion.
            const state = await fetchWeb(
              webUrl,
              `/api/dawn/threads/${encodeURIComponent(safeThreadId)}/state`,
              lifecycleSignal,
            )
            expect(state.status).toBe(200)
            const threadState = (await state.json()) as {
              readonly config?: unknown
              readonly values?: unknown
            }
            expect(JSON.stringify(threadState.config)).toContain(safeThreadId)
            expect(JSON.stringify(threadState.values)).toContain("[corpus/agent-architectures.md]")
            // 403 (refused) and 404 (no checkpoint) stay distinguishable, which
            // is the distinction the proxy route argues for — and it is what
            // makes the 200 above evidence rather than coincidence.
            const absent = await fetchWeb(
              webUrl,
              `/api/dawn/threads/${encodeURIComponent(`absent-${randomUUID()}`)}/state`,
              lifecycleSignal,
            )
            expect(absent.status).toBe(404)

            // W3 — the CopilotKit runtime is mounted at the basePath the client
            // uses, under the agent id every hook resolves. Never assert
            // `agents.default.className`: it is MINIFIED and varies by build.
            const info = await fetchWeb(webUrl, "/api/copilotkit/info", lifecycleSignal)
            expect(info.status).toBe(200)
            const infoBody = (await info.json()) as {
              readonly agents?: Record<string, unknown>
              readonly mode?: unknown
              readonly telemetryDisabled?: unknown
            }
            expect(Object.keys(infoBody.agents ?? {})).toContain("default")
            expect(infoBody.mode).toBe("sse")
            expect(infoBody.telemetryDisabled).toBe(true)

            // W6 — the web tier's ONLY path to a model is through Dawn, and only
            // for an actual run. Nothing above may move the journal.
            expect(activeAimock.getRequests()).toHaveLength(webIdleJournalStart)

            // W4 — Next route -> CopilotRuntime -> HttpAgent -> Dawn /agui ->
            // LangGraph -> aimock, and back. The +2 is one tool turn plus one
            // text turn. `assertWebHopJourney` already proves the run reached a
            // model — `WEB_REPLY` exists nowhere but the fixture — so what this
            // adds is the EXACT count: a run the hop invoked twice would land
            // +4 with the same reply text and pass every other assertion here.
            // If it ever disagrees, correct the constant rather than loosening
            // it to a lower bound.
            const webJournalStart = activeAimock.getRequests().length
            const webJourney = await postAgui({
              baseUrl: webUrl,
              endpointPath: COPILOTKIT_RUN_PATH,
              messages: [{ id: webMessageId, role: "user", content: WEB_PROMPT }],
              recorder: agUiRecorder,
              runId: webRunId,
              signal: lifecycleSignal,
              threadId: webThreadId,
            })
            expect(webJourney.status).toBe(200)
            expect(activeAimock.getRequests()).toHaveLength(webJournalStart + 2)
            assertWebHopJourney(webJourney.events)
            // Our thread id survived the hop into Dawn's checkpointer.
            const webState = await fetchWeb(
              webUrl,
              `/api/dawn/threads/${encodeURIComponent(webThreadId)}/state`,
              lifecycleSignal,
            )
            expect(webState.status).toBe(200)

            // W5 — the interrupt outcome and the resume envelope survive the
            // hop. Highest-risk contract in the app; it regressed once.
            const webGatedJournalStart = activeAimock.getRequests().length
            const webGated = await postAgui({
              baseUrl: webUrl,
              endpointPath: COPILOTKIT_RUN_PATH,
              messages: [{ id: webGatedMessageId, role: "user", content: WEB_GATED_PROMPT }],
              recorder: agUiRecorder,
              runId: webGatedRunId,
              signal: lifecycleSignal,
              threadId: webGatedThreadId,
            })
            expect(webGated.status).toBe(200)
            expect(activeAimock.getRequests()).toHaveLength(webGatedJournalStart + 1)
            const webInterrupt = assertWebGatedInterrupt(webGated.events)

            const webResumeJournalStart = activeAimock.getRequests().length
            const webResumed = await postAgui({
              baseUrl: webUrl,
              endpointPath: COPILOTKIT_RUN_PATH,
              messages: [],
              recorder: agUiRecorder,
              resumeFields: {
                resume: [
                  { interruptId: webInterrupt.interruptId, status: "resolved", payload: "once" },
                ],
              },
              runId: webResumeRunId,
              signal: lifecycleSignal,
              threadId: webGatedThreadId,
            })
            expect(webResumed.status).toBe(200)
            expect(activeAimock.getRequests()).toHaveLength(webResumeJournalStart + 1)
            expect(webResumeRunId).not.toBe(webGatedRunId)
            assertWebResumedJourney(webResumed.events, webInterrupt.gatedToolCallId)

            return { webInterruptId: webInterrupt.interruptId }
          },
        )
        return { interruptId, ...webResult }
      },
    )
    if (devServerUrl === undefined) throw new Error("Generated dev server did not start")
    if (webClientUrl === undefined) throw new Error("Generated web client did not start")

    const transcriptAfterDev = await readFile(commandsTranscriptPath, "utf8")
    assertRecordedServerExit(transcriptAfterDev, { appRoot, script: "dev" })
    // W6, second half — the SECOND child dies too, and its own block says so.
    assertRecordedServerExit(transcriptAfterDev, { appRoot, script: "dev:web" })
    // A leak canary, not a proof of the strip. It says only that nothing echoed
    // the ambient key into a transcript this lane preserves and CI uploads —
    // which holds largely because the web tier has no model path except through
    // Dawn, so there is little to echo it. Breaking `GENERATED_APP_UNSET_ENV`
    // for `dev:web` leaves this green; the assertion that actually fails is
    // `observed.runtimeEnv` in `test/harness/packaged-app.test.ts:1114`. Kept
    // anyway: it is nearly free and mirrors the same sweep over the AG-UI
    // transcript below.
    expect(transcriptAfterDev).not.toContain("ambient-secret")
    expect(transcriptAfterDev).not.toContain(`$ (cd ${appRoot} && npm run start`)

    let builtServerUrl: string | undefined
    const builtJourney = await withPackagedNpmServer(
      {
        appRoot,
        script: "start",
        signal: lifecycleSignal,
        env: { HOST: "127.0.0.1" },
        unsetEnv: ["OPENAI_BASE_URL", "OPENAI_API_KEY"],
        transcriptPath: commandsTranscriptPath,
      },
      async ({ url }) => {
        builtServerUrl = url
        agUiRecorder.registerServerUrl(url)
        await assertReadyHealth(url, lifecycleSignal)

        const builtJournalStart = activeAimock.getRequests().length
        const journey = await postAgui({
          baseUrl: url,
          messages: [{ id: builtMessageId, role: "user", content: BUILT_PROMPT }],
          recorder: agUiRecorder,
          runId: builtRunId,
          signal: lifecycleSignal,
          threadId: builtThreadId,
        })
        expect(activeAimock.getRequests()).toHaveLength(builtJournalStart + 1)
        return journey
      },
    )
    if (builtServerUrl === undefined) throw new Error("Generated built server did not start")
    expect(builtJourney.status).toBe(200)
    assertBuiltArtifactJourney(builtJourney.events, {
      runId: builtRunId,
      threadId: builtThreadId,
    })

    const transcriptAfterStart = await readFile(commandsTranscriptPath, "utf8")
    assertRecordedServerExit(transcriptAfterStart, { appRoot, script: "start" })
    const reportPath = join(appRoot, "server/workspace/reports/agent-architectures.md")
    await expect(access(reportPath, constants.F_OK)).resolves.toBeUndefined()
    await expect(readFile(reportPath, "utf8")).resolves.toContain("[corpus/agent-architectures.md]")

    const sanitizedAgUiTranscript = await readFile(agUiTranscriptPath, "utf8")
    expect(() => JSON.parse(sanitizedAgUiTranscript)).not.toThrow()
    expect(sanitizedAgUiTranscript).toContain("<temp-root>")
    expect(sanitizedAgUiTranscript).toContain("<server-url-1>")
    // The web client registers second, so the built server takes the third slot.
    expect(sanitizedAgUiTranscript).toContain("<server-url-2>")
    if (builtServerUrl !== devServerUrl && builtServerUrl !== webClientUrl) {
      expect(sanitizedAgUiTranscript).toContain("<server-url-3>")
    }
    expect(sanitizedAgUiTranscript).toContain("<aimock-url>")
    expect(sanitizedAgUiTranscript).toContain("<aimock-origin>")
    expect(sanitizedAgUiTranscript).toContain("<thread-1>")
    expect(sanitizedAgUiTranscript).toContain("<run-1>")
    expect(sanitizedAgUiTranscript).toContain("<message-1>")
    expect(sanitizedAgUiTranscript).toContain("<tool-call-1>")
    expect(sanitizedAgUiTranscript).toContain("<interrupt-1>")
    for (const unsanitized of [
      tempRoot,
      `/private${tempRoot}`,
      devServerUrl,
      webClientUrl,
      builtServerUrl,
      activeAimock.baseUrl,
      new URL(activeAimock.baseUrl).origin,
      safeThreadId,
      safeRunId,
      safeMessageId,
      gatedThreadId,
      gatedRunId,
      gatedMessageId,
      resumeRunId,
      devResult.interruptId,
      builtThreadId,
      builtRunId,
      builtMessageId,
      webThreadId,
      webRunId,
      webMessageId,
      webGatedThreadId,
      webGatedRunId,
      webGatedMessageId,
      webResumeRunId,
      devResult.webInterruptId,
      "test-not-used",
      "ambient-secret",
    ]) {
      expect(sanitizedAgUiTranscript).not.toContain(unsanitized)
    }
    expect(sanitizedAgUiTranscript).not.toContain("OPENAI_API_KEY")
    expect(sanitizedAgUiTranscript).not.toContain("OPENAI_BASE_URL")
  } catch (error) {
    scenarioFailed = true
    scenarioError = error
  } finally {
    if (lifecycleDeadline !== undefined) clearTimeout(lifecycleDeadline)
    const cleanupErrors: unknown[] = []
    try {
      await childServer.active?.stop()
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await aimock?.close()
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0) {
      cleanupError =
        cleanupErrors.length === 1
          ? cleanupErrors[0]
          : new AggregateError(cleanupErrors, "Generated research activation cleanup failed")
    }
    for (const inherited of inheritedRuntimeEnv) {
      if (inherited.hadOwnProperty) {
        Reflect.set(process.env, inherited.name, inherited.value)
      } else {
        Reflect.deleteProperty(process.env, inherited.name)
      }
    }
  }

  if (scenarioFailed || cleanupError !== undefined) {
    markTrackedTempDirForPreserve(tempDirs, tempRoot)
    const cause =
      scenarioFailed && cleanupError !== undefined
        ? new AggregateError(
            [scenarioError, cleanupError],
            "Generated research activation and cleanup both failed",
          )
        : scenarioFailed
          ? scenarioError
          : cleanupError
    throw new Error(
      [
        "Generated research activation failed; preserved its temporary root.",
        `App root: ${appRoot}`,
        `Commands transcript: ${commandsTranscriptPath}`,
        `AG-UI transcript: ${agUiTranscriptPath}`,
      ].join("\n"),
      { cause },
    )
  }
})
