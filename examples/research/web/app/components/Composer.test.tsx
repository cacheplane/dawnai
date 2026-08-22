import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { Composer } from "./Composer"

const noop = () => {}

function render(state: { isRunning: boolean; isAwaitingApproval: boolean }): string {
  return renderToStaticMarkup(<Composer onSend={noop} {...state} />)
}

const IDLE = { isRunning: false, isAwaitingApproval: false }
const RUNNING = { isRunning: true, isAwaitingApproval: false }
const AWAITING = { isRunning: false, isAwaitingApproval: true }

describe("composer", () => {
  test("cannot send an empty message even when nothing is blocking", () => {
    expect(render(IDLE)).toContain("disabled")
  })

  test("blocks sending while a run is in flight", () => {
    const markup = render(RUNNING)
    expect(markup).toContain("disabled")
    expect(markup).toContain("Running…")
  })

  /**
   * The one that matters: a parked permission gate is NOT `isRunning`. The run
   * has finished — with an interrupt — so gating on `isRunning` alone leaves
   * the composer live, and sending from there throws inside `runAgent` after
   * the user's message is already in the transcript.
   */
  test("blocks sending while an approval is outstanding, and says why", () => {
    const markup = render(AWAITING)
    expect(markup).toContain("disabled")
    expect(markup).toContain("Allow or deny the request above to continue this conversation.")
    expect(markup).toContain("Waiting on your decision above…")
  })

  test("explains a blocked composer instead of only greying it out", () => {
    // Each blocked state has its own reason; neither reuses the idle hint.
    const idleHint = "Enter to send · Shift+Enter for a new line"
    expect(render(IDLE)).toContain(idleHint)
    expect(render(AWAITING)).not.toContain(idleHint)
    expect(render(RUNNING)).toContain("The agent is working…")
  })
})
