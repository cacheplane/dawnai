import { Buffer } from "node:buffer"
import { readdirSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import matter from "gray-matter"

const scriptFile = realpathSync(fileURLToPath(import.meta.url))
const scriptDirectory = dirname(scriptFile)
const appRoot = resolve(scriptDirectory, "..")
const productionOrigin = "https://dawnai.org"
const currentInventoryDate = "2026-08-26"
const currentInventoryCount = 83
export const CURRENT_SNAPSHOT_MINIMUM_DISTINCT_LASTMOD_DATES = 23
const approvedRobotsAgents = [
  "*",
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "CCBot",
]

function decodeEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  }

  return value.replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    const normalized = code.toLowerCase()
    if (normalized.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16))
    if (normalized.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10))
    return named[normalized] ?? entity
  })
}

function attributesFor(source) {
  const attributes = new Map()
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  for (const match of source.matchAll(pattern)) {
    const name = match[1]?.toLowerCase()
    if (name === undefined) continue
    const value = match[2] ?? match[3] ?? match[4] ?? ""
    attributes.set(name, decodeEntities(value))
  }
  return attributes
}

function tagsNamed(html, name) {
  const tags = []
  const pattern = new RegExp(`<${name}\\b([^>]*)>`, "gi")
  for (const match of html.matchAll(pattern)) tags.push(attributesFor(match[1] ?? ""))
  return tags
}

function exactNonempty(values, label, qualifier = "one nonempty") {
  const nonempty = values.filter((value) => value.trim().length > 0)
  if (values.length !== 1 || nonempty.length !== 1) {
    throw new Error(`expected exactly ${qualifier} ${label}; found ${values.length}`)
  }
  return nonempty[0]
}

function metaValues(metaTags, attribute, expected) {
  const normalized = expected.toLowerCase()
  return metaTags
    .filter((attributes) => attributes.get(attribute)?.toLowerCase() === normalized)
    .map((attributes) => attributes.get("content") ?? "")
}

export function flattenJsonLd(value) {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd)
  if (value === null || typeof value !== "object") return []
  if (Array.isArray(value["@graph"])) return value["@graph"].flatMap(flattenJsonLd)
  return [value]
}

