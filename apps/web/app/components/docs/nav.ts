export interface DocsNavItem {
  readonly label: string
  readonly href: string
}

export interface DocsNavSection {
  readonly label: string
  readonly items: readonly DocsNavItem[]
}

export const DOCS_NAV = [
  {
    label: "Get Started",
    items: [
      { label: "Getting Started", href: "/docs/getting-started" },
      { label: "Mental Model", href: "/docs/mental-model" },
      { label: "Migrating from LangGraph", href: "/docs/migrating-from-langgraph" },
    ],
  },
  {
    label: "Build",
    items: [
      { label: "Routes", href: "/docs/routes" },
      { label: "Agents", href: "/docs/agents" },
      { label: "Tools", href: "/docs/tools" },
      { label: "State", href: "/docs/state" },
      { label: "Workspace Filesystem", href: "/docs/workspace" },
      { label: "Memory", href: "/docs/memory" },
      { label: "Planning", href: "/docs/planning" },
      { label: "Skills", href: "/docs/skills" },
      { label: "Subagents", href: "/docs/subagents" },
      { label: "Context Management", href: "/docs/context-management" },
      { label: "Reasoning Effort", href: "/docs/reasoning-effort" },
    ],
  },
  {
    label: "Integrate",
    items: [
      { label: "Dev Server", href: "/docs/dev-server" },
      { label: "Middleware", href: "/docs/middleware" },
      { label: "AG-UI and Web Clients", href: "/docs/ag-ui" },
      { label: "Blueprints", href: "/docs/blueprints" },
    ],
  },
  {
    label: "Test",
    items: [
      { label: "Scenario Testing", href: "/docs/testing" },
      { label: "Agent Test Harness", href: "/docs/testing-agents" },
      { label: "Evals", href: "/docs/evals" },
    ],
  },
  {
    label: "Operate",
    items: [
      { label: "Access Control", href: "/docs/access-control" },
      { label: "Permissions", href: "/docs/permissions" },
      { label: "Retry", href: "/docs/retry" },
      { label: "Observability", href: "/docs/observability" },
      { label: "Inspector", href: "/docs/inspector" },
      { label: "Upgrading", href: "/docs/upgrading" },
    ],
  },
  {
    label: "Deploy",
    items: [
      { label: "Deployment Options", href: "/docs/deployment" },
      { label: "Execution Sandbox", href: "/docs/sandbox" },
    ],
  },
  {
    label: "Recipes",
    items: [
      { label: "Recipes Overview", href: "/docs/recipes" },
      { label: "Add a Tool", href: "/docs/recipes/add-a-tool" },
      { label: "Typed State", href: "/docs/recipes/typed-state" },
      { label: "Auth Middleware", href: "/docs/recipes/auth-middleware" },
      { label: "Stream Output", href: "/docs/recipes/stream-output" },
      { label: "Retry Transient Model Calls", href: "/docs/recipes/retry-flaky-tools" },
      { label: "Dispatch from a Route", href: "/docs/recipes/dispatch-from-route" },
      { label: "Research Assistant Web UI", href: "/docs/recipes/research-web-ui" },
    ],
  },
  {
    label: "Reference",
    items: [
      { label: "Configuration Reference", href: "/docs/configuration" },
      { label: "CLI Reference", href: "/docs/cli" },
      { label: "API Reference", href: "/docs/api" },
      { label: "Error Codes", href: "/docs/errors" },
      { label: "FAQ", href: "/docs/faq" },
    ],
  },
] as const

// Flat ordered list of pages — used for prev/next navigation.
export const DOCS_PAGES: readonly DocsNavItem[] = DOCS_NAV.flatMap(
  (section) => section.items as readonly DocsNavItem[],
)

export interface DocsCrumb {
  readonly label: string
  readonly href?: string
}

// Build breadcrumbs for a given href. Always starts with "Docs" → <section> → <page>.
export function breadcrumbsFor(href: string): readonly DocsCrumb[] {
  const section = DOCS_NAV.find((s) => s.items.some((i) => i.href === href))
  const page = section?.items.find((i) => i.href === href)
  const crumbs: DocsCrumb[] = [{ label: "Docs", href: "/docs/getting-started" }]
  if (section) crumbs.push({ label: section.label })
  if (page) crumbs.push({ label: page.label })
  return crumbs
}

export function siblingsFor(href: string): {
  readonly prev: DocsNavItem | null
  readonly next: DocsNavItem | null
} {
  const idx = DOCS_PAGES.findIndex((p) => p.href === href)
  if (idx < 0) return { prev: null, next: null }
  return {
    prev: idx > 0 ? (DOCS_PAGES[idx - 1] ?? null) : null,
    next: idx < DOCS_PAGES.length - 1 ? (DOCS_PAGES[idx + 1] ?? null) : null,
  }
}
