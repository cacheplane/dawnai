import { describe, expect, it } from "vitest"
import { API_REFERENCE_PAGES } from "./api-reference-pages"
import { filterDocsSearchResults, flattenDocsSearchIndex } from "./docs-search-results"
import { ALL_DOCS_PAGES, DOCS_NAV } from "./nav"
import { DOCS_INDEX, parsePublicExportAliases } from "./search-index"

describe("documentation search index", () => {
  it("contains every registered page in exhaustive registry order", () => {
    const journeySectionByHref = new Map<string, string>(
      DOCS_NAV.flatMap((section) => section.items.map((item) => [item.href, section.label])),
    )
    const apiHrefs = new Set<string>(API_REFERENCE_PAGES.map(({ href }) => href))
    const expected = ALL_DOCS_PAGES.map((item) => ({
      href: item.href,
      title: item.label,
      section: apiHrefs.has(item.href) ? "API Reference" : journeySectionByHref.get(item.href),
    }))

    expect(DOCS_INDEX.map(({ href, title, section }) => ({ href, title, section }))).toEqual(
      expected,
    )
    expect(expected).toContainEqual({
      href: "/docs/recipes",
      title: "Recipes Overview",
      section: "Recipes",
    })
    expect(expected).toContainEqual({
      href: "/docs/memory/long-term",
      title: "Long-term Memory",
      section: "Build",
    })
    expect(expected).toContainEqual({
      href: "/docs/testing-agents/fixtures",
      title: "Fixtures and Recording",
      section: "Test",
    })
    for (const page of API_REFERENCE_PAGES) {
      expect(expected).toContainEqual({
        href: page.href,
        title: page.label,
        section: "API Reference",
      })
    }
  })

  it("maps exact package and subpath aliases to canonical hub or owner pages", () => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    expect(filterDocsSearchResults("@dawn-ai/workspace", results)[0]?.href).toBe("/docs/api")
    expect(filterDocsSearchResults("@dawn-ai/sdk/pure", results)[0]?.href).toBe("/docs/api/sdk")
    expect(filterDocsSearchResults("@dawn-ai/config-typescript/nextjs", results)[0]?.href).toBe(
      "/docs/api",
    )
  })

  it("maps a table-only export to its canonical owner page", () => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    expect(filterDocsSearchResults("fuseHybrid", results)[0]?.href).toBe("/docs/api/memory")
  })

  it.each([
    ["config", "/docs/api/core"],
    ["RuntimeEnv", "/docs/api/core"],
    ["seedDawnConfig", "/docs/api/core"],
  ])("ranks the canonical owner first for the exact %s re-export alias", (alias, href) => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    const matches = filterDocsSearchResults(alias, results)
    expect(matches[0]?.href).toBe(href)
    expect(matches.map(({ href: matchHref }) => matchHref)).toContain("/docs/api/cli")
  })

  it("ranks exact aliases ahead of fuzzy text and preserves registry order for ties", () => {
    const results = flattenDocsSearchIndex([
      {
        href: "/docs/getting-started",
        title: "First page",
        section: "Reference",
        headings: [],
        aliases: ["sharedAlias"],
        canonicalAliases: [],
      },
      {
        href: "/docs/mental-model",
        title: "sharedAlias guide",
        section: "Reference",
        headings: [],
        aliases: ["sharedAlias"],
        canonicalAliases: [],
      },
    ])
    expect(filterDocsSearchResults("sharedAlias", results).map(({ href }) => href)).toEqual([
      "/docs/getting-started",
      "/docs/mental-model",
    ])
  })

  it("returns no results when neither visible text nor an alias matches", () => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    expect(filterDocsSearchResults("definitely-no-such-doc-term", results)).toEqual([])
  })

  it("supports partial aliases and retains the empty-query result cap", () => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    expect(filterDocsSearchResults("fuseHyb", results)[0]?.href).toBe("/docs/api/memory")
    expect(filterDocsSearchResults("", results)).toEqual(results.slice(0, 20))
    expect(filterDocsSearchResults("   ", results)).toEqual(results.slice(0, 20))
  })

  it("parses only exact visible Public exports ownership tables", () => {
    const source = `# Reference

<!--
## Public exports
### \`@dawn-ai/ghost\`
| Export | Responsibility |
|---|---|
| \`Ghost\` | Ignore a comment. |
-->

\`\`\`md
## Public exports
### \`@dawn-ai/fenced\`
| Export | Responsibility |
|---|---|
| \`Fenced\` | Ignore a fence. |
\`\`\`

~~~md
## Public exports
### \`@dawn-ai/tilde-fenced\`
| Export | Responsibility |
|---|---|
| \`TildeFenced\` | Ignore a tilde fence. |
~~~

{/*
## Public exports
### \`@dawn-ai/mdx-comment\`
| Export | Responsibility |
|---|---|
| \`MdxComment\` | Ignore an MDX comment. |
*/}

## Public exports

| Name | Value |
|---|---|
| \`ordinary\` | Ignore an unrelated table. |

### \`@dawn-ai/example\`

| Export | Responsibility |
|---|---|
| \`owned\` | Canonical owner. |
| \`forwarded\` | Re-export [the owner](/docs/api/core#dawn-aicore). |

## Key contracts`

    expect(
      parsePublicExportAliases(source, "/docs/api/example", [
        { heading: "@dawn-ai/example", firstHeader: "Export" },
      ]),
    ).toEqual({
      aliases: ["owned", "forwarded"],
      canonicalAliases: ["owned"],
    })
  })

  it.each([
    ["missing", "# Reference\n\n## Key contracts"],
    [
      "malformed header",
      "# Reference\n\n## Public exports\n\n### `@dawn-ai/example`\n\n| Name | Responsibility |\n|---|---|\n| `owned` | Owner. |\n\n## Key contracts",
    ],
    [
      "malformed row",
      "# Reference\n\n## Public exports\n\n### `@dawn-ai/example`\n\n| Export | Responsibility |\n|---|---|\n| owned | Owner. |\n\n## Key contracts",
    ],
    [
      "table after the next heading",
      "# Reference\n\n## Public exports\n\n### `@dawn-ai/example`\n\n### `bin:example`\n\n| Export | Responsibility |\n|---|---|\n| `owned` | Owner. |\n\n## Key contracts",
    ],
  ])("rejects a %s intended export inventory", (_name, source) => {
    expect(() =>
      parsePublicExportAliases(source, "/docs/api/example", [
        { heading: "@dawn-ai/example", firstHeader: "Export" },
      ]),
    ).toThrow(/Public exports|ownership table|Export/i)
  })

  it("rejects an ownership table for a surface absent from the registry", () => {
    const source = `# Reference

## Public exports

### \`@dawn-ai/example\`

| Export | Responsibility |
|---|---|
| \`owned\` | Owner. |

### \`@dawn-ai/unregistered\`

| Export | Responsibility |
|---|---|
| \`extra\` | Not registered. |

## Key contracts`
    expect(() =>
      parsePublicExportAliases(source, "/docs/api/example", [
        { heading: "@dawn-ai/example", firstHeader: "Export" },
      ]),
    ).toThrow(/unregistered surface/i)
  })

  it("parses generated ownership tables with their distinct header", () => {
    const source = `# Generated Route Types

## Public exports

### \`dawn:routes\`

| Generated export | Responsibility |
|---|---|
| \`DawnRoutePath\` | Generated route paths. |

## Key contracts`
    expect(
      parsePublicExportAliases(source, "/docs/api/generated-routes", [
        { heading: "dawn:routes", firstHeader: "Generated export" },
      ]),
    ).toEqual({ aliases: ["DawnRoutePath"], canonicalAliases: ["DawnRoutePath"] })
  })
})