export function extractPageMetadata(html) {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? html
  const metaTags = tagsNamed(head, "meta")
  const linkTags = tagsNamed(head, "link")
  const description = exactNonempty(metaValues(metaTags, "name", "description"), "meta description")
  const openGraphDescription = exactNonempty(
    metaValues(metaTags, "property", "og:description"),
    "Open Graph description",
  )
  const twitterDescription = exactNonempty(
    metaValues(metaTags, "name", "twitter:description"),
    "Twitter description",
  )
  const canonicalCandidates = linkTags
    .filter((attributes) =>
      (attributes.get("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"),
    )
    .map((attributes) => attributes.get("href") ?? "")
  const canonical = exactNonempty(canonicalCandidates, "self-canonical candidate", "one")
  const openGraphImages = metaValues(metaTags, "property", "og:image").filter(
    (value) => value.trim().length > 0,
  )

  const jsonLdEntities = []
  let jsonLdScriptCount = 0
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  for (const match of html.matchAll(scriptPattern)) {
    const attributes = attributesFor(match[1] ?? "")
    if (attributes.get("type")?.toLowerCase() !== "application/ld+json") continue
    jsonLdScriptCount += 1
    try {
      jsonLdEntities.push(...flattenJsonLd(JSON.parse(match[2] ?? "")))
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : ""
      throw new Error(`malformed JSON-LD script ${jsonLdScriptCount}${detail}`)
    }
  }

  const visibleText = decodeEntities(
    html
      .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, " ")
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()

  return {
    canonical,
    description,
    jsonLdEntities,
    jsonLdScriptCount,
    openGraphDescription,
    openGraphImages,
    twitterDescription,
    visibleText,
  }
}

export function parseRobots(text) {
  const groups = []
  const globals = new Map()
  let currentGroup = null

  for (const originalLine of text.split(/\r?\n/)) {
    const line = originalLine.replace(/\s+#.*$/, "").trim()
    if (line.length === 0) {
      currentGroup = null
      continue
    }
    const separator = line.indexOf(":")
    if (separator < 1) throw new Error(`malformed robots directive: ${originalLine}`)
    const key = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()

    if (key === "user-agent") {
      currentGroup = { agent: value, directives: [] }
      groups.push(currentGroup)
    } else if (key === "host" || key === "sitemap") {
      const values = globals.get(key) ?? []
      values.push(value)
      globals.set(key, values)
    } else if (currentGroup === null) {
      const values = globals.get(key) ?? []
      values.push(value)
      globals.set(key, values)
    } else {
      currentGroup.directives.push([key, value])
    }
  }

  return { globals, groups }
}

export function assertExactRobots(text) {
  if (/sitemap_index/i.test(text)) throw new Error("robots must not reference sitemap_index")
  const parsed = parseRobots(text)
  const agents = parsed.groups.map((group) => group.agent)
  if (!isDeepStrictEqual(agents, approvedRobotsAgents)) {
    throw new Error("robots user-agent groups do not exactly match the approved order")
  }

  for (const group of parsed.groups) {
    if (
      !isDeepStrictEqual(group.directives, [
        ["allow", "/"],
        ["disallow", "/api/"],
      ])
    ) {
      throw new Error(
        `robots group ${group.agent} must contain exactly Allow: / and Disallow: /api/`,
      )
    }
  }

  const host = parsed.globals.get("host") ?? []
  const sitemap = parsed.globals.get("sitemap") ?? []
  const otherGlobals = [...parsed.globals.keys()].filter(
    (key) => key !== "host" && key !== "sitemap",
  )
  if (!isDeepStrictEqual(host, [productionOrigin])) {
    throw new Error(`robots must contain exactly one Host: ${productionOrigin}`)
  }
  if (!isDeepStrictEqual(sitemap, [`${productionOrigin}/sitemap.xml`])) {
    throw new Error(`robots must contain exactly one Sitemap: ${productionOrigin}/sitemap.xml`)
  }
  if (otherGlobals.length > 0) {
    throw new Error(`robots contains unexpected global directives: ${otherGlobals.join(", ")}`)
  }

  return {
    agents,
    groups: parsed.groups.length,
    host: host[0],
    sitemap: sitemap[0],
  }
}

export function readPngDimensions(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("invalid PNG signature")
  }
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("PNG does not begin with an IHDR chunk")
  }
  return { height: buffer.readUInt32BE(20), width: buffer.readUInt32BE(16) }
}

export function compareOrderedInventory(expected, actual) {
  const failures = []
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const seen = new Set()

  for (const url of actual) {
    if (seen.has(url)) failures.push(`duplicate sitemap URL: ${url}`)
    seen.add(url)
  }
  for (const url of expected) {
    if (!actualSet.has(url)) failures.push(`missing source URL in sitemap: ${url}`)
  }
  for (const url of actualSet) {
    if (!expectedSet.has(url))
      failures.push(`extra sitemap URL not present in source inventory: ${url}`)
  }

  if (failures.length === 0 && !isDeepStrictEqual(expected, actual)) {
    const index = expected.findIndex((url, position) => url !== actual[position])
    failures.push(
      `sitemap URL order differs from source inventory at index ${index}: expected ${expected[index]}, received ${actual[index]}`,
    )
  }
  return failures
}

