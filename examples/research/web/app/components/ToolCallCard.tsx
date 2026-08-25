"use client"
import { useRenderTool } from "@copilotkit/react-core/v2"

// CopilotKit 1.69.0 V2 notes (verified against the installed
// @copilotkit/react-core types under
// node_modules/@copilotkit/react-core/dist; the bundled `.d.mts` filenames
// carry content hashes that change between releases, so none is cited here):
//
// - The registration hook is `useRenderTool` (NOT `useRenderToolCall` — that
//   one takes no args and returns a `({toolCall, toolMessage}) => ReactElement`
//   render *function* used internally by CopilotKit's own message view; it is
//   not a registration API). `useRenderTool` is called under `<CopilotKit>`.
// - Wildcard registration: pass `{ name: "*", render, agentId? }` — the "*"
//   renderer is the fallback when no exact tool-name renderer is registered.
// - The public wildcard overload currently types `render` props as `any`; it
//   does not statically enforce field names or status values. The 1.69.0 V2
//   runtime/default renderer passes
//   `{ name, toolCallId, parameters, status, result }`, where current status
//   values are `"inProgress"`, `"executing"`, and `"complete"`, and `result`
//   is populated for completed calls. Treat this as the current runtime
//   contract, not a guarantee from the wildcard overload.
// - Keep argument/result parsing defensive. The runtime field is named
//   `parameters`, while sibling prop-based renderer APIs use `args`.
//
// With no agentId, this binds to CopilotKit's default agent id ("default"),
// which the runtime route registers as our Dawn /research agent — same as
// every other CopilotKit hook in this app.

/** The three states `useRenderTool` reports a call in. */
export type ToolCallStatus = "inProgress" | "executing" | "complete"

export interface ToolCallViewProps {
  readonly name: string
  readonly status: ToolCallStatus
  readonly parameters: unknown
  readonly result?: string | undefined
}

/**
 * Unwrap a tool call's arguments.
 *
 * THIS IS FOR THE LIVE AG-UI STREAM ONLY, where there are TWO shapes, not one
 * (`app/lib/hydrate.ts`'s header states the same pair from the other side).
 * The dominant `on_chat_model_end` path announces a root tool call's args as a
 * real object; the held `on_tool_start` path carries LangGraph's own `{input}`
 * wrapper, whose value is itself a JSON string. Either way `@dawn-ai/ag-ui`'s
 * outbound layer serializes the whole thing to the JSON string this card
 * receives, so after the caller parses it `parameters` is either the args
 * object directly or `{ input: '{"path":"corpus/x.md"}' }`. The `input` branch
 * below fires on the second and passes the first straight through; unwrapping
 * is what keeps the card from showing double-encoded JSON.
 *
 * The OTHER wire format this app reads, `GET /threads/:id/state`, does NOT look
 * like this: a checkpoint's `tool_calls[].args` is already a real object.
 * `app/lib/hydrate.ts` converts that shape before anything reaches this card,
 * deliberately, so this function never has to guess which format it is holding.
 * Do not add a branch here for the checkpoint shapes — one function guessing
 * between two wire formats is how a silent mis-parse ships.
 */
function parseArgs(parameters: unknown): Record<string, unknown> {
  const p = (parameters ?? {}) as Record<string, unknown>
  if (typeof p.input === "string") {
    try {
      const inner = JSON.parse(p.input)
      if (inner && typeof inner === "object") return inner as Record<string, unknown>
    } catch {
      // Not JSON — fall through and show the raw string.
    }
  }
  return p
}

/**
 * Unwrap a tool result. Same live-stream-only contract as `parseArgs`.
 *
 * On the AG-UI stream a result arrives as a serialized LangChain `ToolMessage`
 * (`{ lc, type, id: [...], kwargs: { content } }`), so pull out the content and
 * show the tool's actual output rather than LangChain internals. Anything that
 * is not that envelope — including plain non-JSON text — passes through
 * untouched. The checkpoint path is already unwrapped by `app/lib/hydrate.ts`;
 * see the note above.
 */
function parseResult(result: string | undefined): string | undefined {
  if (!result) return undefined
  try {
    const parsed = JSON.parse(result) as { kwargs?: { content?: unknown } }
    const content = parsed?.kwargs?.content
    if (typeof content === "string") return content
    if (content != null) return JSON.stringify(content, null, 2)
  } catch {
    // Not JSON — show it as-is.
  }
  return result
}

function summarizeArgs(name: string, parameters: unknown): string {
  const p = parseArgs(parameters)
  switch (name) {
    case "searchCorpus":
      return typeof p.query === "string" ? p.query : JSON.stringify(p)
    case "readDoc":
      return typeof p.path === "string" ? p.path : JSON.stringify(p)
    case "runBash":
      return typeof p.command === "string" ? p.command : JSON.stringify(p)
    case "task":
      return typeof p.subagent === "string" ? `→ ${p.subagent}` : JSON.stringify(p)
    default:
      return JSON.stringify(p)
  }
}

/**
 * How many characters of a result the transcript will show. A tool can return a
 * whole document; the card is a status line, not a viewer.
 */
export const RESULT_PREVIEW_LIMIT = 400

/**
 * The status as the activity cards render one: a glyph in a fixed column plus a
 * muted label. Same vocabulary as `PlanCard`'s checklist — ○ pending, ◐ running,
 * ✓ done — so a transcript of tool cards and activity cards reads as one system.
 */
const STATUS: Record<ToolCallStatus, { readonly glyph: string; readonly label: string }> = {
  inProgress: { glyph: "○", label: "preparing…" },
  executing: { glyph: "◐", label: "running…" },
  complete: { glyph: "✓", label: "done" },
}

