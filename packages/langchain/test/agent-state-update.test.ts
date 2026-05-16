/**
 * Full agent-loop test with a mocked LLM: verify that when a tool returns
 * `{result, state}`, the state channel actually updates after one turn.
 *
 * This catches the regression that live LLM testing surfaced: the
 * tool-converter constructs the Command correctly (covered in unit tests),
 * but if the agent loop / state schema isn't wired right, the Command's
 * `update.todos` never lands on the channel and `state.todos` stays
 * at its default.
 *
 * Uses a hand-rolled SequencedChatModel because @langchain/core's
 * FakeStreamingChatModel doesn't preserve tool_calls when passed via
 * `responses` (it only reads tool_calls from `chunks`).
 */

import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { createReactAgent } from "@langchain/langgraph/prebuilt"
import { describe, expect, it } from "vitest"
import { materializeStateSchema } from "../src/state-adapter.js"
import { convertToolToLangChain } from "../src/tool-converter.js"

/**
 * Minimal sequenced chat model: returns canned AIMessages in order on each
 * call. Preserves tool_calls. Implements bindTools() as a no-op so
 * createReactAgent accepts it.
 */
class SequencedChatModel extends BaseChatModel {
  private cursor = 0
  constructor(private readonly responses: AIMessage[]) {
    super({})
  }
  _llmType(): string {
    return "sequenced-fake"
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const msg = this.responses[this.cursor]
    this.cursor += 1
    if (!msg) throw new Error("SequencedChatModel ran out of canned responses")
    return {
      generations: [{ text: typeof msg.content === "string" ? msg.content : "", message: msg }],
    }
  }
  // biome-ignore lint/suspicious/noExplicitAny: bindTools signature in the BaseChatModel hierarchy is loose
  bindTools(_tools: any): any {
    return this
  }
}

describe("agent loop — state channel updates after Command-returning tool", () => {
  it("applies tool's {result, state} update to the named state channel", async () => {
    const fakeModel = new SequencedChatModel([
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call_test_1",
            name: "write_todos",
            args: { todos: [{ content: "first", status: "in_progress" }] },
            type: "tool_call",
          },
        ],
      }),
      new AIMessage({ content: "Done." }),
    ])

    const writeTodosTool = {
      name: "write_todos",
      description: "Write todos to state",
      run: (input: unknown) => {
        const validated = (input as { todos: Array<{ content: string; status: string }> }).todos
        return {
          result: { todos: validated },
          state: { todos: validated },
        }
      },
    }
    const converted = convertToolToLangChain(writeTodosTool)

    const stateSchema = materializeStateSchema([{ name: "todos", reducer: "replace", default: [] }])

    // biome-ignore lint/suspicious/noExplicitAny: dynamically-built options
    const agent = createReactAgent({
      llm: fakeModel,
      tools: [converted],
      stateSchema,
    } as any)

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Make a plan." }],
    })

    const finalState = result as { todos?: Array<{ content: string; status: string }> }
    expect(finalState.todos).toEqual([{ content: "first", status: "in_progress" }])
  })
})