export function lastmodDateDistributionFailure(distinctDates, asOf) {
  if (
    asOf === currentInventoryDate &&
    distinctDates < CURRENT_SNAPSHOT_MINIMUM_DISTINCT_LASTMOD_DATES
  ) {
    return `sitemap has only ${distinctDates} distinct lastmod dates; expected at least ${CURRENT_SNAPSHOT_MINIMUM_DISTINCT_LASTMOD_DATES} for the ${currentInventoryDate} production inventory snapshot`
  }
  if (asOf !== currentInventoryDate && distinctDates <= 10) {
    return `sitemap has only ${distinctDates} distinct lastmod dates; expected more than 10`
  }
  return undefined
}

function extractJourneyDocs() {
  const source = readFileSync(join(appRoot, "app", "components", "docs", "nav.ts"), "utf8")
  const start = source.indexOf("export const DOCS_NAV = [")
  const end = source.indexOf("] as const", start)
  if (start < 0 || end < 0) throw new Error("Cannot locate DOCS_NAV source inventory")
  const records = []
  const pattern = /\{\s*label:\s*"([^"]+)",\s*href:\s*"([^"]+)"\s*\}/g
  for (const match of source.slice(start, end).matchAll(pattern)) {
    records.push({ label: match[1], path: match[2] })
  }
  return records
}

function extractApiDocs() {
  const source = readFileSync(
    join(appRoot, "app", "components", "docs", "api-reference-pages.ts"),
    "utf8",
  )
  const start = source.indexOf("export const API_REFERENCE_PAGES = [")
  const end = source.indexOf("] as const", start)
  if (start < 0 || end < 0) throw new Error("Cannot locate API_REFERENCE_PAGES source inventory")
  const records = []
  const pattern = /referencePage\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g
  for (const match of source.slice(start, end).matchAll(pattern)) {
    records.push({ label: match[1], path: match[2] })
  }
  return records
}

