import { highlight } from "../../../lib/shiki/highlight"

const ROUTE_SNIPPET = `export async function workflow(
  state: HelloState,
  ctx: RuntimeContext<RouteTools<"/hello/[tenant]">>,
) {
  const r = await ctx.tools.greet({ tenant: state.tenant })
  return { ...state, greeting: r.greeting }
}
`

interface CommandChip {
  readonly text: string
  readonly prompt?: boolean
}

interface Moment {
  readonly num: string
  readonly active?: boolean
  readonly title: string
  readonly description: string
  readonly commands: readonly CommandChip[]
  readonly proofLabel: string
  readonly proofBadge: string
  readonly proofBadgeAccent: "green" | "amber"
}

const MOMENTS: readonly Moment[] = [
  {
    num: "01",
    active: true,
    title: "Scaffold the project.",
    description:
      "One command writes a working agent: project structure, dawn.config, generated types, and an example route with a typed tool.",
    commands: [{ text: "pnpm create dawn-ai-app my-agent", prompt: true }],
    proofLabel: "stdout",
    proofBadge: "✓ created",
    proofBadgeAccent: "green",
  },
  {
    num: "02",
    title: "Write a route.",
    description:
      "Routes are folders. Export a workflow from index.ts, drop tools in the sibling tools/ directory. Types are generated as you save.",
    commands: [{ text: "src/app/(public)/hello/[tenant]/index.ts" }],
    proofLabel: "your code",
    proofBadge: "edits",
    proofBadgeAccent: "amber",
  },
  {
    num: "03",
    title: "Run it.",
    description:
      "Dispatch any route by path. Get back fully-typed output — no manual schemas, no manual wiring.",
    commands: [{ text: "dawn run '/hello/acme'", prompt: true }],
    proofLabel: "stdout",
    proofBadge: "200",
    proofBadgeAccent: "green",
  },
  {
    num: "04",
    title: "Iterate.",
    description:
      "HMR on every save. Scenario tests in milliseconds. When you're ready, deploy speaks the LangGraph Platform protocol natively — no translation layer.",
    commands: [
      { text: "dawn dev", prompt: true },
      { text: "dawn test --watch", prompt: true },
    ],
    proofLabel: "dev server · scenario tests",
    proofBadge: "live",
    proofBadgeAccent: "green",
  },
]

