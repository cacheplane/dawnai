import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { Composer } from "./Composer"

const noop = () => {}

function render(state: { isRunning: boolean; isAwaitingApproval: boolean }): string {
  return renderToStaticMarkup(<Composer onSend={noop} onStop={noop} {...state} />)
}

const IDLE = { isRunning: false, isAwaitingApproval: false }
const RUNNING = { isRunning: true, isAwaitingApproval: false }
const AWAITING = { isRunning: false, isAwaitingApproval: true }

describe("composer", () => {
  test("cannot send an empty message even when nothing is blocking", () => {
    expect(render(IDLE)).toContain("disabled")
  })

  test("keeps the blocked textarea focusable and described, not disabled", () => {
    // `disabled` on the textarea would yank focus out of the box mid-sentence
    // when an interrupt arrives, and hide it from assistive tech entirely.
    const markup = render(AWAITING)
    expect(markup).toMatch(/\breadonly=""/i)
    expect(markup).toContain('aria-disabled="true"')
    expect(markup).toMatch(/aria-describedby="[^"]+"/)
  })

  test("offers Stop instead of Send while a run is in flight", () => {
    // Without it, the only escape from a long — or hung, where `isRunning`
    // never clears — run is switching threads, which destroys the transcript.
    const markup = render(RUNNING)
    expect(markup).toContain("Stop")
    expect(markup).not.toContain("Send")
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