function docsSourcePath(path) {
  const slug = path.replace(/^\/docs\//, "")
  return join(appRoot, "content", "docs", slug === "recipes" ? "recipes/index.mdx" : `${slug}.mdx`)
}

function sourceDocsInventory() {
  const journey = extractJourneyDocs()
  const api = extractApiDocs()
  const records = journey.flatMap((record) =>
    record.path === "/docs/api" ? [record, ...api] : [record],
  )
  if (records.length !== 75)
    throw new Error(`Expected 75 ALL_DOCS_PAGES source entries; found ${records.length}`)
  if (new Set(records.map((record) => record.path)).size !== records.length) {
    throw new Error("Duplicate docs path in independent source inventory")
  }
  for (const record of records) {
    record.sourcePath = docsSourcePath(record.path)
    readFileSync(record.sourcePath, "utf8")
  }
  return records
}

function sourceBlogInventory(asOf) {
  const directory = join(appRoot, "content", "blog")
  const posts = readdirSync(directory)
    .filter((filename) => filename.endsWith(".mdx"))
    .map((filename) => {
      const sourcePath = join(directory, filename)
      const { data } = matter(readFileSync(sourcePath, "utf8"))
      const rawTags = Array.isArray(data.tags)
        ? data.tags.map((tag) => String(tag).toLowerCase())
        : []
      const tags =
        data.type === "release" && !rawTags.includes("releases")
          ? [...rawTags, "releases"]
          : rawTags
      const date =
        data.date instanceof Date
          ? data.date.toISOString().slice(0, 10)
          : String(data.date).slice(0, 10)
      const sourceSlug = filename.replace(/\.mdx?$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "")
      const slug = Object.hasOwn(data, "slug") ? data.slug : sourceSlug
      if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
        throw new Error(`Invalid blog slug in source inventory: ${filename}`)
      }
      return { date, draft: data.draft === true, filename, slug, sourcePath, tags }
    })
    .sort((left, right) => (left.date < right.date ? 1 : left.date > right.date ? -1 : 0))

  const visiblePosts = posts.filter((post) => !post.draft && post.date <= asOf)
  const counts = new Map()
  for (const post of visiblePosts) {
    for (const tag of post.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  const tags = [...counts].sort((left, right) => right[1] - left[1]).map(([tag]) => tag)
  return { hiddenPosts: posts.filter((post) => !visiblePosts.includes(post)), tags, visiblePosts }
}

function validateDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid ${label}: ${value}`)
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return value
}

function sourceInventory(asOf) {
  const docs = sourceDocsInventory()
  const blog = sourceBlogInventory(asOf)
  const paths = [
    "/",
    "/blog",
    ...docs.map((record) => record.path),
    ...blog.visiblePosts.map((post) => `/blog/${post.slug}`),
    ...blog.tags.map((tag) => `/blog/tags/${tag}`),
  ]
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate URL in source inventory")
  if (asOf === currentInventoryDate && paths.length !== currentInventoryCount) {
    throw new Error(
      `Expected ${currentInventoryCount} source URLs as of ${currentInventoryDate}; found ${paths.length}`,
    )
  }
  return { ...blog, docs, paths }
}

function parseSitemap(xml) {
  if (!/<urlset\b[^>]*>[\s\S]*<\/urlset>\s*$/i.test(xml)) {
    throw new Error("sitemap response is not a complete urlset")
  }
  const entries = []
  for (const match of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const block = match[1] ?? ""
    const locations = [...block.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
    const lastModified = [...block.matchAll(/<lastmod>([\s\S]*?)<\/lastmod>/gi)]
    if (locations.length !== 1 || lastModified.length !== 1) {
      throw new Error("each sitemap URL must contain exactly one loc and one lastmod")
    }
    entries.push({
      lastModified: decodeEntities(lastModified[0]?.[1]?.trim() ?? ""),
      url: decodeEntities(locations[0]?.[1]?.trim() ?? ""),
    })
  }
  if (entries.length === 0) throw new Error("sitemap contains no URL entries")
  return entries
}

function typeForPath(path) {
  if (path === "/") return "WebPage"
  if (path === "/blog" || path.startsWith("/blog/tags/")) return "CollectionPage"
  if (path.startsWith("/blog/")) return "BlogPosting"
  return "TechArticle"
}

export function canonicalForPath(path) {
  return path === "/" ? productionOrigin : new URL(path, `${productionOrigin}/`).href
}

export function obviousTextRegression(body) {
  if (/^\s*<!doctype html\b/i.test(body) || /<html\b/i.test(body)) return "HTML document"
  if (body.includes("Internal Server Error")) return "Internal Server Error"
  return undefined
}

function exactEntity(entities, type, label) {
  const matching = entities.filter((entity) => entity["@type"] === type)
  if (matching.length !== 1)
    throw new Error(`${label} must contain exactly one ${type}; found ${matching.length}`)
  return matching[0]
}

function assertSiteEntities(entities) {
  const organization = exactEntity(entities, "Organization", "sitewide JSON-LD")
  const website = exactEntity(entities, "WebSite", "sitewide JSON-LD")
  const expectedOrganization = {
    "@id": `${productionOrigin}/#organization`,
    "@type": "Organization",
    logo: {
      "@id": `${productionOrigin}/#logo`,
      "@type": "ImageObject",
      url: `${productionOrigin}/brand/dawn-logo-horizontal-black.svg`,
    },
    name: "Dawn AI",
    url: `${productionOrigin}/`,
  }
  const expectedWebsite = {
    "@id": `${productionOrigin}/#website`,
    "@type": "WebSite",
    name: "Dawn AI",
    publisher: { "@id": `${productionOrigin}/#organization` },
    url: `${productionOrigin}/`,
  }
  if (!isDeepStrictEqual(organization, expectedOrganization)) {
    throw new Error("Organization JSON-LD differs from the constrained site identity")
  }
  if (!isDeepStrictEqual(website, expectedWebsite)) {
    throw new Error("WebSite JSON-LD differs from the constrained site identity")
  }
}

