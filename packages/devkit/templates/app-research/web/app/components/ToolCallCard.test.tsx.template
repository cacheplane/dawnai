import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { RESULT_PREVIEW_LIMIT, ToolCallView } from "./ToolCallCard"

/**
 * Stubbed for its side effects, not its behavior: importing
 * `@copilotkit/react-core/v2` for real pulls in `dist/v2/index.css`, which Node
 * cannot load, so the suite fails to even collect. Same stub as
 * `PermissionInterrupt.test.tsx` and friends. `ToolCallView` — everything these
 * tests assert on — touches no hook at all.
 */
vi.mock("@copilotkit/react-core/v2", () => ({ useRenderTool: () => {} }))

/**
 * The card's own render function, rendered directly.
 *
 * `ToolCallCard` is registration-only — it calls `useRenderTool` and returns
 * null — so there is nothing to assert on it. `ToolCallView` is the markup that
 * registration hands CopilotKit, which is why it is exported: same split as
 * `activity-renderers.test.tsx`, which renders each registered renderer outside
 * the provider.
 */
function render(props: Parameters<typeof ToolCallView>[0]): string {
  return renderToStaticMarkup(<ToolCallView {...props} />)
}

/** A tool result exactly as the live AG-UI stream carries it. */
function toolMessage(content: string): string {
  return JSON.stringify({
    lc: 1,
    type: "constructor",
    id: ["langchain_core", "messages", "ToolMessage"],
    kwargs: { content, tool_call_id: "call_1" },
  })
}

describe("tool call arguments", () => {
  test("unwraps the double-encoded `input` the live stream sends", () => {
    const markup = render({
      name: "readDoc",
      status: "executing",
      parameters: { input: '{"path":"corpus/x.md"}' },
    })
    expect(markup).toContain("corpus/x.md")
    // The double-encoded wrapper itself must not reach the reader. The escaped
    // JSON is the whole claim: if `parseArgs` stopped unwrapping, the card
    // would render `{"input":"{\"path\":...`, and this catches it.
    expect(markup).not.toContain("&quot;path&quot;")
  })

  test("falls back to the raw parameters when `input` is not JSON", () => {
    const markup = render({
      name: "readDoc",
      status: "executing",
      parameters: { input: "corpus/x.md" },
    })
    expect(markup).toContain("corpus/x.md")
  })

  test("summarizes searchCorpus by its query", () => {
    const markup = render({
      name: "searchCorpus",
      status: "executing",
      parameters: { input: '{"query":"battery chemistry"}' },
    })
    expect(markup).toContain("battery chemistry")
  })

  test("summarizes runBash by its command", () => {
    const markup = render({
      name: "runBash",
      status: "executing",
      parameters: { input: '{"command":"ls -la corpus"}' },
    })
    expect(markup).toContain("ls -la corpus")
  })

  test("summarizes an unknown tool as its whole argument object", () => {
    const markup = render({
      name: "somethingElse",
      status: "executing",
      parameters: { alpha: 1 },
    })
    expect(markup).toContain("alpha")
  })
})

describe("tool call results", () => {
  test("unwraps a LangChain ToolMessage envelope to its content", () => {
    const markup = render({
      name: "readDoc",
      status: "complete",
      parameters: {},
      result: toolMessage("the document body"),
    })
    expect(markup).toContain("the document body")
    expect(markup).not.toContain("langchain_core")
    expect(markup).not.toContain("tool_call_id")
  })

  test("passes a plain non-JSON result through unchanged", () => {
    const markup = render({
      name: "runBash",
      status: "complete",
      parameters: {},
      result: "total 0\ndrwxr-xr-x  corpus",
    })
    expect(markup).toContain("total 0")
    expect(markup).toContain("drwxr-xr-x  corpus")
  })

  test("shows nothing for a result that has not arrived yet", () => {
    const markup = render({ name: "runBash", status: "executing", parameters: {} })
    expect(markup).not.toContain("<pre")
  })

  test("suppresses a result that arrives before the call is complete", () => {
    // `result` is documented as populated only at `complete`, but the type
    // allows it earlier, and a mid-run string would be a partial buffer. The
    // card gates on status, not on the presence of a result.
    const markup = render({
      name: "runBash",
      status: "executing",
      parameters: {},
      result: toolMessage("half a directory listing"),
    })
    expect(markup).not.toContain("half a directory listing")
    expect(markup).not.toContain("<pre")
  })

  test("bounds a long result instead of filling the transcript", () => {
    const long = "x".repeat(RESULT_PREVIEW_LIMIT + 250)
    const markup = render({
      name: "readDoc",
      status: "complete",
      parameters: {},
      result: toolMessage(long),
    })
    expect(markup).toContain("x".repeat(RESULT_PREVIEW_LIMIT))
    expect(markup).not.toContain(long)
    expect(markup).toContain("+250 more characters")
  })
})

describe("tool call status", () => {
  test("each status renders its own glyph and label", () => {
    const base = { name: "readDoc", parameters: {} } as const

    const preparing = render({ ...base, status: "inProgress" })
    expect(preparing).toContain("preparing…")
    expect(preparing).toContain("○")

    const running = render({ ...base, status: "executing" })
    expect(running).toContain("running…")
    expect(running).toContain("◐")

    const done = render({ ...base, status: "complete" })
    expect(done).toContain("done")
    expect(done).toContain("✓")
  })

  test("does not claim an outcome the wire never carried", () => {
    // `complete` is a LIFECYCLE state: a tool that threw lands here too, and
    // the card cannot see the ToolMessage's own status. So the finished glyph
    // stays muted — the package's green `--dawn-activity-complete` would read
    // as "succeeded". See `STATUS_GLYPH_CLASS` in the component.
    const markup = render({ name: "runBash", status: "complete", parameters: {} })
    expect(markup).not.toContain("dawn-activity-complete")
  })

  test("carries no inline styles or hard-coded greys any more", () => {
    // The whole restyle in two assertions: every color now comes from a `wb-*`
    // utility, and nothing is painted from a `style` object.
    const markup = render({ name: "readDoc", status: "executing", parameters: {} })
    expect(markup).not.toContain("style=")
    expect(markup).not.toContain("#e5e5e5")
  })
})
