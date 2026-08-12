// Generates packages/cli/docs/ from the website MDX so the docs ship with the
// installed CLI, version-matched. Run during the CLI build (after tsc emits
// dist/, which this script imports). Reads only static source files.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  buildReadme,
  extractSummary,
  extractTitle,
  loadDocsPages,
  mdxToMarkdown,
} from "../dist/lib/docs-bundle.js"

const here = dirname(fileURLToPath(import.meta.url)) // packages/cli/scripts
const pkgRoot = resolve(here, "..") // packages/cli
const repoRoot = resolve(pkgRoot, "..", "..") // repo root
const docsSrc = join(repoRoot, "apps/web/content/docs")
const navFile = join(repoRoot, "apps/web/app/components/docs/nav.ts")
const outDir = join(pkgRoot, "docs")

if (!existsSync(docsSrc)) {
  console.error(`[generate-docs] source docs not found at ${docsSrc}`)
  process.exit(1)
}

const pages = await loadDocsPages(navFile)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const topics = pages.map(({ slug, label }) => {
  const sourceRel = slug === "recipes" ? "recipes/index.mdx" : `${slug}.mdx`
  const alternateRel = slug === "recipes" ? "recipes.mdx" : `${slug}/index.mdx`
  const sourcePath = join(docsSrc, sourceRel)
  if (!existsSync(sourcePath)) {
    throw new Error(`[generate-docs] registered source missing at ${sourcePath}`)
  }
  if (existsSync(join(docsSrc, alternateRel))) {
    throw new Error(`[generate-docs] ambiguous authored sources for /docs/${slug}`)
  }
  const outRel = sourceRel.replace(/\.mdx$/, ".md")
  const raw = readFileSync(sourcePath, "utf8")
  const md = mdxToMarkdown(raw)
  const outPath = join(outDir, outRel)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, md)
  return {
    slug,
    file: outRel,
    title: extractTitle(md) ?? label,
    description: extractSummary(md),
  }
})

writeFileSync(join(outDir, "README.md"), buildReadme(topics))
console.log(`[generate-docs] wrote ${topics.length} topic(s) + README.md to ${outDir}`)