function assertPage(path, parsed) {
  if (parsed.visibleText.length === 0) throw new Error("rendered HTML has no visible text")
  if (parsed.description.length > 155) {
    throw new Error(`meta description is ${parsed.description.length} characters; maximum is 155`)
  }
  if (
    parsed.openGraphDescription !== parsed.description ||
    parsed.twitterDescription !== parsed.description
  ) {
    throw new Error("standard, Open Graph, and Twitter descriptions differ")
  }
  const expectedCanonical = canonicalForPath(path)
  if (parsed.canonical !== expectedCanonical) {
    throw new Error(
      `canonical mismatch: expected ${expectedCanonical}, received ${parsed.canonical}`,
    )
  }
  assertSiteEntities(parsed.jsonLdEntities)

  const expectedType = typeForPath(path)
  const pageEntity = exactEntity(parsed.jsonLdEntities, expectedType, "page JSON-LD")
  if (pageEntity.description !== parsed.description) {
    throw new Error(`${expectedType} JSON-LD description differs from the meta description`)
  }
  const webPages = parsed.jsonLdEntities.filter((entity) => entity["@type"] === "WebPage")
  if (path !== "/" && webPages.length > 0)
    throw new Error("homepage WebPage leaked onto a non-home route")

  const breadcrumbs = parsed.jsonLdEntities.filter((entity) => entity["@type"] === "BreadcrumbList")
  const expectedBreadcrumbs = path === "/" ? 0 : 1
  if (breadcrumbs.length !== expectedBreadcrumbs) {
    throw new Error(
      `expected ${expectedBreadcrumbs} BreadcrumbList entities; found ${breadcrumbs.length}`,
    )
  }
}

function localUrl(productionUrl, baseUrl) {
  const requested = new URL(productionUrl)
  if (requested.origin !== productionOrigin) {
    throw new Error(`refusing to substitute non-production origin: ${requested.origin}`)
  }
  const localOrigin = new URL(baseUrl).origin
  const local = new URL(localOrigin)
  local.pathname = requested.pathname
  local.search = requested.search
  local.hash = ""
  if (local.origin !== localOrigin) {
    throw new Error(`refusing local URL origin escape: ${local.origin}`)
  }
  return local.href
}

async function fetchResponse(url) {
  try {
    return await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`fetch failed for ${url}: ${detail}`)
  }
}

async function mapLimit(values, limit, operation) {
  const results = new Array(values.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  return results
}

function occurrences(haystack, needle) {
  if (needle.length === 0) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index += needle.length
    index = haystack.indexOf(needle, index)
  }
  return count
}

export function docSectionOccurrences(body, label, source) {
  return occurrences(body, `### ${label}\n\n${source}`)
}

export function parseAuditOptions(argv) {
  let baseUrl = process.env.SEO_AUDIT_BASE_URL ?? "http://127.0.0.1:3018"
  let asOf = process.env.SEO_AUDIT_AS_OF ?? new Date().toISOString().slice(0, 10)
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--") {
      continue
    }
    if (argument === "--base-url") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--base-url requires an origin")
      baseUrl = value
      index += 1
    } else if (argument === "--as-of") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--as-of requires YYYY-MM-DD")
      asOf = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  const parsedBase = new URL(baseUrl)
  if (!["http:", "https:"].includes(parsedBase.protocol) || parsedBase.pathname !== "/") {
    throw new Error(`--base-url must be an HTTP(S) origin without a path: ${baseUrl}`)
  }
  return { asOf: validateDate(asOf, "--as-of date"), baseUrl: parsedBase.origin }
}

