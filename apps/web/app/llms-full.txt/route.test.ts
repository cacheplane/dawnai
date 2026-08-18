import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { webContentRoot } from "../../lib/content-root"
import { ALL_DOCS_PAGES } from "../components/docs/nav"
import { GET } from "./route"

const CONTENT_ROOT = webContentRoot()
const FINAL_PR2_API_HREFS = [
  "/docs/api/permissions",
  "/docs/api/workspace",
  "/docs/api/sandbox",
  "/docs/api/langgraph",
  "/docs/api/langchain",
  "/docs/api/sqlite-storage",
] as const

describe("full LLM documentation route", () => {
  it("includes every registered page exactly once and in exhaustive registry order", async () => {
    const body = await (await GET()).text()
    const documentation = body.slice(
      body.indexOf("## Documentation"),
      body.indexOf("## Task-Specific Prompts"),
    )
    const positions = ALL_DOCS_PAGES.map((page) => {
      const slug = page.href.replace(/^\/docs\//, "")
      const file = slug === "recipes" ? "recipes/index.mdx" : `${slug}.mdx`
      const source = readFileSync(join(CONTENT_ROOT, "docs", file), "utf8")
      const marker = `### ${page.label}\n\n${source}`
      const position = documentation.indexOf(marker)

      expect(position, page.href).toBeGreaterThanOrEqual(0)
      expect(documentation.lastIndexOf(marker), page.href).toBe(position)
      return position
    })

    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(documentation).toContain("### Thread Access\n")
    for (const href of FINAL_PR2_API_HREFS) {
      const page = ALL_DOCS_PAGES.find((candidate) => candidate.href === href)
      expect(page, href).toBeDefined()
      expect(documentation).toContain(`### ${page?.label}\n`)
    }
  })

  it("loads the recipes landing page and nested recipe from their authored files", async () => {
    const body = await (await GET()).text()
    const documentation = body.slice(
      body.indexOf("## Documentation"),
      body.indexOf("## Task-Specific Prompts"),
    )

    for (const file of [
      "docs/recipes/index.mdx",
      "docs/recipes/add-a-tool.mdx",
      "docs/memory/long-term.mdx",
    ]) {
      expect(documentation).toContain(readFileSync(join(CONTENT_ROOT, file), "utf8"))
    }
  })
})
