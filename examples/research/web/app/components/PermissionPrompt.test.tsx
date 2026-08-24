import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { readParkedInterrupts } from "../lib/thread-source"
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

/**
 * A `kind: "memory"` gate — a real envelope whose `detail` this card has no
 * branch for. Declared as a plain const rather than inline so its extra fields
 * are structural context, not an excess-property error against the subset of
 * the envelope `PermissionMetadata` names.
 */
const MEMORY_METADATA = {
  interruptId: "perm-9",
  kind: "memory",
  detail: { namespace: "beliefs", newContent: "ships on Fridays" },
}

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
    // The accessibility tree only — how the dimming is spelled in Tailwind is
    // not a contract, and asserting the class names just makes a restyle red.
    expect(html).toContain('aria-busy="true"')
    // Dimmed, never `disabled`: that would drop focus to <body> mid-click.
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toMatch(/(?<!aria-)disabled=/)
  })

  test("a hydrated envelope renders the same card as a live one", () => {
    // The live route: `toAguiInterrupt` parks the envelope verbatim under
    // `Interrupt.metadata`, so this is what the live card receives.
    const live = markup(
      <PermissionPrompt metadata={PARKED} isResolving={false} onDecide={() => {}} />,
    )
    // The hydrated route, through the REAL mapper rather than the same object
    // handed over twice — otherwise this asserts nothing about the path the
    // reload case actually takes.
    const parked = readParkedInterrupts({
      interrupts: [{ interruptId: "perm-1", resumeKey: null, value: PARKED }],
    })
    expect(parked).toHaveLength(1)
    const hydrated = markup(
      <PermissionPrompt
        metadata={parked[0]?.metadata ?? {}}
        isResolving={false}
        onDecide={() => {}}
      />,
    )
    expect(hydrated).toBe(live)
    expect(hydrated).toContain("Permission required")
    expect(hydrated).toContain("deployProd")
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

  test("a kind with nothing readable says so, without leaking the envelope", () => {
    // `kind: "memory"` is this case today (see `subjectOf`'s TODO): a real
    // envelope with a detail shape the card has no branch for.
    const html = markup(
      <PermissionPrompt metadata={MEMORY_METADATA} isResolving={false} onDecide={() => {}} />,
    )
    expect(html).toContain("memory: ")
    expect(html).toContain("an unrecognized request")
    // The whole point: no interruptId, no machine `type`, no JSON in front of
    // someone being asked to make a security decision.
    expect(html).not.toContain("perm-9")
    expect(html).not.toContain("{")
  })

  test("the group notice appears only for more than one gate", () => {
    expect(markup(<MultipleGatesNotice count={0} />)).toBe("")
    expect(markup(<MultipleGatesNotice count={1} />)).toBe("")
    expect(markup(<MultipleGatesNotice count={2} />)).toContain("stopped on 2 requests")
  })
})
