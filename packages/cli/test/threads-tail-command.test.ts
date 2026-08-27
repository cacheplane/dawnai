/**
 * Integration coverage for `dawn threads tail` against a REAL bound Dawn
 * server (`startRuntimeServer`), not the in-process fetch handler the unit
 * suites use. This is the only suite that drives the command's own `fetch`
 * call over an actual socket.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { script } from "../../testing/dist/fixture-builder.js"
import { runThreadsCommand } from "../src/commands/threads.js"
import { startRuntimeServer } from "../src/lib/dev/runtime-server.js"
import { CliError, type CommandIo } from "../src/lib/output.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** Agent route with no gating: every tool it discovers under `tools/` runs
 * immediately. Agent routes checkpoint (plain graph routes never do), which
 * is what gives a blocking tool a real turn to hold open. */
const CHAT_ROUTE = [
  'import { agent } from "@dawn-ai/sdk"',
  "export default agent({",
  '  model: "gpt-5-mini",',
  '  systemPrompt: "You are a test agent. Use the provided tools when asked.",',
  "})",
  "",
].join("\n")

/** Ungated tool that blocks until a release file appears, so a live turn can
 * be held open deterministically. */
const SLOW_PING_TOOL = [
  'import { readFile, writeFile } from "node:fs/promises"',
  "/** Ping a host, slowly. */",
  "export default async function slowPing(input: {",
  "  startedFile: string",
  "  releaseFile: string",
  "}): Promise<string> {",
  "  await writeFile(input.startedFile, 'started')",
  "  const deadline = Date.now() + 15000",
  "  while (Date.now() < deadline) {",
  "    try { await readFile(input.releaseFile, 'utf8'); break } catch {}",
  "    await new Promise((r) => setTimeout(r, 25))",
  "  }",
  "  return 'pong'",
  "}",
  "",
].join("\n")

/** Blanket middleware: allows only requests carrying `x-allow`. */
const ECHO_MIDDLEWARE = [
  'import { allow, defineMiddleware, reject } from "@dawn-ai/sdk"',
  "export default defineMiddleware((req) =>",
  '  req.headers["x-allow"] ? allow() : reject(403, { method: req.method, routeId: req.routeId }),',
  ")",
  "",
].join("\n")

async function fixtureApp(overrides: Record<string, string> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-threads-tail-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "threads-tail-fixture", "type": "module" }\n',
    "src/app/echo/index.ts": ["export const graph = async () => ({ ok: true })", ""].join("\n"),
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/** Point OPENAI_BASE_URL/OPENAI_API_KEY at a local aimock for this test,
 * restoring the previous env afterward. Call BEFORE starting the server. */
async function withAimock(fixtures: ReturnType<ReturnType<typeof script>["build"]>): Promise<void> {
  const aimock = await createAimock({ fixtures: [] })
  cleanup.push(() => aimock.close())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  cleanup.push(() => {
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  })
  aimock.addFixtures(fixtures)
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<string> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await readFile(path, "utf8")
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(`probe file never appeared: ${path}`)
}

async function createServer(appRoot: string) {
  const server = await startRuntimeServer({ appRoot })
  cleanup.push(() => server.close())
  return server
}

function collectIo(): { io: CommandIo; lines: () => string[] } {
  const chunks: string[] = []
  const io: CommandIo = {
    stderr: (message: string) => {
      chunks.push(message)
    },
    stdout: (message: string) => {
      chunks.push(message)
    },
  }
  return {
    io,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0),
  }
}