export async function auditBuiltSeo({ asOf, baseUrl }) {
  const failures = []
  const inventory = sourceInventory(asOf)
  const summary = {
    docs: inventory.docs.length,
    html: 0,
    jsonLd: 0,
    lastmodDates: 0,
    llms: 0,
    llmsDocs: 0,
    ogImages: 0,
    ogNegative404s: 0,
    posts: inventory.visiblePosts.length,
    robotsGroups: 0,
    sitemap: 0,
    source: inventory.paths.length,
    tags: inventory.tags.length,
  }
  let sitemapEntries = []

  try {
    const response = await fetchResponse(new URL("/sitemap.xml", baseUrl))
    if (response.status !== 200) throw new Error(`sitemap returned HTTP ${response.status}`)
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/xml")) {
      throw new Error(
        `sitemap returned unexpected content type: ${response.headers.get("content-type")}`,
      )
    }
    sitemapEntries = parseSitemap(await response.text())
    summary.sitemap = sitemapEntries.length
    const actualUrls = sitemapEntries.map((entry) => entry.url)
    const expectedUrls = inventory.paths.map((path) => new URL(path, `${productionOrigin}/`).href)
    failures.push(...compareOrderedInventory(expectedUrls, actualUrls))

    const dates = new Set()
    for (const entry of sitemapEntries) {
      const parsed = new Date(entry.lastModified)
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== entry.lastModified) {
        failures.push(`invalid ISO lastmod for ${entry.url}: ${entry.lastModified}`)
      } else {
        dates.add(entry.lastModified)
      }
    }
    summary.lastmodDates = dates.size
    const dateDistributionFailure = lastmodDateDistributionFailure(dates.size, asOf)
    if (dateDistributionFailure !== undefined) failures.push(dateDistributionFailure)
    if (actualUrls.some((url) => new URL(url).pathname === "/docs")) {
      failures.push("sitemap contains the /docs redirect")
    }
    for (const hidden of inventory.hiddenPosts) {
      if (actualUrls.includes(`${productionOrigin}/blog/${hidden.slug}`)) {
        failures.push(`sitemap contains draft or future post: /blog/${hidden.slug}`)
      }
    }
  } catch (error) {
    failures.push(`sitemap: ${error instanceof Error ? error.message : String(error)}`)
  }

  const pageResults = await mapLimit(sitemapEntries, 10, async (entry) => {
    let parsed
    const path = new URL(entry.url).pathname
    try {
      const response = await fetchResponse(localUrl(entry.url, baseUrl))
      if (response.status !== 200) throw new Error(`returned HTTP ${response.status}`)
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/html")) {
        throw new Error(`returned unexpected content type: ${response.headers.get("content-type")}`)
      }
      parsed = extractPageMetadata(await response.text())
      assertPage(path, parsed)
      summary.html += 1
      summary.jsonLd += parsed.jsonLdEntities.length
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { parsed, path }
  })

  try {
    const response = await fetchResponse(new URL("/robots.txt", baseUrl))
    if (response.status !== 200) throw new Error(`returned HTTP ${response.status}`)
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/plain")) {
      throw new Error(`returned unexpected content type: ${response.headers.get("content-type")}`)
    }
    summary.robotsGroups = assertExactRobots(await response.text()).groups
  } catch (error) {
    failures.push(`robots.txt: ${error instanceof Error ? error.message : String(error)}`)
  }

  for (const path of ["/llms.txt", "/llms-full.txt"]) {
    try {
      const response = await fetchResponse(new URL(path, baseUrl))
      if (response.status !== 200) throw new Error(`returned HTTP ${response.status}`)
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/plain")) {
        throw new Error(`returned unexpected content type: ${response.headers.get("content-type")}`)
      }
      const body = await response.text()
      const minimumLength = path === "/llms-full.txt" ? 100_000 : 1_000
      if (body.trim().length < minimumLength) {
        throw new Error(`body is unexpectedly short: ${body.trim().length} characters`)
      }
      const regression = obviousTextRegression(body)
      if (regression !== undefined)
        throw new Error(`body contains regression marker: ${regression}`)
      if (!body.includes("# Dawn")) throw new Error("body is missing the Dawn heading")
      summary.llms += 1

      if (path === "/llms-full.txt") {
        for (const doc of inventory.docs) {
          const source = readFileSync(doc.sourcePath, "utf8")
          if (docSectionOccurrences(body, doc.label, source) !== 1) {
            throw new Error(`${doc.path} exact authored section is not present exactly once`)
          }
          summary.llmsDocs += 1
        }
      }
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const postPaths = new Set(inventory.visiblePosts.map((post) => `/blog/${post.slug}`))
  const imageUrls = []
  for (const result of pageResults) {
    if (!postPaths.has(result.path) || result.parsed === undefined) continue
    if (result.parsed.openGraphImages.length !== 1) {
      failures.push(
        `${result.path}: expected exactly one production post OG image URL; found ${result.parsed.openGraphImages.length}`,
      )
    } else {
      imageUrls.push(result.parsed.openGraphImages[0])
    }
  }
  const expectedImageCount = inventory.visiblePosts.length
  if (imageUrls.length !== expectedImageCount || new Set(imageUrls).size !== expectedImageCount) {
    failures.push(
      `production post OG image inventory must contain exactly ${expectedImageCount} unique URLs; found ${new Set(imageUrls).size}`,
    )
  }
  for (const imageUrl of [...new Set(imageUrls)]) {
    try {
      const response = await fetchResponse(localUrl(imageUrl, baseUrl))
      if (response.status !== 200) throw new Error(`returned HTTP ${response.status}`)
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("image/png")) {
        throw new Error(`returned unexpected content type: ${response.headers.get("content-type")}`)
      }
      const dimensions = readPngDimensions(Buffer.from(await response.arrayBuffer()))
      if (!isDeepStrictEqual(dimensions, { height: 630, width: 1200 })) {
        throw new Error(
          `dimensions are ${dimensions.width}x${dimensions.height}; expected 1200x630`,
        )
      }
      summary.ogImages += 1
    } catch (error) {
      failures.push(
        `OG image ${imageUrl}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const draft = inventory.hiddenPosts.find((post) => post.draft)
  const negativePaths = [
    `/blog/${draft?.slug ?? "draft-seo-audit-fixture"}/opengraph-image`,
    "/blog/__seo-audit-unknown__/opengraph-image",
  ]
  for (const path of negativePaths) {
    try {
      const response = await fetchResponse(new URL(path, baseUrl))
      if (response.status !== 404) throw new Error(`returned HTTP ${response.status}; expected 404`)
      summary.ogNegative404s += 1
    } catch (error) {
      failures.push(
        `OG negative ${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return { failures: failures.sort(), inventory, summary }
}

function printResult(options, result) {
  const outcome = result.failures.length === 0 ? "PASS" : "FAIL"
  console.log(`SEO built audit: ${outcome}`)
  console.log(`base=${options.baseUrl} asOf=${options.asOf}`)
  console.log(
    `inventory=${result.summary.source} docs=${result.summary.docs} posts=${result.summary.posts} tags=${result.summary.tags}`,
  )
  console.log(
    `sitemap=${result.summary.sitemap} lastmodDates=${result.summary.lastmodDates} html=${result.summary.html} jsonLdEntities=${result.summary.jsonLd}`,
  )
  console.log(
    `robotsGroups=${result.summary.robotsGroups} llms=${result.summary.llms} llmsDocs=${result.summary.llmsDocs} ogImages=${result.summary.ogImages} og404s=${result.summary.ogNegative404s}`,
  )
  console.log(`failures=${result.failures.length}`)
  for (const failure of result.failures) console.error(`FAIL ${failure}`)
}

async function main(argv) {
  const options = parseAuditOptions(argv)
  const result = await auditBuiltSeo(options)
  printResult(options, result)
  if (result.failures.length > 0) process.exitCode = 1
}

if (process.argv[1] !== undefined && realpathSync(resolve(process.argv[1])) === scriptFile) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`SEO built audit: ERROR\n${error instanceof Error ? error.stack : String(error)}`)
    process.exitCode = 1
  })
}