/**
 * The glyph colors — and the one place this card deliberately says LESS than
 * the activity cards do.
 *
 * `executing` borrows the PACKAGE's running token rather than redefining it,
 * because a running tool and a running todo should be the same blue:
 * `app/theme.css` says outright that `--dawn-activity-running` stays owned by
 * `@dawn-ai/ag-ui` (it is already semantic and dark-mode aware), and
 * `app/layout.tsx` imports that stylesheet globally. The `currentColor`
 * fallback is not defensive noise: if that import ever went away, the glyph
 * should drop to the card's own text color by declaration rather than by
 * invalid-at-computed-value-time accident, which would inherit some unrelated
 * ancestor's color instead.
 *
 * `complete` stays MUTED, and does not take `--dawn-activity-complete`, because
 * green would claim an outcome the wire never conveys. CopilotKit's `status` is
 * a lifecycle: a tool that threw still arrives here as `"complete"`, and this
 * card sees only the result string — the `ToolMessage`'s own success/error flag
 * (`kwargs.status`) is dropped upstream (see `app/lib/hydrate.ts`, which drops
 * it deliberately to keep the live and restored paths at parity). Reading it in
 * `parseResult` would be a behavior change to a frozen function; if outcome is
 * ever worth showing, it belongs in a follow-up that changes both paths at once.
 * Until then a muted ✓ means "finished", which is all we know.
 */
const STATUS_GLYPH_CLASS: Record<ToolCallStatus, string> = {
  inProgress: "text-wb-muted",
  executing: "text-[var(--dawn-activity-running,currentColor)]",
  complete: "text-wb-muted",
}

/**
 * One tool call, in the workbench's design.
 *
 * ORDINARY TAILWIND UTILITIES ARE FINE HERE — unlike `PlanCard`/`SubagentCard`
 * next door, which may only set properties `@dawn-ai/ag-ui`'s unlayered
 * stylesheet leaves unset. That constraint is about *that* stylesheet: it ships
 * unlayered, so its declarations beat Tailwind's `utilities` layer no matter
 * what the app writes. This card is markup the app owns outright — no package
 * CSS touches it, nothing here is `.dawn-activity*` — so every utility below
 * simply applies. The rhythm (13px text, 8px/10px padding, 6px block margin,
 * 11px meta) is matched by hand to the activity cards' tokens rather than
 * inherited from them, which is why the numbers look hard-coded.
 *
 * Exported so the tests can render it directly; `ToolCallCard` below is the
 * registration-only wrapper, which returns null and cannot be asserted on.
 */
export function ToolCallView({ name, status, parameters, result }: ToolCallViewProps) {
  const { glyph, label } = STATUS[status]
  const content = status === "complete" ? parseResult(result) : undefined
  // UTF-16 units, so an emoji straddling the limit can split. Acceptable for a
  // bounded preview; a grapheme-aware slice would be the fix if it ever shows.
  const preview = content?.slice(0, RESULT_PREVIEW_LIMIT)
  const hidden = content === undefined ? 0 : content.length - (preview?.length ?? 0)

  return (
    <div className="my-1.5 rounded-wb border border-wb-border bg-wb-surface px-2.5 py-2 text-[13px] tracking-tight">
      <div className="flex items-baseline gap-2">
        <span
          aria-hidden="true"
          className={`w-4 shrink-0 text-center ${STATUS_GLYPH_CLASS[status]}`}
        >
          {glyph}
        </span>
        {/*
          `overflow-wrap: anywhere`, not `break-all`: a long tool name should
          break only when it genuinely cannot fit, the same rule the package
          puts on `.dawn-activity__title`. `break-all` splits mid-token even
          when there is room, which turns `searchCorpus` into `searchCorp/us`.

          The radius is `rounded-wb-sm` (7px), a deliberate departure from the
          package badge's flat 4px: that 4px is a hard-coded literal in the
          package sheet, while this chip is app-owned and derives from
          `--wb-radius`, so it restyles with the rest of the workbench.
        */}
        <span className="min-w-0 rounded-wb-sm bg-wb-border px-1.5 py-0.5 font-medium [overflow-wrap:anywhere]">
          {name}
        </span>
        <span className="text-[11px] text-wb-muted">{label}</span>
      </div>
      <div className="mt-1 break-words pl-6 leading-5 text-wb-muted">
        {summarizeArgs(name, parameters)}
      </div>
      {preview ? (
        <div className="pl-6">
          {/*
            `tabIndex={0}` + a named region: this box scrolls, and Safari does
            not make scrollable containers keyboard-focusable on its own, so
            without it a keyboard user cannot reach a truncated result at all.
            The label is what a screen reader announces on entering it.

            `text-wb-text`, not muted — this is the densest content on the card
            and should not also be the faintest thing on it. The surrounding
            chrome stays muted; the output itself reads at full contrast.
          */}
          <section
            // A labelled scroll container must be reachable, or its overflow
            // is keyboard-unreachable content.
            // biome-ignore lint/a11y/noNoninteractiveTabindex: scroll container
            tabIndex={0}
            aria-label={`${name} result`}
            className="wb-focus mt-1.5 max-h-[120px] overflow-auto rounded-wb-sm border border-wb-border bg-wb-bg px-2 py-1.5"
          >
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-wb-text">
              {preview}
            </pre>
          </section>
          {hidden > 0 ? (
            <p className="mt-1 text-[11px] tabular-nums text-wb-muted">+{hidden} more characters</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function ToolCallCard() {
  useRenderTool(
    {
      name: "*",
      render: ({ name, status, parameters, result }) => (
        <ToolCallView name={name} status={status} parameters={parameters} result={result} />
      ),
    },
    [],
  )
  return null
}
