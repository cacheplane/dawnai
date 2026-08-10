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
  installRegistryScaffolderWithNpm,
  markTrackedTempDirForPreserve,
  runGeneratedAppNpmCommand,
  runPackagedNpmCommand,
  type TrackedTempDir,
  withPackagedNpmServer,
} from "../harness/packaged-app.ts"
import { writeRegistryNpmrc } from "../harness/scaffold-packaging.ts"

const tempDirs: TrackedTempDir[] = []
const ACTIVATION_TIMEOUT_MS = 600_000
const ACTIVATION_CLEANUP_RESERVE_MS = 30_000
const SAFE_PROMPT = "What are common agent architectures? Write a short cited report."
const SUBQUESTION = "Identify common agent architectures and cite the corpus."
const GATED_PROMPT =
  "The corpus has nothing on quantum computing — run the external fetch script for it with runBash."
const FETCH_COMMAND = "node scripts/fetch-source.mjs quantum computing"
const BUILT_PROMPT = "Built artifact environment smoke."
const GATED_REPLY = "Fetched external context after approval."
const BUILT_REPLY = "built-env-smoke-ok"
const FETCH_STDOUT =
  'No external source configured for "quantum computing". Edit workspace/scripts/fetch-source.mjs to fetch real content.\n'
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
    .replies(
      "ReAct and plan-and-execute are common agent architectures. [corpus/agent-architectures.md]",
    )
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

