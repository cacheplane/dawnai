import { createServer, type Server } from "node:http"
import { HttpAgent, verifyEvents } from "@ag-ui/client"
import { EventType, type RunAgentInput } from "@ag-ui/core"
import { lastValueFrom, toArray } from "rxjs"
import { afterEach, expect, it } from "vitest"
import { createCounterIdFactory } from "../src/ids.js"
import { toAguiEvents } from "../src/outbound.js"
import { encodeAgUiSse } from "../src/sse.js"
import type { DawnAgentStreamChunk } from "../src/types.js"

let server: Server | undefined
afterEach(async () => {
  const currentServer = server
  server = undefined
  if (!currentServer) return
  await new Promise<void>((resolve, reject) => {
    currentServer.close((error) => (error ? reject(error) : resolve()))
  })
})

const CANNED: DawnAgentStreamChunk[] = [
  { type: "token", data: "Researching" },
  { type: "tool_call", data: { name: "searchCorpus", input: { query: "agents" } } },
  {
    type: "tool_result",
    data: { name: "searchCorpus", output: [{ path: "corpus/a.md" }] },
  },
  { type: "plan_update", data: { todos: [{ content: "search", status: "completed" }] } },
  { type: "subagent.start", data: { call_id: "c1", subagent: "researcher" } },
  { type: "token", data: " done. [corpus/a.md]" },
  { type: "done", data: { messages: [] } },
]

async function* toAsync(items: readonly DawnAgentStreamChunk[]) {
  yield* items
}

async function startCannedServer(): Promise<string> {
  const cannedServer = createServer((req, res) => {
    void (async () => {
      req.resume()
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      const events = toAguiEvents(
        toAsync(CANNED),
        { threadId: "t1", runId: "r1" },
        { idFactory: createCounterIdFactory() },
      )
      for await (const event of events) res.write(encodeAgUiSse(event))
      res.end()
    })().catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    cannedServer.once("error", onError)
    cannedServer.listen(0, "127.0.0.1", () => {
      cannedServer.off("error", onError)
      resolve()
    })
  })
  server = cannedServer
  const address = cannedServer.address()
  if (!address || typeof address === "string") throw new Error("Canned server has no TCP address")
  const { port } = address
  return `http://127.0.0.1:${port}`
}

it("produces an AG-UI stream that @ag-ui/client parses and verifyEvents accepts", async () => {
  const url = await startCannedServer()
  const agent = new HttpAgent({ url })
  const input = {
    threadId: "t1",
    runId: "r1",
    state: {},
    messages: [{ id: "1", role: "user", content: "research agents" }],
    tools: [],
    context: [],
    forwardedProps: {},
  } satisfies RunAgentInput
  const events = await lastValueFrom(agent.run(input).pipe(verifyEvents(false), toArray()))
  const kinds = events.map((e) => e.type)
  expect(kinds[0]).toBe(EventType.RUN_STARTED)
  expect(kinds).toContain(EventType.TOOL_CALL_START)
  expect(kinds).toContain(EventType.TOOL_CALL_RESULT)
  expect(kinds).not.toContain(EventType.STATE_SNAPSHOT)
  expect(kinds).not.toContain(EventType.CUSTOM)
  expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED)
})
