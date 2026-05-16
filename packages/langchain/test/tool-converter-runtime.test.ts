/**
 * Runtime integration tests for convertToolToLangChain — verify that the
 * full ToolNode-style invocation path (tool.invoke(ToolCall, config))
 * produces a Command whose embedded ToolMessage has the right tool_call_id.
 *
 * The unit tests in tool-converter.test.ts cover the direct func() invocation
 * path; this file covers the actual call path that LangGraph's ToolNode uses,
 * which is where the tool_call_id resolution actually happens.
 */
import { isCommand } from "@langchain/langgraph"
import { describe, expect, it } from "vitest"
import { convertToolToLangChain } from "../src/tool-converter.js"

describe("convertToolToLangChain — runtime invoke path (ToolNode-style)", () => {
  it("preserves tool_call_id when invoked via tool.invoke(ToolCall) for plain-result tools", async () => {
    const tool = {
      name: "echo",
      description: "Echo input.",
      run: async (input: unknown) => input,
    }
    const converted = convertToolToLangChain(tool)
    const toolCall = {
      type: "tool_call" as const,
      id: "call_abc123",
      name: "echo",
      args: { msg: "hi" },
    }
    const result = await converted.invoke(toolCall)
    // Plain return path → _formatToolOutput wraps as ToolMessage with the id
    expect((result as { tool_call_id?: string }).tool_call_id).toBe("call_abc123")
  })

  it("preserves tool_call_id in Command's embedded ToolMessage when state is present", async () => {
    const tool = {
      name: "writeStuff",
      description: "Write stuff to state.",
      run: async () => ({
        result: { ok: true },
        state: { stuff: "value" },
      }),
    }
    const converted = convertToolToLangChain(tool)
    const toolCall = {
      type: "tool_call" as const,
      id: "call_xyz789",
      name: "writeStuff",
      args: {},
    }
    const result = await converted.invoke(toolCall)

    // Our func returns a Command (lc_direct_tool_output=true), so _formatToolOutput
    // returns it as-is. The Command's embedded ToolMessage in update.messages
    // should have the right tool_call_id for LangGraph to pair with the AIMessage's tool_call.
    expect(isCommand(result)).toBe(true)
    const cmd = result as unknown as {
      update: { messages?: Array<{ tool_call_id?: string; content?: unknown }> }
    }
    const msg = cmd.update.messages?.[0]
    expect(msg?.tool_call_id).toBe("call_xyz789")
    expect(msg?.content).toBe(JSON.stringify({ ok: true }))
    expect((cmd.update as Record<string, unknown>).stuff).toBe("value")
  })
})