export async function HowItWorks() {
  const routeHtml = await highlight(ROUTE_SNIPPET, "typescript")

  return (
    <section className="py-36 px-8 border-t landing-border">
      <div className="max-w-[1100px] mx-auto">
        <p className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-accent-amber font-semibold mb-3">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          The flow
        </p>
        <h2
          className="font-display font-bold tracking-tight leading-[1.05] mb-4 max-w-[720px] landing-text"
          style={{
            fontSize: "clamp(36px, 5vw, 48px)",
            letterSpacing: "-0.025em",
            fontVariationSettings: "'opsz' 144, 'SOFT' 50",
          }}
        >
          From <span style={{ color: "#d97706", fontStyle: "italic" }}>zero</span> to running agent.
        </h2>
        <p className="landing-text-muted text-lg leading-relaxed max-w-[600px] mb-12">
          A simple getting-started loop. Four commands; each one shows you exactly what it did.
        </p>

        <div className="max-w-3xl">
          {MOMENTS.map((moment, i) => (
            <Moment
              key={moment.num}
              moment={moment}
              isLast={i === MOMENTS.length - 1}
              proofContent={moment.num === "02" ? <ShikiProof html={routeHtml} /> : null}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function Moment({
  moment,
  isLast,
  proofContent,
}: {
  readonly moment: Moment
  readonly isLast: boolean
  readonly proofContent: React.ReactNode
}) {
  return (
    <div
      className={`grid grid-cols-[56px_1fr] sm:grid-cols-[80px_1fr] gap-6 sm:gap-7 py-7 ${
        isLast ? "" : "border-b"
      }`}
      style={{ borderColor: "var(--landing-border)" }}
    >
      <div
        className="font-display font-bold leading-none pt-1.5"
        style={{
          fontSize: "clamp(40px, 6vw, 56px)",
          color: moment.active ? "#d97706" : "rgba(217,119,6,0.30)",
          fontVariationSettings: "'opsz' 144, 'SOFT' 50",
        }}
      >
        {moment.num}
      </div>
      <div className="min-w-0">
        <h3
          className="font-display font-bold landing-text mb-2 leading-tight"
          style={{
            fontSize: "22px",
            fontVariationSettings: "'opsz' 144, 'SOFT' 50",
          }}
        >
          {moment.title}
        </h3>
        <p className="landing-text-muted text-[14.5px] leading-relaxed mb-4 max-w-[560px]">
          {moment.description}
        </p>
        <div className="flex flex-wrap gap-2 mb-4">
          {moment.commands.map((cmd) => (
            <span
              key={cmd.text}
              className="font-mono text-[12.5px] px-2.5 py-1.5 rounded inline-flex items-center gap-1.5"
              style={{ background: "#14110d", color: "#f8f5ef" }}
            >
              {cmd.prompt && <span style={{ color: "#d97706" }}>$</span>}
              {cmd.text}
            </span>
          ))}
        </div>
        {moment.num === "01" && <Proof01 />}
        {moment.num === "02" && proofContent}
        {moment.num === "03" && <Proof03 />}
        {moment.num === "04" && <Proof04 />}
      </div>
    </div>
  )
}

function ProofShell({
  label,
  badge,
  badgeAccent,
  children,
}: {
  readonly label: string
  readonly badge: string
  readonly badgeAccent: "green" | "amber"
  readonly children: React.ReactNode
}) {
  return (
    <div
      className="rounded-lg overflow-hidden max-w-[620px]"
      style={{ background: "#14110d", border: "1px solid #241f19" }}
    >
      <div
        className="px-3.5 py-2 flex items-center justify-between"
        style={{ borderBottom: "1px solid #241f19" }}
      >
        <span
          className="font-mono text-[10px] uppercase tracking-[0.12em]"
          style={{ color: "#5a554c" }}
        >
          {label}
        </span>
        <span
          className="font-mono text-[10px] px-2 py-0.5 rounded"
          style={
            badgeAccent === "green"
              ? { background: "rgba(74,222,128,0.15)", color: "#4ade80" }
              : { background: "rgba(217,119,6,0.18)", color: "#f59e0b" }
          }
        >
          {badge}
        </span>
      </div>
      <div
        className="px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] overflow-x-auto"
        style={{ color: "#c8c8cc" }}
      >
        {children}
      </div>
    </div>
  )
}

function Proof01() {
  return (
    <ProofShell label="stdout" badge="✓ created" badgeAccent="green">
      <div style={{ color: "#5a554c" }}>my-agent/</div>
      <div>
        &nbsp;&nbsp;<span style={{ color: "#facc15" }}>src/app/</span>
      </div>
      <div>
        &nbsp;&nbsp;&nbsp;&nbsp;<span style={{ color: "#5a554c" }}>(public)/</span>
      </div>
      <div>
        &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style={{ color: "#facc15" }}>hello/</span>
      </div>
      <div>
        &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
        <span style={{ color: "#c084fc" }}>[tenant]/</span>
      </div>
      <div>
        &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
        <span style={{ color: "#60a5fa" }}>index.ts</span>
      </div>
      <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;state.ts</div>
      <div>
        &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
        <span style={{ color: "#4ade80" }}>tools/greet.ts</span>
      </div>
      <div>
        &nbsp;&nbsp;dawn.config.ts &nbsp;
        <span style={{ color: "#5a554c" }}>dawn.generated.d.ts</span>
      </div>
      <div style={{ color: "#4ade80", marginTop: "0.4em" }}>&nbsp;&nbsp;✓ ready in 4.2s</div>
    </ProofShell>
  )
}

function ShikiProof({ html }: { readonly html: string }) {
  return (
    <div
      className="rounded-lg overflow-hidden max-w-[620px]"
      style={{ background: "#14110d", border: "1px solid #241f19" }}
    >
      <div
        className="px-3.5 py-2 flex items-center justify-between"
        style={{ borderBottom: "1px solid #241f19" }}
      >
        <span
          className="font-mono text-[10px] uppercase tracking-[0.12em]"
          style={{ color: "#5a554c" }}
        >
          your code
        </span>
        <span
          className="font-mono text-[10px] px-2 py-0.5 rounded"
          style={{ background: "rgba(217,119,6,0.18)", color: "#f59e0b" }}
        >
          edits
        </span>
      </div>
      <div
        className="px-3.5 py-3 text-[12.5px] leading-[1.7] overflow-x-auto [&_pre]:bg-transparent [&_pre]:m-0 [&_pre]:p-0"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is server-generated
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}

function Proof03() {
  return (
    <ProofShell label="stdout" badge="200" badgeAccent="green">
      <div style={{ color: "#5a554c" }}>Route &nbsp;&nbsp; /hello/[tenant]</div>
      <div style={{ color: "#5a554c" }}>Mode &nbsp;&nbsp;&nbsp; workflow</div>
      <div style={{ color: "#5a554c" }}>Tenant &nbsp; acme</div>
      <div style={{ color: "#4ade80", marginTop: "0.4em" }}>
        &nbsp;&nbsp;✓ {"{"} greeting: <span style={{ color: "#4ade80" }}>"Hello, acme!"</span> {"}"}
      </div>
      <div style={{ color: "#5a554c" }}>&nbsp;&nbsp;done in 38ms</div>
    </ProofShell>
  )
}

function Proof04() {
  return (
    <ProofShell label="dev server · scenario tests" badge="live" badgeAccent="green">
      <div>
        <span style={{ color: "#5a554c" }}>[hmr]</span> updated{" "}
        <span style={{ color: "#4ade80" }}>tools/greet.ts</span>{" "}
        <span style={{ color: "#5a554c" }}>in 12ms</span>
      </div>
      <div>
        <span style={{ color: "#5a554c" }}>[hmr]</span> updated{" "}
        <span style={{ color: "#60a5fa" }}>/hello/[tenant]</span>{" "}
        <span style={{ color: "#5a554c" }}>in 8ms</span>
      </div>
      <div style={{ color: "#4ade80", marginTop: "0.4em" }}>
        &nbsp;&nbsp;✓ scenarios passed (3/3)
      </div>
      <div style={{ color: "#4ade80" }}>&nbsp;&nbsp;✓ types regenerated</div>
    </ProofShell>
  )
}
