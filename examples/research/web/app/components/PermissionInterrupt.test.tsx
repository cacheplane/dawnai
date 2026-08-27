// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The LIVE source of permission gates.
 *
 * `useInterrupt` is faked down to the one thing this component uses it for: it
 * calls `render(…)` with the open interrupts and a `resolve`/`cancel` pair, and
 * returns the element (`renderInChat: false`). That is a thin fake, but the
 * three behaviors below are not reachable any other way and were shipped
 * untested — including the focus-on-mount effect, which carries the longest
 * comment in the file and had no coverage at all.
 */
const mocks = vi.hoisted(() => ({
  cancel: null as unknown as ReturnType<typeof vi.fn>,
  interrupts: [] as unknown[],
  resolve: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock("@copilotkit/react-core/v2", () => ({
  useInterrupt: ({
    render,
  }: {
    render: (args: {
      cancel: unknown
      interrupt: unknown
      interrupts: unknown[]
      resolve: unknown
    }) => unknown
  }) =>
    render({
      cancel: mocks.cancel,
      interrupt: null,
      interrupts: mocks.interrupts,
      resolve: mocks.resolve,
    }),
}))

const { PermissionInterrupt } = await import("./PermissionInterrupt")

/** What `toAguiInterrupt` builds: the envelope parked under `metadata`. */
function interrupt(id: string, toolName: string) {
  return {
    id,
    metadata: { detail: { argsPreview: "{}", suggestedPattern: toolName, toolName }, kind: "tool" },
    reason: "tool",
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.cancel = vi.fn()
  mocks.resolve = vi.fn()
  mocks.interrupts = [interrupt("perm-1", "deployProd")]
  container = document.createElement("div")
  document.body.append(container)
  act(() => {
    root = createRoot(container)
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function render(isResuming = false, onError: (error: unknown) => void = () => {}) {
  act(() => {
    root.render(<PermissionInterrupt onError={onError} isResuming={isResuming} />)
  })
}

function buttons() {
  return [...container.querySelectorAll("button")]
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = buttons().find((button) => button.textContent === label)
  if (found === undefined) throw new Error(`no button labelled ${label}`)
  return found
}

describe("PermissionInterrupt", () => {
  test("takes the keyboard when a gate arrives", () => {
    const typing = document.createElement("textarea")
    document.body.append(typing)
    typing.focus()
    render()
    // The opposite of the hydrated source, and deliberately: this card follows
    // the user's own send, and the composer goes inert at the same moment it
    // appears. Without this a keyboard-only user is left tabbing through a
    // dead composer with nothing saying why it stopped responding.
    expect(document.activeElement).toBe(buttonNamed("Allow once"))
    typing.remove()
  })

  test("only the FIRST card of a group takes focus", () => {
    mocks.interrupts = [interrupt("perm-1", "deployProd"), interrupt("perm-2", "dropTable")]
    render()
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(2)
    // Both cards mount in the same commit; the second must not steal it back.
    expect(document.activeElement).toBe(buttons()[0])
    expect(container.textContent).toContain("stopped on 2 requests")
  })

  test("does not re-steal focus the user has moved on a re-render", () => {
    render()
    const elsewhere = document.createElement("textarea")
    document.body.append(elsewhere)
    elsewhere.focus()
    render(true)
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })

  test("an allow decision resolves against that interrupt's own id", async () => {
    render()
    act(() => {
      buttonNamed("Allow always").click()
    })
    // The decision is dispatched through a microtask so a synchronous throw
    // becomes a rejection the catch can route — see `decide`.
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.resolve).toHaveBeenCalledWith("always", "perm-1")
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  test("a denial cancels rather than resolving a magic string", async () => {
    render()
    act(() => {
      buttonNamed("Deny").click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    // One denial spelling across both sources: the protocol's, not a payload
    // this file would have to keep in sync with the server's vocabulary.
    expect(mocks.cancel).toHaveBeenCalledWith("perm-1")
    expect(mocks.resolve).not.toHaveBeenCalled()
  })

  test("a decision that throws reaches the error surface", async () => {
    const onError = vi.fn()
    mocks.resolve = vi.fn(() => {
      throw new Error("Thread has 2 pending interrupt(s) not addressed by resume")
    })
    render(false, onError)
    act(() => {
      buttonNamed("Allow once").click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    // Fired from an onClick, so without the catch this is an unhandled
    // rejection and nothing at all on screen.
    expect(String(onError.mock.calls[0]?.[0])).toContain("not addressed by resume")
  })
})
