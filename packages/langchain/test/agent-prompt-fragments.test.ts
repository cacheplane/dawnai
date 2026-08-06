import { HumanMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import { composePromptMessages } from "../src/agent-adapter.js"

describe("agent prompt fragments", () => {
  it("awaits async fragments without dropping state messages", async () => {
    const messages = [new HumanMessage("Read the skill, then update AGENTS.md.")]
    const rendered = await composePromptMessages(
      "Base system prompt.",
      [
        {
          placement: "after_user_prompt",
          render: async (state) => `Current plan: ${String(state.todos ?? "(empty)")}`,
        },
      ],
      { messages, todos: "(empty)" },
    )

    expect(rendered).toHaveLength(2)
    expect(rendered[0]).toEqual({
      role: "system",
      content: "Base system prompt.\n\nCurrent plan: (empty)",
    })
    expect(rendered[1]).toBe(messages[0])
  })
})
