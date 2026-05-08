import { highlight } from "../../../lib/shiki/highlight"

const ROUTE_SOURCE = `import type { RuntimeContext } from "@dawn-ai/sdk"
import type { RouteTools } from "dawn:routes"
import type { HelloState } from "./state.js"

export async function workflow(
  state: HelloState,
  ctx: RuntimeContext<RouteTools<"/hello/[tenant]">>,
) {
  const result = await ctx.tools.greet({ tenant: state.tenant })
  return { ...state, greeting: result.greeting }
}
`

const TOOL_SOURCE = `export default async (input: {
  readonly tenant: string
}) => {
  return {
    greeting: \`Hello, \${input.tenant}!\`,
  }
}
`

const GENERATED_SOURCE = `declare module "dawn:routes" {
  export type RouteTools<P> = DawnRouteTools[P]
  // greet signature inferred
  // from tools/greet.ts export
}
`

export async function CodeExample() {
  const [routeHtml, toolHtml, generatedHtml] = await Promise.all([
    highlight(ROUTE_SOURCE, "typescript"),
    highlight(TOOL_SOURCE, "typescript"),
    highlight(GENERATED_SOURCE, "typescript"),
  ])

  return (
    <section className="py-20 px-8 border-t border-border-subtle bg-bg-secondary/50">
      <div className="text-center mb-10">
        <p className="text-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          See It
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold text-text-primary leading-[1.1] tracking-tight"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          A Dawn app, typed end to end.
        </h2>
      </div>

      {/* Project tree (unchanged — stylized directory listing, not source code) */}
      <div className="max-w-3xl mx-auto mb-8">
        <div className="bg-bg-card border border-border rounded-lg p-5 font-mono text-sm leading-8 text-text-muted">
          <p className="text-text-secondary text-xs uppercase tracking-wide mb-2 font-sans font-semibold">
            Project Structure
          </p>
          <div>
            <span className="text-yellow-400">src/app/</span>
          </div>
          <div>
            &nbsp;&nbsp;<span className="text-text-muted">(public)/</span>{" "}
            <span className="text-text-dim text-xs">
              &larr; route group, excluded from pathname
            </span>
          </div>
          <div>&nbsp;&nbsp;&nbsp;&nbsp;hello/</div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-purple-400">[tenant]/</span>{" "}
            <span className="text-text-dim text-xs">&larr; dynamic segment</span>
          </div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            <span className="text-blue-400">index.ts</span>{" "}
            <span className="text-text-dim text-xs">&larr; route entry</span>
          </div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            <span className="text-text-secondary">state.ts</span>{" "}
            <span className="text-text-dim text-xs">&larr; route state type</span>
          </div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            <span className="text-yellow-400">tools/</span>{" "}
            <span className="text-text-dim text-xs">&larr; co-located tools</span>
          </div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            <span className="text-green-400">greet.ts</span>{" "}
            <span className="text-text-dim text-xs">&larr; typed at build time</span>
          </div>
          <div>
            &nbsp;&nbsp;<span className="text-text-secondary">dawn.generated.d.ts</span>{" "}
            <span className="text-text-dim text-xs">&larr; auto-generated ambient types</span>
          </div>
          <div>
            <span className="text-text-secondary">dawn.config.ts</span>
          </div>
        </div>
      </div>

      {/* Code panels (highlighted via shiki) */}
      <div className="flex flex-col md:flex-row gap-4 max-w-3xl mx-auto">
        <CodePanel filename="src/app/(public)/hello/[tenant]/index.ts" html={routeHtml} />
        <div className="flex-1 flex flex-col gap-4">
          <CodePanel filename="tools/greet.ts" html={toolHtml} />
          <CodePanel filename="dawn.generated.d.ts (auto-generated)" html={generatedHtml} />
        </div>
      </div>

      {/* CLI output (unchanged — terminal output, not source code) */}
      <div className="max-w-3xl mx-auto mt-6">
        <div className="bg-bg-card border border-border rounded-lg p-4 font-mono text-sm leading-7">
          <p className="text-text-muted text-[0.65rem] mb-2 font-sans">Terminal</p>
          <div className="text-text-secondary">
            <span className="text-accent-amber">$</span>{" "}
            <span className="text-text-primary">dawn run &apos;/hello/acme&apos;</span>
          </div>
          <div className="text-text-muted mt-1">Route&nbsp;&nbsp;&nbsp; /hello/[tenant]</div>
          <div className="text-text-muted">Mode&nbsp;&nbsp;&nbsp;&nbsp; workflow</div>
          <div className="text-text-muted">Tenant&nbsp;&nbsp; acme</div>
          <div className="text-accent-amber mt-1">
            &#10003; {"{"} greeting: &quot;Hello, acme!&quot; {"}"}
          </div>
        </div>
      </div>

      <p className="text-center mt-5 text-text-muted text-sm">
        Type-safe tools, inferred automatically. No manual type wiring. No Zod boilerplate.
      </p>
    </section>
  )
}

interface CodePanelProps {
  readonly filename: string
  readonly html: string
}

function CodePanel({ filename, html }: CodePanelProps) {
  return (
    <div className="flex-1 bg-bg-card border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-2 border-b border-border-subtle">
        <p className="text-text-muted text-[0.65rem] font-mono">{filename}</p>
      </div>
      <div
        className="text-xs leading-6 overflow-x-auto p-4 [&_pre]:bg-transparent [&_pre]:m-0 [&_pre]:p-0"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is server-generated
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
