import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import matter from "gray-matter"

const scriptFile = realpathSync(fileURLToPath(import.meta.url))
const scriptDir = dirname(scriptFile)
const appRoot = resolve(scriptDir, "..")
const repoRoot = resolve(appRoot, "..", "..")
const contentRoot = join(appRoot, "content")
const defaultOutputFile = join(appRoot, "app", "seo", "lastmod.generated.json")

export function normalizeRelativePath(path) {
  return path.replaceAll("\\", "/")
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function isDirectExecution(invokedPath, modulePath) {
  return (
    invokedPath !== undefined && realpathSync(resolve(invokedPath)) === realpathSync(modulePath)
  )
}

function filesUnder(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return filesUnder(path, extension)
    return entry.isFile() && path.endsWith(extension) ? [path] : []
  })
}

function routeForDoc(source) {
  const stem = normalizeRelativePath(relative(join(contentRoot, "docs"), source)).replace(
    /\.mdx$/,
    "",
  )
  return `/docs/${stem.replace(/\/index$/, "")}`
}

function readPost(source) {
  const { data } = matter(readFileSync(source, "utf8"))
  const rawTags = Array.isArray(data.tags) ? data.tags.map((tag) => String(tag).toLowerCase()) : []
  const tags =
    data.type === "release" && !rawTags.includes("releases") ? [...rawTags, "releases"] : rawTags
  return {
    source,
    draft: data.draft === true,
    date:
      data.date instanceof Date
        ? data.date.toISOString().slice(0, 10)
        : String(data.date).slice(0, 10),
    tags,
  }
}

function sourceDigest(sources) {
  const hash = createHash("sha256")
  const sortedSources = [...sources].sort(compareCodePoints)

  for (const source of sortedSources) {
    const relativeSource = normalizeRelativePath(relative(repoRoot, source))
    const content = readFileSync(source)
    hash.update(`${relativeSource.length}:${relativeSource}:${content.length}:`)
    hash.update(content)
  }

  return hash.digest("hex")
}

function existingManifestEntries(content) {
  try {
    const manifest = JSON.parse(content)
    if (manifest.version !== 2 || typeof manifest.routes !== "object" || manifest.routes === null) {
      return new Map()
    }
    return new Map(Object.entries(manifest.routes))
  } catch {
    return new Map()
  }
}

export function recordDigest(route, lastModified, currentSourceDigest) {
  // Detect partial edits to generated records; repository review remains the trust boundary.
  return createHash("sha256")
    .update(JSON.stringify([route, lastModified, currentSourceDigest]))
    .digest("hex")
}

export function selectLastModified(
  existing,
  route,
  currentSourceDigest,
  currentLastModified,
  latestLastModified = currentLastModified,
) {
  const timestamp =
    typeof existing?.lastModified === "string" ? Date.parse(existing.lastModified) : Number.NaN
  const latestTimestamp = Date.parse(latestLastModified)
  return existing?.sourceDigest === currentSourceDigest &&
    !Number.isNaN(timestamp) &&
    !Number.isNaN(latestTimestamp) &&
    timestamp <= latestTimestamp &&
    new Date(timestamp).toISOString() === existing.lastModified &&
    existing.recordDigest === recordDigest(route, existing.lastModified, currentSourceDigest)
    ? existing.lastModified
    : currentLastModified
}

function manifestContent(asOf, existingContent, check, generationTimestamp) {
  const docs = filesUnder(join(contentRoot, "docs"), ".mdx")
  const posts = filesUnder(join(contentRoot, "blog"), ".mdx").map(readPost)
  const publishedPosts = posts.filter((post) => !post.draft && post.date <= asOf)
  const landingComponents = filesUnder(join(appRoot, "app", "components", "landing"), ".tsx")

  const sourcesByRoute = new Map([
    ["/", [join(appRoot, "app", "page.tsx"), ...landingComponents]],
    ["/blog", publishedPosts.map((post) => post.source)],
    ...docs.map((source) => [routeForDoc(source), [source]]),
  ])

  for (const tag of new Set(publishedPosts.flatMap((post) => post.tags))) {
    sourcesByRoute.set(
      `/blog/tags/${tag}`,
      publishedPosts.filter((post) => post.tags.includes(tag)).map((post) => post.source),
    )
  }

  const existingEntries = existingManifestEntries(existingContent)
  const entries = []
  const sortedRoutes = [...sourcesByRoute.entries()].sort(([left], [right]) =>
    compareCodePoints(left, right),
  )

  for (const [route, sources] of sortedRoutes) {
    const digest = sourceDigest(sources)
    const preservedLastModified = selectLastModified(
      existingEntries.get(route),
      route,
      digest,
      undefined,
      generationTimestamp,
    )
    if (check && preservedLastModified === undefined) return undefined
    const lastModified = preservedLastModified ?? generationTimestamp
    entries.push([
      route,
      {
        lastModified,
        sourceDigest: digest,
        recordDigest: recordDigest(route, lastModified, digest),
      },
    ])
  }

  return `${JSON.stringify({ version: 2, routes: Object.fromEntries(entries) }, null, 2)}\n`
}

function asOfDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid --as-of date: ${value}`)
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid --as-of date: ${value}`)
  }
  return value
}

function optionsFor(argv) {
  let asOf = new Date().toISOString().slice(0, 10)
  let check = false
  let outputFile = defaultOutputFile

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--as-of") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--as-of requires YYYY-MM-DD")
      asOf = asOfDate(value)
      index += 1
    } else if (argument === "--check") {
      check = true
    } else if (argument === "--output") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--output requires a path")
      outputFile = resolve(value)
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  return { asOf, check, outputFile }
}

function main(argv) {
  const { asOf, check, outputFile } = optionsFor(argv)
  let existing = ""
  try {
    existing = readFileSync(outputFile, "utf8")
  } catch {
    // A missing manifest has no timestamps to preserve.
  }
  const content = manifestContent(asOf, existing, check, new Date().toISOString())

  if (check) {
    if (content === undefined || existing !== content) {
      console.error(
        `SEO last-modified manifest is stale: regenerate with pnpm --dir apps/web seo:lastmod --as-of ${asOf}`,
      )
      process.exitCode = 1
    }
    return
  }

  mkdirSync(dirname(outputFile), { recursive: true })
  if (content === undefined) throw new Error("Cannot generate an empty SEO manifest")
  writeFileSync(outputFile, content)
}

if (isDirectExecution(process.argv[1], scriptFile)) {
  main(process.argv.slice(2))
}
