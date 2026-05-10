export interface DocsNavItem {
  readonly label: string
  readonly href: string
}

export interface DocsNavSection {
  readonly label: string
  readonly items: readonly DocsNavItem[]
}

export const DOCS_NAV: readonly DocsNavSection[] = [
  {
    label: "Get Started",
    items: [
      { label: "Getting Started", href: "/docs/getting-started" },
      { label: "Mental Model", href: "/docs/mental-model" },
    ],
  },
  {
    label: "Concepts",
    items: [
      { label: "Routes", href: "/docs/routes" },
      { label: "Agents", href: "/docs/agents" },
      { label: "Tools", href: "/docs/tools" },
      { label: "State", href: "/docs/state" },
      { label: "Middleware", href: "/docs/middleware" },
      { label: "Retry", href: "/docs/retry" },
    ],
  },
  {
    label: "Tooling",
    items: [
      { label: "Dev Server", href: "/docs/dev-server" },
      { label: "Testing", href: "/docs/testing" },
      { label: "Deployment", href: "/docs/deployment" },
    ],
  },
  {
    label: "Recipes",
    items: [
      { label: "Overview", href: "/docs/recipes" },
      { label: "Add a tool", href: "/docs/recipes/add-a-tool" },
      { label: "Typed state", href: "/docs/recipes/typed-state" },
      { label: "Auth middleware", href: "/docs/recipes/auth-middleware" },
      { label: "Stream output", href: "/docs/recipes/stream-output" },
      { label: "Retry flaky tools", href: "/docs/recipes/retry-flaky-tools" },
      { label: "Dispatch from a route", href: "/docs/recipes/dispatch-from-route" },
    ],
  },
  {
    label: "Reference",
    items: [
      { label: "API", href: "/docs/api" },
      { label: "CLI", href: "/docs/cli" },
    ],
  },
]

// Flat ordered list of pages — used for prev/next navigation.
export const DOCS_PAGES: readonly DocsNavItem[] = DOCS_NAV.flatMap((s) => s.items)

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
