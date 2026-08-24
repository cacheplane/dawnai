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
    // The wrapper itself must not reach the reader.
    expect(markup).not.toContain("input")
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
    // And the box it lives in stays scrollable rather than growing.
    expect(markup).toContain("max-h-[120px]")
  })
})

describe("tool call status", () => {
  test("each status renders its own label", () => {
    const base = { name: "readDoc", parameters: {} } as const
    expect(render({ ...base, status: "inProgress" })).toContain("preparing…")
    expect(render({ ...base, status: "executing" })).toContain("running…")
    expect(render({ ...base, status: "complete" })).toContain("done")
  })

  test("the workbench tokens replace the old hard-coded greys", () => {
    const markup = render({ name: "readDoc", status: "executing", parameters: {} })
    expect(markup).toContain("border-wb-border")
    expect(markup).toContain("bg-wb-surface")
    expect(markup).toContain("text-wb-muted")
    expect(markup).toContain("rounded-wb")
    expect(markup).not.toContain("#e5e5e5")
    expect(markup).not.toContain("style=")
  })
})