function correlateRootToolCalls(events: readonly AgUiEvent[]): Map<string, unknown> {
  const toolEvents = events.filter((event) =>
    ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"].includes(
      String(event.type),
    ),
  )
  const starts = events.flatMap((event, index) =>
    event.type === "TOOL_CALL_START" ? [{ event, index }] : [],
  )
  expect(starts.map(({ event }) => event.toolCallName)).toEqual([
    "recall",
    "writeTodos",
    "task",
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
  const endpoint = new URL(`/agui/${routeKey}`, options.baseUrl)
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
  expect(parsedArgsByName.get("task")).toEqual({
    subagent: "researcher",
    input: SUBQUESTION,
  })
  expect(reconstructAssistantText(events)).toContain("[corpus/agent-architectures.md]")
}

function assertGatedResearchInterrupt(
  events: readonly AgUiEvent[],
  ids: { readonly runId: string; readonly threadId: string },
): { readonly interruptId: string } {
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
  const outerArgs = JSON.parse(encodedArgs) as { readonly input?: unknown }
  expect(Object.keys(outerArgs)).toEqual(["input"])
  expect(typeof outerArgs.input).toBe("string")
  expect(JSON.parse(String(outerArgs.input))).toEqual({ command: FETCH_COMMAND })
  expect(events.filter((event) => event.type === "TOOL_CALL_RESULT")).toEqual([])
  expect(
    events.filter(
      (event) => event.type === "TOOL_CALL_START" && event.toolCallName === "writeFile",
    ),
  ).toEqual([])
  expect(events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT")).toEqual([])

  return { interruptId }
}

function assertResumedGatedJourney(
  events: readonly AgUiEvent[],
  ids: { readonly runId: string; readonly threadId: string },
): void {
  assertSuccessfulTerminal(events, ids)

  const starts = events.filter((event) => event.type === "TOOL_CALL_START")
  expect(starts.map((event) => event.toolCallName)).toEqual(["runBash"])
  const toolCallId = starts[0]?.toolCallId
  if (typeof toolCallId !== "string") {
    throw new Error("Resumed runBash start omitted its tool-call id")
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
}

function assertBuiltArtifactJourney(
  events: readonly AgUiEvent[],
  ids: { readonly runId: string; readonly threadId: string },
): void {
  assertSuccessfulTerminal(events, ids)
  expect(events.filter((event) => event.type === "TOOL_CALL_START")).toEqual([])
  expect(reconstructAssistantText(events)).toBe(BUILT_REPLY)
}

function assertRecordedServerExit(
  transcript: string,
  options: { readonly appRoot: string; readonly script: "dev" | "start" },
): void {
  const commandPrefix = `$ (cd ${options.appRoot} && npm run ${options.script}`
  const commandIndex = transcript.lastIndexOf(commandPrefix)
  expect(commandIndex).toBeGreaterThanOrEqual(0)
  if (commandIndex < 0) throw new Error(`Missing ${options.script} server transcript`)
  const commandBlock = transcript.slice(commandIndex)
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

afterEach(async () => {
  await cleanupTrackedTempDirs(tempDirs)
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
    aimock.addFixtures([...createSafeResearchFixtures(), ...createGatedAndBuiltFixtures()])
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
      access(join(appRoot, "src/app/research/index.ts"), constants.F_OK),
    ).resolves.toBeUndefined()
    await expect(
      access(join(appRoot, "src/app/(public)/hello/[tenant]/index.ts"), constants.F_OK),
    ).rejects.toThrow()
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
    const envContent = `OPENAI_BASE_URL=${aimock.baseUrl}\nOPENAI_API_KEY=test-not-used\n`
    await writeFile(join(appRoot, ".env"), envContent, "utf8")

    await runGeneratedAppNpmCommand({
      args: ["install"],
      cwd: appRoot,
      signal: lifecycleSignal,
      transcriptPath: commandsTranscriptPath,
    })
    const typegenResult = await runGeneratedAppNpmCommand({
      args: ["run", "typegen"],
      cwd: appRoot,
      signal: lifecycleSignal,
      transcriptPath: commandsTranscriptPath,
    })
    expect(typegenResult.stdout).toContain("Wrote types for")
    const generatedTypesPath = join(appRoot, ".dawn/dawn.generated.d.ts")
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
    await runGeneratedAppNpmCommand({
      args: ["run", "build"],
      cwd: appRoot,
      signal: lifecycleSignal,
      transcriptPath: commandsTranscriptPath,
    })

    await expect(
      access(join(appRoot, ".dawn/build/server.mjs"), constants.F_OK),
    ).resolves.toBeUndefined()
    const packageManifest = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    expect(packageManifest.scripts).toEqual({
      dev: "dawn dev --port 3000",
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
    await expect(readFile(join(appRoot, "src/app/research/index.ts"), "utf8")).resolves.toContain(
      "recursionLimit: 100",
    )

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
    let devServerUrl: string | undefined
    const devResult = await withPackagedNpmServer(
      {
        appRoot,
        script: "dev",
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
        const { interruptId } = assertGatedResearchInterrupt(gatedJourney.events, {
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
        assertResumedGatedJourney(resumedJourney.events, {
          runId: resumeRunId,
          threadId: gatedThreadId,
        })
        return { interruptId }
      },
    )
    if (devServerUrl === undefined) throw new Error("Generated dev server did not start")

    const transcriptAfterDev = await readFile(commandsTranscriptPath, "utf8")
    assertRecordedServerExit(transcriptAfterDev, { appRoot, script: "dev" })
    expect(transcriptAfterDev).not.toContain(`$ (cd ${appRoot} && npm run start`)

    let builtServerUrl: string | undefined
    const builtJourney = await withPackagedNpmServer(
      {
        appRoot,
        script: "start",
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
    const reportPath = join(appRoot, "workspace/reports/agent-architectures.md")
    await expect(access(reportPath, constants.F_OK)).resolves.toBeUndefined()
    await expect(readFile(reportPath, "utf8")).resolves.toContain("[corpus/agent-architectures.md]")

    const sanitizedAgUiTranscript = await readFile(agUiTranscriptPath, "utf8")
    expect(() => JSON.parse(sanitizedAgUiTranscript)).not.toThrow()
    expect(sanitizedAgUiTranscript).toContain("<temp-root>")
    expect(sanitizedAgUiTranscript).toContain("<server-url-1>")
    if (builtServerUrl !== devServerUrl) {
      expect(sanitizedAgUiTranscript).toContain("<server-url-2>")
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
      "call_recall_0_0",
      "call_writeTodos_0_1",
      "call_task_0_2",
      "call_searchCorpus_0_3",
      "call_readDoc_0_4",
      "call_writeFile_0_5",
      "call_runBash_0_0",
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
