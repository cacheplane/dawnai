// Generates packages/cli/docs/ from the website MDX so the docs ship with the
// installed CLI, version-matched. Run during the CLI build (after tsc emits
// dist/, which this script imports). Reads only static source files.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { buildReadme, extractSummary, extractTitle, mdxToMarkdown, parseNav } from "../dist/lib/docs-bundle.js"

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

function walk(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...walk(abs))
    } else if (entry.name.endsWith(".mdx")) {
      found.push(abs)
    }
  }
  return found
}

const mdxFiles = walk(docsSrc)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const bySlug = new Map()
for (const abs of mdxFiles) {
  const outRel = relative(docsSrc, abs).replace(/\.mdx$/, ".md")
  const raw = readFileSync(abs, "utf8")
  const md = mdxToMarkdown(raw)
  const outPath = join(outDir, outRel)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, md)
  const slug = outRel.replace(/\.md$/, "").replace(/\/index$/, "")
  bySlug.set(slug, {
    slug,
    file: outRel,
    h1: extractTitle(md),
    description: extractSummary(md),
  })
}

const nav = parseNav(readFileSync(navFile, "utf8"))
const labelOf = new Map(nav.map((entry) => [entry.slug, entry.label]))
const finalize = (info) => ({
  slug: info.slug,
  file: info.file,
  title: info.h1 ?? labelOf.get(info.slug) ?? info.slug,
  description: info.description,
})
const ordered = []
const seen = new Set()
for (const entry of nav) {
  if (bySlug.has(entry.slug)) {
    ordered.push(finalize(bySlug.get(entry.slug)))
    seen.add(entry.slug)
  }
}
for (const [slug, info] of bySlug) {
  if (!seen.has(slug)) {
    ordered.push(finalize(info))
  }
}
writeFileSync(join(outDir, "README.md"), buildReadme(ordered))
console.log(`[generate-docs] wrote ${mdxFiles.length} topic(s) + README.md to ${outDir}`)
