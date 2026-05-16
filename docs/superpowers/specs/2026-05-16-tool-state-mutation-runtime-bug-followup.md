# Tool state mutation — Command not applied at runtime (follow-up)

**Date:** 2026-05-16
**Status:** **RESOLVED — not a bug.** The framework works correctly. The live-LLM "loop" with `gpt-5` was model behavior (model hallucinated a Flask scaffolding task and looped on its own execution failure), not framework breakage. Two regression tests added in PR #152 prove the agent loop → tool → Command → state-channel chain works end-to-end. See "Resolution" section.
**Owner:** Brian Love

## The bug

Sub-project 2c (PR #150) added the `{result, state}` wrapped-return API for capability tools. The langchain bridge correctly constructs a LangGraph `Command({update: {...stateUpdates, messages: [ToolMessage]}})` when a tool returns the wrapper. Unit + integration tests verified the Command's `update.todos` contains the expected value.

But at runtime, end-to-end against a real LLM with `gpt-5`, the agent calls `write_todos` 11 times in a row with identical content, hits LangGraph's recursion limit, and the final state shows `todos: None` (or `[]` for non-error completions). The Command's update never lands on the state channel.

Captured live-smoke evidence in this PR (#151): all 11 `plan_update` SSE events emitted with the same `{todos: [...3 same items...]}` payload. State never advanced; agent kept restating the plan because its "Current plan:" prompt fragment kept rendering `(empty)`.

## What we verified does work

1. `unwrapToolResult` detects the wrapper shape correctly (13 unit tests pass).
2. `convertToolToLangChain` constructs a `Command` instance with the expected `update.todos` and embedded ToolMessage (integration test passes — `isCommand(result)` is true, `cmd.update.todos` matches).
3. The planning capability's `stateFields` declaration includes `{name: "todos", reducer: "replace", default: []}` — channel exists in the schema.
4. ToolNode's source explicitly preserves non-PARENT Commands and pushes them to `combinedOutputs` as-is (read in `@langchain/langgraph@1.3.0/dist/prebuilt/tool_node.js`).

So the construction is right, the channel exists, and ToolNode passes the Command through. **The gap is in how LangGraph's runtime applies the Command's update to the channel state.**

## Hypotheses (in order of plausibility)

1. **Missing `tool_call_id` in the embedded ToolMessage.** Our `extractToolCallId(config)` helper returns `""` (empty string) because the config object's shape in `@langchain/openai@1.4.5`'s tool wrapper doesn't match the lookup paths we tried. LangGraph might reject Commands with anonymous ToolMessages, OR the AI agent loop fails to pair the tool result back to its call. If the call/result pairing breaks, the agent can't see the tool's output as a "response" → it re-issues the tool call.

2. **Command's `update` shape is wrong for ToolNode.** Maybe LangGraph expects state mutations in a different key (e.g., `update.state` or `update.partial`) and our spreading of `stateUpdates` directly into `update` doesn't get picked up by the channel reducer.

3. **createReactAgent's tool node is a different code path than ToolNode.** We read ToolNode's source assuming createReactAgent uses it. If createReactAgent uses a different tool execution wrapper, our Command might be dropped or ignored.

4. **State schema isn't actually being applied to createReactAgent.** Maybe `agentOptions.stateSchema = materializeStateSchema(stateFields)` isn't enough — there might be a `stateSchema` vs `responseFormat` distinction we're missing.

## Investigation plan

1. Add a `console.log` (or proper debug) in `convertToolToLangChain` printing the `config` object and the resulting Command. Run live smoke. Compare to expected.
2. Read `createReactAgent`'s source to see which tool wrapper it uses and whether it strips/transforms Commands.
3. Build a minimal test: a tool that returns a known Command, fed through the full agent loop (mocked LLM), assert the state channel was updated.
4. If hypothesis 1 confirms: fix `extractToolCallId` to read the right field. If 2: change the Command shape. If 3/4: deeper restructuring of how we wire state into createReactAgent.

## Workaround until fixed

None. The planning capability surfaces the bug visibly (re-emission loop). Skills (sub-project 2b) will hit the same bug if shipped — its `loaded_skills` channel won't update either.

## Why this PR is going out anyway

PR #151 (this PR) adds the `reasoning.effort` API + updates the example to `gpt-5` — both useful regardless of the state-mutation bug. The bug is documented in this file as the next investigation target.

---

## Resolution (added retrospectively)

Investigation in PR #152 added two deterministic tests that prove the framework chain works:

1. **`packages/langchain/test/tool-converter-runtime.test.ts`** — invokes the converted tool via `tool.invoke(ToolCall, config)` (the same path ToolNode uses). Verifies the resulting Command's embedded ToolMessage has the right `tool_call_id` AND that `update.<stateField>` contains the expected value.

2. **`packages/langchain/test/agent-state-update.test.ts`** — builds a real `createReactAgent` with our `materializeStateSchema(...)`-produced schema and a small hand-rolled `SequencedChatModel` that emits an `AIMessage` with `tool_calls`. After one tool call, `result.todos` correctly contains `[{ content: "first", status: "in_progress" }]`. The Command's update IS applied to the state channel; the chain is correct.

### Why the live LLM looked broken

Re-reading the captured smoke logs: gpt-5 received "Make a 3-item plan for refactoring a function..." and hallucinated a Flask scaffolding task (read the actual content of the 11 plan_update events — same Flask todos repeated). The model kept calling write_todos with the same plan because it was failing to execute Step 1 of the plan it made up (and thus stuck in a "should I update the plan? maybe I need a different plan" thrash), not because state.todos was empty.

The final state showed `todos:[]` ONLY because the recursion-limit error replaced the normal completion output. Mid-run state was correctly populated — every `plan_update` SSE event proves that the prompt fragment had access to the updated todos (otherwise the transformer wouldn't have fired with the correct payload).

### Hypothesis check

The three hypotheses listed above turned out to all be wrong:
1. ❌ Missing `tool_call_id` — test 1 shows it's preserved correctly.
2. ❌ Command's `update` shape wrong — test 2 shows it lands on the channel.
3. ❌ createReactAgent uses different tool node — same tool node, same Command application.
4. ❌ State schema not applied — `result.todos` correctly typed and populated in test 2.

### Lesson

PR #150's test gap was that it stopped at "Command is constructed correctly" without testing "Command is applied to state by LangGraph." PR #152 closes that gap.

The reasoning_effort/gpt-5 work in PR #151 was still valuable (knob exists, gpt-5 actually engages with tools). But it shouldn't have been justified by a misdiagnosed framework bug. The truer framing for #151: "the chat example's gpt-5-mini default doesn't reliably exercise tool-calling; gpt-5 is the model that does." Independent of any framework bug.