async function postRunStream(
  baseUrl: string,
  threadId: string,
  route: string,
  input: unknown = {},
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${baseUrl}/threads/${threadId}/runs/stream`, {
    body: JSON.stringify({ input, route }),
    headers: { "content-type": "application/json", ...extraHeaders },
    method: "POST",
  })
}

async function postChatRun(baseUrl: string, threadId: string, message: string): Promise<Response> {
  return await postRunStream(baseUrl, threadId, "/chat#agent", {
    messages: [{ content: message, role: "user" }],
  })
}

async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
}

describe("dawn threads tail — integration against a real bound server", () => {
  it("renders the committed transcript for a thread with no live turn (durable path) and resolves", async () => {
    const appRoot = await fixtureApp()
    const server = await createServer(appRoot)
    const threadId = "t-durable"

    await drain(await postRunStream(server.url, threadId, "/echo#graph"))

    const { io, lines } = collectIo()
    await runThreadsCommand("tail", [threadId], { url: server.url }, io)

    const output = lines()
    expect(output.some((line) => line.includes("status: idle"))).toBe(true)
    expect(output.some((line) => line.includes("live: false"))).toBe(true)
  })

  it("tails a live turn: snapshot shows live:true, then a live tool_result and terminal done follow release", async () => {
    const appRoot = await fixtureApp({
      "src/app/chat/index.ts": CHAT_ROUTE,
      "src/app/chat/tools/slowPing.ts": SLOW_PING_TOOL,
    })
    const startedFile = join(appRoot, "started.json")
    const releaseFile = join(appRoot, "release.json")
    await withAimock(
      script()
        .user("hi")
        .replies("hi there")
        .user("run it")
        .callsTool("slowPing", { startedFile, releaseFile })
        .replies("done")
        .build(),
    )
    const server = await createServer(appRoot)
    const threadId = "t-live"

    // Warm-up turn to completion: creates the thread row AND establishes
    // the checkpoint that becomes the blocking turn's anchor.
    await drain(await postChatRun(server.url, threadId, "hi"))

    const runPromise = postChatRun(server.url, threadId, "run it")
    await waitForFile(startedFile)

    const { io, lines } = collectIo()
    const tailPromise = runThreadsCommand("tail", [threadId], { url: server.url }, io)

    // Give the tail a moment to render the initial snapshot before we
    // release the barrier, so the assertions below can distinguish
    // "snapshot rendered" output from "post-release" output.
    await waitForOutput(lines, (output) => output.some((line) => line.includes("live: true")))
    const snapshotOutput = [...lines()]
    expect(snapshotOutput.some((line) => line.includes("live: true"))).toBe(true)

    await writeFile(releaseFile, "release")

    await tailPromise
    const finalOutput = lines()
    expect(
      finalOutput.some((line) => line.includes("[tool_result]") && line.includes("slowPing")),
    ).toBe(true)
    expect(finalOutput.some((line) => line.includes("[done]"))).toBe(true)

    await drain(await runPromise)
  }, 60_000)

  it("throws a CliError(2) naming the thread id for an unknown thread", async () => {
    const appRoot = await fixtureApp()
    const server = await createServer(appRoot)
    const { io } = collectIo()

    let caught: unknown
    try {
      await runThreadsCommand("tail", ["nope"], { url: server.url }, io)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CliError)
    expect((caught as CliError).exitCode).toBe(2)
    expect((caught as CliError).message).toContain("nope")
  })

  it("explains that a thread which has never run cannot be tailed (409)", async () => {
    const appRoot = await fixtureApp()
    const server = await createServer(appRoot)
    const { io } = collectIo()

    // A bare row with no route identity: created, never run. The server answers
    // 409 `thread_route_unknown`, whose code lives at `error.details.code` —
    // reading it off the top level silently misses it and degrades this to the
    // generic transport error.
    const created = await fetch(new URL("/threads", server.url), {
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    const { thread_id: threadId } = (await created.json()) as { thread_id: string }

    let caught: unknown
    try {
      await runThreadsCommand("tail", [threadId], { url: server.url }, io)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CliError)
    expect((caught as CliError).exitCode).toBe(2)
    // The FRIENDLY message, not the generic fallback: this phrase exists only
    // in the client's own 409 branch, so it fails if the code lookup misses.
    expect((caught as CliError).message).toContain("there is nothing to tail")
    expect((caught as CliError).message).not.toContain('{"error"')
  })

  it("is gated by middleware: fails without --header, succeeds with it", async () => {
    const appRoot = await fixtureApp({ "src/middleware.ts": ECHO_MIDDLEWARE })
    const server = await createServer(appRoot)
    const threadId = "t-gated"

    // Seed the thread with an allowed run.
    const seeded = await postRunStream(server.url, threadId, "/echo#graph", {}, { "x-allow": "1" })
    expect(seeded.status).toBe(200)
    await drain(seeded)

    const { io: rejectedIo } = collectIo()
    let caught: unknown
    try {
      await runThreadsCommand("tail", [threadId], { url: server.url }, rejectedIo)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CliError)
    expect((caught as CliError).exitCode).toBe(2)

    const { io: allowedIo, lines } = collectIo()
    await runThreadsCommand(
      "tail",
      [threadId],
      { header: ["x-allow: 1"], url: server.url },
      allowedIo,
    )
    expect(lines().some((line) => line.includes("status: idle"))).toBe(true)
  })
})

/** Poll `lines()` until `predicate` is satisfied, without sleeping blindly —
 * used only to observe the tail command's own captured output growing, not
 * to synchronize against server-side state. */
async function waitForOutput(
  lines: () => string[],
  predicate: (output: string[]) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate(lines())) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("timed out waiting for tail command output")
}
