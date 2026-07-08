import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { HttpAgent, verifyEvents } from "@ag-ui/client"
import { EventType } from "@ag-ui/core"
import { lastValueFrom, toArray } from "rxjs"
import { afterEach, expect, it } from "vitest"
import { encodeAgUiSse } from "../src/encode.js"
import { createAgUiTranslator } from "../src/translate.js"
import type { DawnStreamChunk } from "../src/types.js"

let server: Server | undefined
afterEach(() => server?.close())

const CANNED: DawnStreamChunk[] = [
  { type: "token", data: "Researching" },
  { type: "tool_call", name: "searchCorpus", input: { query: "agents" } },
  { type: "tool_result", name: "searchCorpus", output: [{ path: "corpus/a.md" }] },
  { type: "plan_update", data: { todos: [{ content: "search", status: "completed" }] } },
  { type: "subagent.start", data: { call_id: "c1", subagent: "researcher" } },
  { type: "token", data: " done. [corpus/a.md]" },
  { type: "done", output: { messages: [] } },
]

async function startCannedServer(): Promise<string> {
  server = createServer((req, res) => {
    req.resume()
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const t = createAgUiTranslator({ threadId: "t1", runId: "r1" })
    for (const e of t.begin()) res.write(encodeAgUiSse(e))
    for (const chunk of CANNED) for (const e of t.translate(chunk)) res.write(encodeAgUiSse(e))
    for (const e of t.end()) res.write(encodeAgUiSse(e))
    res.end()
  })
  await new Promise<void>((resolve) => {
    // biome-ignore lint/style/noNonNullAssertion: assigned above, listen callback is sync-scheduled
    server!.listen(0, "127.0.0.1", resolve)
  })
  // biome-ignore lint/style/noNonNullAssertion: assigned above
  const { port } = server!.address() as AddressInfo
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
  }
  const events = await lastValueFrom(agent.run(input as never).pipe(verifyEvents(false), toArray()))
  const kinds = events.map((e) => e.type)
  expect(kinds[0]).toBe(EventType.RUN_STARTED)
  expect(kinds).toContain(EventType.TOOL_CALL_START)
  expect(kinds).toContain(EventType.TOOL_CALL_RESULT)
  expect(kinds).toContain(EventType.STATE_SNAPSHOT)
  expect(kinds).toContain(EventType.CUSTOM)
  expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED)
})
