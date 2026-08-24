import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { MultipleGatesNotice, PermissionPrompt } from "./PermissionPrompt"

/**
 * The card is pure, so it is tested as markup — no DOM, no agent, no
 * CopilotKit. What these tests protect is the thing the split was FOR: a gate
 * the browser watched park and the same gate read back off the server after a
 * reload must render the identical card, because they are the identical
 * envelope taking two different routes to this component.
 */

/** A live gate: what `toAguiInterrupt` parks under `Interrupt.metadata`. */
const COMMAND_METADATA = {
  interruptId: "perm-2",
  type: "permission-request",
  kind: "command",
  detail: { command: "rm -rf build", suggestedPattern: "rm *" },
} as const

/**
 * A parked gate, exactly as `GET /threads/:id/pending_interrupts` returns it
 * in `value` — and byte-for-byte the shape
 * `packages/core/src/capabilities/permission-gate.ts` writes for a tool gate.
 */
const PARKED = {
  interruptId: "perm-1",
  type: "permission-request",
  kind: "tool",
  detail: { toolName: "deployProd", argsPreview: "{}", suggestedPattern: "deployProd" },
} as const

const SUBAGENT_METADATA = {
  interruptId: "perm-3",
  type: "permission-request",
  kind: "subagent",
  callId: "call_1",
  detail: {
    parentRouteId: "research",
    subagentName: "researcher",
    subagentRouteId: "research/researcher",
    inputPreview: "Find the 2026 filings",
    reason: "depth 2",
    suggestedPattern: "researcher",
  },
} as const

function markup(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(node)
}

describe("PermissionPrompt", () => {
  test("renders the permission branch with the gated command", () => {
    const html = markup(
      <PermissionPrompt metadata={COMMAND_METADATA} isResolving={false} onDecide={() => {}} />,
    )
    expect(html).toContain("Permission required")
    expect(html).toContain("rm -rf build")
    expect(html).toContain("command: ")
    expect(html).toContain("Allow once")
    expect(html).toContain("Allow always")
    expect(html).toContain("Deny")
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-busy="false"')
  })

  test("renders the subagent branch with both routes and the reason", () => {
    const html = markup(
      <PermissionPrompt metadata={SUBAGENT_METADATA} isResolving={false} onDecide={() => {}} />,
    )
    expect(html).toContain("Subagent approval required")
    expect(html).toContain("research/researcher")
    expect(html).toContain("Find the 2026 filings")
    expect(html).toContain("Reason: depth 2")
    // The subagent branch's own labels, not the permission branch's.
    expect(html).toContain(">Once<")
    expect(html).toContain(">Always<")
    expect(html).not.toContain("Allow once")
  })

  test("the resolving state dims the actions, marks the card busy, and keeps the buttons", () => {
    const html = markup(
      <PermissionPrompt metadata={COMMAND_METADATA} isResolving={true} onDecide={() => {}} />,
    )
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain("pointer-events-none")
    expect(html).toContain("opacity-50")
    // Dimmed, never `disabled`: that would drop focus to <body> mid-click.
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toMatch(/(?<!aria-)disabled=/)
  })

  test("a hydrated envelope renders the same card as a live one", () => {
    // The live route: the envelope arrives as `Interrupt.metadata`.
    const live = markup(
      <PermissionPrompt metadata={PARKED} isResolving={false} onDecide={() => {}} />,
    )
    // The hydrated route: the endpoint's `value`, parsed off a real body.
    const body = { interrupts: [{ interruptId: "perm-1", resumeKey: null, value: PARKED }] }
    const value = body.interrupts[0]?.value
    const hydrated = markup(
      <PermissionPrompt metadata={value ?? {}} isResolving={false} onDecide={() => {}} />,
    )
    expect(hydrated).toBe(live)
    expect(hydrated).toContain("Permission required")
  })

  test("a tool gate names the tool rather than dumping the envelope", () => {
    const html = markup(
      <PermissionPrompt metadata={PARKED} isResolving={false} onDecide={() => {}} />,
    )
    expect(html).toContain("deployProd")
    // The old fallback stringified the whole envelope into the <code>, which
    // put the interrupt id and the machine `type` in front of the user.
    expect(html).not.toContain("perm-1")
    expect(html).not.toContain("permission-request")
  })

  test("an unknown kind still renders a card rather than nothing", () => {
    const html = markup(
      <PermissionPrompt
        metadata={{ kind: "quantum", message: "approve the flux" }}
        isResolving={false}
        onDecide={() => {}}
      />,
    )
    expect(html).toContain("Permission required")
    expect(html).toContain("approve the flux")
  })

  test("the group notice appears only for more than one gate", () => {
    expect(markup(<MultipleGatesNotice count={0} />)).toBe("")
    expect(markup(<MultipleGatesNotice count={1} />)).toBe("")
    expect(markup(<MultipleGatesNotice count={2} />)).toContain("stopped on 2 requests")
  })
})
