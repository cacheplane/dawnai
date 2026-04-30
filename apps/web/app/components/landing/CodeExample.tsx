export function CodeExample() {
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

      {/* Project tree */}
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
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            <span className="text-purple-400">[tenant]/</span>{" "}
            <span className="text-text-dim text-xs">&larr; dynamic segment</span>
          </div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            <span className="text-blue-400">index.ts</span>{" "}
            <span className="text-text-dim text-xs">&larr; route entry (workflow | graph)</span>
          </div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            <span className="text-text-secondary">state.ts</span>{" "}
            <span className="text-text-dim text-xs">&larr; route state type</span>
          </div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            <span className="text-yellow-400">tools/</span>{" "}
            <span className="text-text-dim text-xs">&larr; co-located tools, auto-discovered</span>
          </div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            <span className="text-green-400">greet.ts</span>{" "}
            <span className="text-text-dim text-xs">
              &larr; typed at build time via compiler API
            </span>
          </div>
          <div>
            &nbsp;&nbsp;
            <span className="text-text-secondary">dawn.generated.d.ts</span>{" "}
            <span className="text-text-dim text-xs">&larr; auto-generated ambient types</span>
          </div>
          <div>
            <span className="text-text-secondary">dawn.config.ts</span>
          </div>
        </div>
      </div>

      {/* Code panels */}
      <div className="flex flex-col md:flex-row gap-4 max-w-3xl mx-auto">
        {/* Route entry */}
        <div className="flex-1 bg-bg-card border border-border rounded-lg p-4 font-mono text-xs leading-7 text-text-secondary overflow-hidden">
          <p className="text-text-muted text-[0.65rem] mb-3">
            src/app/(public)/hello/[tenant]/index.ts
          </p>
          <div>
            <span className="text-purple-400">import</span>{" "}
            <span className="text-yellow-400">type</span> {"{ "}
            <span className="text-yellow-400">RuntimeContext</span>
            {" } "}
            <span className="text-purple-400">from</span>{" "}
            <span className="text-green-400">&quot;@dawn-ai/sdk&quot;</span>
          </div>
          <div>
            <span className="text-purple-400">import</span>{" "}
            <span className="text-yellow-400">type</span> {"{ "}
            <span className="text-yellow-400">RouteTools</span>
            {" } "}
            <span className="text-purple-400">from</span>{" "}
            <span className="text-green-400">&quot;dawn:routes&quot;</span>
          </div>
          <div>
            <span className="text-purple-400">import</span>{" "}
            <span className="text-yellow-400">type</span> {"{ "}
            <span className="text-yellow-400">HelloState</span>
            {" } "}
            <span className="text-purple-400">from</span>{" "}
            <span className="text-green-400">&quot;./state.js&quot;</span>
          </div>
          <div className="mt-2">
            <span className="text-purple-400">export async function</span>{" "}
            <span className="text-blue-400">workflow</span>(
          </div>
          <div>
            &nbsp;&nbsp;state: <span className="text-yellow-400">HelloState</span>,
          </div>
          <div>
            &nbsp;&nbsp;ctx: <span className="text-yellow-400">RuntimeContext</span>&lt;
            <span className="text-yellow-400">RouteTools</span>&lt;
            <span className="text-green-400">&quot;/hello/[tenant]&quot;</span>
            &gt;&gt;
          </div>
          <div>
            {")"} {"{"}
          </div>
          <div>
            &nbsp;&nbsp;<span className="text-purple-400">const</span> result ={" "}
            <span className="text-purple-400">await</span> ctx.tools.
            <span className="text-blue-400">greet</span>({"{"})
          </div>
          <div>&nbsp;&nbsp;&nbsp;&nbsp;tenant: state.tenant</div>
          <div>&nbsp;&nbsp;{"}"})</div>
          <div>
            &nbsp;&nbsp;<span className="text-purple-400">return</span> {"{"} ...state, greeting:
            result.greeting {"}"}
          </div>
          <div>{"}"}</div>
        </div>

        {/* Tool + types */}
        <div className="flex-1 bg-bg-card border border-border rounded-lg p-4 font-mono text-xs leading-7 text-text-secondary overflow-hidden">
          <p className="text-text-muted text-[0.65rem] mb-3">tools/greet.ts</p>
          <div>
            <span className="text-purple-400">export default async</span> (input: {"{"}
          </div>
          <div>
            &nbsp;&nbsp;<span className="text-purple-400">readonly</span> tenant:{" "}
            <span className="text-yellow-400">string</span>
          </div>
          <div>
            {"}"}) =&gt; {"{"}
          </div>
          <div>
            &nbsp;&nbsp;<span className="text-purple-400">return</span> {"{"}
          </div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;greeting: <span className="text-green-400">{"`Hello, ${"}</span>
            input.tenant
            <span className="text-green-400">{"}!`"}</span>
          </div>
          <div>&nbsp;&nbsp;{"}"}</div>
          <div>{"}"}</div>
          <div className="mt-6 border-t border-border pt-3">
            <p className="text-text-muted text-[0.65rem] mb-3">
              dawn.generated.d.ts <span className="text-text-dim">(auto-generated)</span>
            </p>
            <div>
              <span className="text-purple-400">declare module</span>{" "}
              <span className="text-green-400">&quot;dawn:routes&quot;</span> {"{"}
            </div>
            <div>
              &nbsp;&nbsp;<span className="text-purple-400">export type</span>{" "}
              <span className="text-yellow-400">RouteTools</span>&lt;P&gt; =
            </div>
            <div>
              &nbsp;&nbsp;&nbsp;&nbsp;
              <span className="text-yellow-400">DawnRouteTools</span>[P]
            </div>
            <div>
              &nbsp;&nbsp;
              <span className="text-gray-500">{"// greet signature inferred"}</span>
            </div>
            <div>
              &nbsp;&nbsp;
              <span className="text-gray-500">{"// from tools/greet.ts export"}</span>
            </div>
            <div>{"}"}</div>
          </div>
        </div>
      </div>

      {/* CLI output */}
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
