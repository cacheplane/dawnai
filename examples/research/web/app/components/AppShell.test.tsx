// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The one test in this suite that mounts a component over a fake, and the one
 * place a fake is justified: the contract under test is *our* effect's
 * behavior, not the library's. `AppShell`'s thread-switch reset is guarded by
 * `renderedThreadIdRef`, and the guard exists because `agent` is also in the
 * effect's dependency array while its identity changes for reasons outside
 * this file — `useAgent` swaps a provisional stand-in for the real agent once
 * the runtime `/info` sync resolves, and hands back a different instance again
 * whenever the registry changes.
 *
 * Both halves of that guard have to hold, and neither is observable from the
 * pure layers:
 *
 * - drop the ref and an agent swap wipes a transcript nobody asked to leave;
 * - break the ref the other way (make it always match) and a real thread
 *   switch stops clearing `pendingInterrupts`, which puts thread A's
 *   approve/deny card in front of an agent now pointed at thread B — a bug we
 *   have already shipped once. Every gate stayed green for it; the only
 *   symptom was the wrong card in a live browser.
 */
const mocks = vi.hoisted(() => ({
  agent: null as unknown as FakeAgent,
}))

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({ agent: mocks.agent, isReady: true }),
  useCopilotKit: () => ({
    copilotkit: {
      subscribe: () => ({ unsubscribe: () => {} }),
      runAgent: async () => {},
    },
  }),
  useRenderActivityMessage: () => ({
    renderActivityMessage: () => null,
    findRenderer: () => null,
  }),
  useRenderToolCall: () => () => null,
  useInterrupt: () => null,
  useSuggestions: () => ({
    suggestions: [],
    reloadSuggestions: () => {},
    clearSuggestions: () => {},
    isLoading: false,
  }),
  CopilotChatAssistantMessage: { MarkdownRenderer: () => null },
}))

const { AppShell } = await import("./AppShell")

interface FakeAgent {
  messages: unknown[]
  isRunning: boolean
  pendingInterrupts: unknown[]
  setMessagesCalls: number
  abortCalls: number
  addMessage: (message: unknown) => void
  setMessages: (messages: unknown[]) => void
  abortRun: () => void
}

function makeAgent(): FakeAgent {
  return {
    messages: [{ id: "m1", role: "user", content: "carried over" }],
    isRunning: false,
    pendingInterrupts: [{ id: "interrupt-1" }],
    setMessagesCalls: 0,
    abortCalls: 0,
    addMessage() {},
    setMessages(messages) {
      this.setMessagesCalls += 1
      this.messages = messages
    },
    abortRun() {
      this.abortCalls += 1
    },
  }
}

let container: HTMLDivElement
let root: Root

function render(activeThreadId: string | undefined) {
  act(() => {
    root.render(
      <AppShell
        threads={[]}
        activeThreadId={activeThreadId}
        onSelectThread={() => {}}
        onCreateThread={() => {}}
        onUserMessage={() => {}}
      />,
    )
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.agent = makeAgent()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe("app shell thread-switch reset", () => {
  test("leaves the agent alone on the first render of a thread", () => {
    render("thread-a")
    expect(mocks.agent.setMessagesCalls).toBe(0)
    expect(mocks.agent.pendingInterrupts).toHaveLength(1)
  })

  test("clears the transcript and the parked interrupts when the thread changes", () => {
    render("thread-a")
    const agent = mocks.agent
    render("thread-b")
    expect(agent.setMessagesCalls).toBe(1)
    expect(agent.messages).toEqual([])
    // The half that matters most: a parked interrupt left on the shared agent
    // makes the next run throw, and leaves the abandoned thread's card live.
    expect(agent.pendingInterrupts).toEqual([])
  })

  test("aborts a run in flight when the thread changes", () => {
    mocks.agent.isRunning = true
    render("thread-a")
    const agent = mocks.agent
    render("thread-b")
    expect(agent.abortCalls).toBe(1)
  })

  test("does NOT reset when only the agent's identity changes", () => {
    render("thread-a")
    // What `useAgent` does when the provisional agent is swapped for the real
    // one after runtime sync: same thread, different instance.
    const swapped = makeAgent()
    mocks.agent = swapped
    render("thread-a")
    expect(swapped.setMessagesCalls).toBe(0)
    expect(swapped.pendingInterrupts).toHaveLength(1)
    expect(swapped.messages).toHaveLength(1)
  })
})
