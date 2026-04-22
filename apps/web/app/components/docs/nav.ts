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
    label: "Start",
    items: [{ label: "Getting Started", href: "/docs/getting-started" }],
  },
  {
    label: "Core Concepts",
    items: [
      { label: "Routes", href: "/docs/routes" },
      { label: "Tools", href: "/docs/tools" },
      { label: "State", href: "/docs/state" },
    ],
  },
  {
    label: "Workflow",
    items: [
      { label: "Testing", href: "/docs/testing" },
      { label: "Dev Server", href: "/docs/dev-server" },
      { label: "Deployment", href: "/docs/deployment" },
    ],
  },
  {
    label: "Reference",
    items: [{ label: "CLI", href: "/docs/cli" }],
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
