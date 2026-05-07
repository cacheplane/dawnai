import Link from "next/link"
import { BrandLogo } from "./BrandLogo"

interface LinkItem {
  readonly label: string
  readonly href: string
  readonly external?: boolean
}

interface Column {
  readonly heading: string
  readonly items: readonly LinkItem[]
}

const COLUMNS: readonly Column[] = [
  {
    heading: "Docs",
    items: [
      { label: "Getting Started", href: "/docs/getting-started" },
      { label: "Routes", href: "/docs/routes" },
      { label: "Tools", href: "/docs/tools" },
      { label: "State", href: "/docs/state" },
      { label: "Testing", href: "/docs/testing" },
      { label: "Dev Server", href: "/docs/dev-server" },
      { label: "Deployment", href: "/docs/deployment" },
      { label: "CLI", href: "/docs/cli" },
    ],
  },
  {
    heading: "For Agents",
    items: [
      { label: "llms.txt", href: "/llms.txt", external: true },
      { label: "llms-full.txt", href: "/llms-full.txt", external: true },
      { label: "AGENTS.md", href: "/AGENTS.md", external: true },
      { label: "CLAUDE.md", href: "/CLAUDE.md", external: true },
      { label: "Scaffold prompt", href: "/prompts/scaffold", external: true },
      { label: "Add a tool", href: "/prompts/add-a-tool", external: true },
      { label: "Write a route", href: "/prompts/write-a-route", external: true },
      { label: "Write a test", href: "/prompts/write-a-test", external: true },
      { label: "Deploy", href: "/prompts/deploy", external: true },
    ],
  },
  {
    heading: "Ecosystem",
    items: [
      { label: "LangChain", href: "https://langchain.com", external: true },
      { label: "LangGraph", href: "https://www.langchain.com/langgraph", external: true },
      { label: "LangSmith", href: "https://smith.langchain.com", external: true },
      { label: "TypeScript", href: "https://www.typescriptlang.org", external: true },
      { label: "Vite", href: "https://vitejs.dev", external: true },
    ],
  },
  {
    heading: "Source",
    items: [
      { label: "Brand Assets", href: "/brand" },
      { label: "GitHub", href: "https://github.com/cacheplane/dawnai", external: true },
      { label: "npm", href: "https://www.npmjs.com/org/dawn-ai", external: true },
      {
        label: "MIT License",
        href: "https://github.com/cacheplane/dawnai/blob/main/LICENSE",
        external: true,
      },
    ],
  },
]

function FooterLink({ label, href, external }: LinkItem) {
  const className =
    "text-sm text-text-secondary hover:text-accent-amber transition-colors block py-0.5"
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {label}
      </a>
    )
  }
  return (
    <Link href={href} className={className}>
      {label}
    </Link>
  )
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" role="img" aria-hidden>
      <title>GitHub</title>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

function NpmIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" role="img" aria-hidden>
      <title>npm</title>
      <path d="M0 0v16h16V0H0zm13 13h-2.5V5.5H8V13H3V3h10v10z" />
    </svg>
  )
}

export function Footer() {
  return (
    <footer
      className="relative px-8 pt-16 pb-10 mt-12 border-t border-border-subtle"
      style={{
        background:
          "linear-gradient(to bottom, transparent 0%, rgba(2,6,23,0.4) 50%, #020617 100%)",
      }}
    >
      {/* Subtle starfield echo — closes the cosmic loop one final time */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-32 opacity-30 bg-no-repeat bg-top"
        style={{
          backgroundImage: "url('/backgrounds/dawn-stars.svg')",
          backgroundSize: "100% auto",
        }}
      />

      <div className="relative max-w-6xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-10 md:gap-8">
          {/* Brand block — spans 2 cols on desktop, full width on mobile */}
          <div className="col-span-2 md:col-span-2">
            <BrandLogo imageClassName="h-8" />
            <p className="text-sm text-text-muted mt-3 leading-relaxed max-w-[36ch]">
              The App Router for AI agents. A TypeScript-first meta-framework for LangChain.
            </p>
            <div className="flex items-center gap-3 mt-5">
              <a
                href="https://github.com/cacheplane/dawnai"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center w-10 h-10 rounded-md border border-border text-text-muted hover:text-accent-amber hover:border-accent-amber/40 transition-colors"
                aria-label="GitHub"
              >
                <GitHubIcon />
              </a>
              <a
                href="https://www.npmjs.com/org/dawn-ai"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center w-10 h-10 rounded-md border border-border text-text-muted hover:text-accent-amber hover:border-accent-amber/40 transition-colors"
                aria-label="npm"
              >
                <NpmIcon />
              </a>
            </div>
          </div>

          {/* Link columns */}
          {COLUMNS.map((col) => (
            <div key={col.heading} className="flex flex-col gap-1">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-accent-amber mb-2">
                {col.heading}
              </p>
              {col.items.map((item) => (
                <FooterLink key={item.label} {...item} />
              ))}
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="mt-12 pt-6 border-t border-border-subtle text-xs text-text-muted text-center md:text-left">
          {`© ${new Date().getFullYear()} Dawn · MIT-licensed · Built on the LangChain ecosystem`}
        </div>
      </div>
    </footer>
  )
}
