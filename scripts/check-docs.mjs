import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const repoRoot = resolve(import.meta.dirname, "..")

const checks = [
  {
    file: "apps/web/content/docs/getting-started.mdx",
    patterns: ["dawn.config.ts"],
  },
  {
    file: "apps/web/content/docs/cli.mdx",
    patterns: ["dawn.config.ts", "appDir"],
  },
  {
    file: "apps/web/content/docs/dev-server.mdx",
    patterns: ["/agui/{routeId}", "@dawn-ai/ag-ui"],
  },
]

const failures = []

function walkFiles(dir, predicate, output = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next") continue
      walkFiles(full, predicate, output)
    } else if (predicate(full)) {
      output.push(full)
    }
  }
  return output
}

function relativeToRoot(filePath) {
  return filePath.replace(`${repoRoot}/`, "")
}

function isDraftBlogPost(filePath, source) {
  return filePath.includes("/apps/web/content/blog/") && /^draft:\s*true$/m.test(source)
}

function frontmatterDate(source) {
  const match = source.match(/^date:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})$/m)
  return match?.[1] ?? null
}

function packageManifests() {
  const packagesDir = resolve(repoRoot, "packages")
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, "package.json"))
    .filter((filePath) => existsSync(filePath))
}

function docHrefToContentPath(href) {
  const slug = href.replace(/^\/docs\/?/, "")
  return slug === "recipes"
    ? "apps/web/content/docs/recipes/index.mdx"
    : `apps/web/content/docs/${slug}.mdx`
}

function docHrefToPagePath(href) {
  const slug = href.replace(/^\/docs\/?/, "")
  return `apps/web/app/docs/${slug}/page.tsx`
}

for (const check of checks) {
  const filePath = resolve(repoRoot, check.file)
  const source = readFileSync(filePath, "utf8")

  for (const pattern of check.patterns) {
    if (!source.includes(pattern)) {
      failures.push(`${check.file} is missing required docs text: ${pattern}`)
    }
  }
}

// Docs topology check — every docs page in nav must have a content file and
// a matching app wrapper, and every internal docs link must point to a known
// docs page. This catches stale links when docs pages are split or moved.
const docsNavPath = resolve(repoRoot, "apps/web/app/components/docs/nav.ts")
const docsNav = readFileSync(docsNavPath, "utf8")
const navDocHrefs = [...docsNav.matchAll(/href:\s*"((?:\/docs\/)[^"]+)"/g)].map((m) => m[1])
const uniqueNavDocHrefs = [...new Set(navDocHrefs)]

for (const href of uniqueNavDocHrefs) {
  const contentPath = resolve(repoRoot, docHrefToContentPath(href))
  const pagePath = resolve(repoRoot, docHrefToPagePath(href))
  try {
    statSync(contentPath)
  } catch {
    failures.push(`DOCS_NAV references ${href}, but ${relativeToRoot(contentPath)} is missing`)
  }
  try {
    statSync(pagePath)
  } catch {
    failures.push(`DOCS_NAV references ${href}, but ${relativeToRoot(pagePath)} is missing`)
  }
}

// Error-code registry ↔ docs drift guard. Every registry `docsPath` must
// resolve to a real /docs/<slug> nav page, and /docs/errors must list exactly
// the registry's codes. Reuses docs-bundle nav parsing for page existence.
const sdkEntryUrl = pathToFileURL(resolve(repoRoot, "packages/sdk/dist/index.js")).href
const sdkEntry = await import(sdkEntryUrl).catch((error) => {
  failures.push(
    `Error-docs guard could not import packages/sdk/dist/index.js — did you run pnpm build? (${error.message})`,
  )
  return null
})
const docsBundleUrl = pathToFileURL(resolve(repoRoot, "packages/cli/dist/lib/docs-bundle.js")).href
const docsBundle = await import(docsBundleUrl).catch((error) => {
  failures.push(
    `Error-docs guard could not import packages/cli/dist/lib/docs-bundle.js — did you run pnpm build? (${error.message})`,
  )
  return null
})

if (sdkEntry?.DAWN_ERRORS && docsBundle?.parseNav) {
  const registry = sdkEntry.DAWN_ERRORS
  const codes = Object.keys(registry)
  const navSlugs = new Set(docsBundle.parseNav(docsNav).map((entry) => entry.slug))

  for (const code of codes) {
    const docsPath = registry[code].docsPath
    if (!docsPath) {
      continue
    }
    const slug = docsPath.replace(/^\/docs\//, "").replace(/#.*$/, "")
    if (!navSlugs.has(slug)) {
      failures.push(
        `DAWN_ERRORS.${code} docsPath ${docsPath} points at /docs/${slug}, which is not a known docs page`,
      )
    }
  }

  const errorsMdxPath = resolve(repoRoot, "apps/web/content/docs/errors.mdx")
  const errorsMdx = readFileSync(errorsMdxPath, "utf8")
  const listed = new Set([...errorsMdx.matchAll(/DAWN_E\d{4}/g)].map((m) => m[0]))
  const missing = codes.filter((code) => !listed.has(code))
  const extra = [...listed].filter((code) => !codes.includes(code))
  if (missing.length > 0) {
    failures.push(
      `apps/web/content/docs/errors.mdx is missing registry codes: ${missing.join(", ")} — run node scripts/generate-error-docs.mjs`,
    )
  }
  if (extra.length > 0) {
    failures.push(
      `apps/web/content/docs/errors.mdx lists codes not in the registry: ${extra.join(", ")} — run node scripts/generate-error-docs.mjs`,
    )
  }
}

// gpt-5-family example check — Dawn's docs convention is that OpenAI examples
// use only the gpt-5 family (canonical default gpt-5-mini); legacy OpenAI ids
// (gpt-4*, gpt-3*, o1*) must not appear as an example `model:` value. This is
// intentionally narrow: it only matches an OpenAI legacy id used as a
// `model:` value, so non-OpenAI provider ids (llama, claude, gemini, ...) are
// never flagged. `api.mdx` is the model-id REFERENCE page and intentionally
// lists legacy ids across every provider (for readers picking a provider), so
// it is excluded entirely.
const OPENAI_LEGACY_MODEL_RE = /model:\s*["'](gpt-4|gpt-3|o1)[^"']*["']/g
const docsContentDir = resolve(repoRoot, "apps/web/content/docs")
const apiMdxPath = resolve(docsContentDir, "api.mdx")
const docsMdxFiles = walkFiles(docsContentDir, (file) => file.endsWith(".mdx"))

for (const filePath of docsMdxFiles) {
  if (filePath === apiMdxPath) {
    continue
  }
  const source = readFileSync(filePath, "utf8")
  for (const match of source.matchAll(OPENAI_LEGACY_MODEL_RE)) {
    failures.push(
      `${relativeToRoot(filePath)} uses an OpenAI legacy model id as an example (\`${match[0]}\`) — docs examples must use the gpt-5 family (canonical default gpt-5-mini)`,
    )
  }
}

// CLI surface check — drive from the commander registry to catch docs drift.
// Every user-facing command name and every long option must be referenced in
// cli.mdx. The internal `dev-child` command is excluded (not user-facing).
const cliMdxPath = resolve(repoRoot, "apps/web/content/docs/cli.mdx")
const cliMdx = readFileSync(cliMdxPath, "utf8")

const cliEntryUrl = pathToFileURL(resolve(repoRoot, "packages/cli/dist/index.js")).href
const cliEntry = await import(cliEntryUrl).catch((error) => {
  failures.push(
    `CLI surface check could not import packages/cli/dist/index.js — did you run pnpm build? (${error.message})`,
  )
  return null
})

if (cliEntry?.createProgram) {
  const noopIo = {
    stdout: () => undefined,
    stderr: () => undefined,
  }
  const program = cliEntry.createProgram(noopIo)

  const HIDDEN_COMMANDS = new Set(["__dev-child"])

  for (const command of program.commands) {
    const name = command.name()
    if (HIDDEN_COMMANDS.has(name)) {
      continue
    }

    if (!cliMdx.includes(`dawn ${name}`)) {
      failures.push(
        `apps/web/content/docs/cli.mdx is missing reference to command \`dawn ${name}\``,
      )
    }

    for (const option of command.options) {
      const flag = option.long ?? option.short
      if (!flag) {
        continue
      }
      if (!cliMdx.includes(flag)) {
        failures.push(
          `apps/web/content/docs/cli.mdx is missing reference to \`${flag}\` (option of \`dawn ${name}\`)`,
        )
      }
    }
  }
}

// Public package docs check — every package manifest under packages/ must have
// a sibling README, and packages with source exports must be findable from
// either the API reference or their own README.
const apiMdx = readFileSync(resolve(repoRoot, "apps/web/content/docs/api.mdx"), "utf8")
for (const manifestPath of packageManifests()) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  const packageDir = manifestPath.replace(/\/package\.json$/, "")
  const relPackageDir = relativeToRoot(packageDir)
  const readmePath = join(packageDir, "README.md")
  if (!existsSync(readmePath)) {
    failures.push(`${relPackageDir} is missing README.md`)
    continue
  }

  const readme = readFileSync(readmePath, "utf8")
  if (typeof manifest.name === "string" && manifest.name.startsWith("@dawn-ai/")) {
    const sourceIndex = join(packageDir, "src", "index.ts")
    if (existsSync(sourceIndex)) {
      const source = readFileSync(sourceIndex, "utf8")
      const hasPublicExports = /^export\s/m.test(source)
      const mentionedInApi = apiMdx.includes(manifest.name)
      const mentionedInReadme = readme.includes(manifest.name)
      if (hasPublicExports && !mentionedInApi && !mentionedInReadme) {
        failures.push(
          `${relPackageDir} has public exports but is not mentioned in API docs or its README`,
        )
      }
    }
  }
}

// Dev-server endpoint coverage check. Keep explicit endpoint docs in step with
// runtime-server route additions that expose new client-facing protocols.
const runtimeServerSource = readFileSync(
  resolve(repoRoot, "packages/cli/src/lib/dev/runtime-server.ts"),
  "utf8",
)
const devServerDocs = readFileSync(
  resolve(repoRoot, "apps/web/content/docs/dev-server.mdx"),
  "utf8",
)
if (runtimeServerSource.includes("/agui/:routeId")) {
  for (const required of [
    "POST /agui/{routeId}",
    "%2Fchat%23agent",
    "@dawn-ai/ag-ui",
    "RunAgentInput.resume",
  ]) {
    if (!devServerDocs.includes(required)) {
      failures.push(
        `apps/web/content/docs/dev-server.mdx is missing AG-UI endpoint text: ${required}`,
      )
    }
  }
}

// Chart docs drift check — chart appVersion should track the current Dawn
// package train unless a chart intentionally documents otherwise.
const cliPackage = JSON.parse(readFileSync(resolve(repoRoot, "packages/cli/package.json"), "utf8"))
for (const chartYaml of ["charts/dawn-app/Chart.yaml", "charts/dawn-sandbox-infra/Chart.yaml"]) {
  const source = readFileSync(resolve(repoRoot, chartYaml), "utf8")
  const match = source.match(/^appVersion:\s*["']?([^"'\n]+)["']?$/m)
  if (match?.[1] !== cliPackage.version) {
    failures.push(
      `${chartYaml} appVersion (${match?.[1] ?? "missing"}) does not match @dawn-ai/cli ${cliPackage.version}`,
    )
  }
}

const userFacingRoots = [
  "README.md",
  "CONTRIBUTING.md",
  "CONTRIBUTORS.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "apps/web/app",
  "apps/web/content",
  "docs",
  "packages",
]

const forbiddenContent = [
  {
    pattern: /dawn-ai\.org/,
    message: "uses the retired dawn-ai.org domain",
  },
  {
    pattern:
      /dawn run ['"](?:\/hello\/acme|hello\/\[tenant\]|\/support\/acme|\/support\/\[tenant\]\/research)['"]/,
    message: "uses a concrete dynamic route instead of the parameterized route id with JSON input",
  },
  {
    pattern: /export default (?:graph|chain)\b/,
    message: "uses a default graph/chain route export instead of named route exports",
  },
  {
    pattern: /route_path["']?\s*:\s*["']\/[^"']+/,
    message: "uses a route_path value that is not the source entry file path",
  },
  {
    pattern: /(^|[^/.])dawn\.generated\.d\.ts/,
    message: "references dawn.generated.d.ts without the .dawn/ directory",
    shouldCheck: (filePath) => /\.(md|mdx|tape)$/.test(filePath),
  },
  {
    pattern: /dawn test --url/,
    message: "uses the removed command-level dawn test --url flag",
  },
  {
    pattern: /agent\.bindTools/,
    message: "describes generated agent entries with the old bindTools path",
  },
  {
    pattern: /\.dawn\/generated/,
    message: "references the old generated types directory",
  },
  {
    pattern: /openai:gpt/,
    message: "uses provider-prefixed OpenAI model ids in Dawn agent examples",
  },
  {
    pattern:
      /speaks the LangSmith protocol natively|What works locally works in production|without translation|byte-identical/,
    message: "overstates local/prod protocol or deployment parity",
  },
  {
    pattern: /auto-bound|auto-registered/,
    message: "uses old tool auto-binding wording",
  },
  {
    pattern: /pgvector is a planned follow-up backend/,
    message: "describes pgvector as planned even though @dawn-ai/memory-pgvector ships",
    shouldCheck: (filePath) => !/CHANGELOG\.md$/.test(filePath),
  },
]

const userFacingFiles = []
for (const root of userFacingRoots) {
  const full = resolve(repoRoot, root)
  const stat = statSync(full)
  if (stat.isDirectory()) {
    walkFiles(
      full,
      (file) =>
        /\.(md|mdx|ts|tsx|mjs|js|json|tape)$/.test(file) &&
        !file.includes("/docs/superpowers/") &&
        !file.includes("/packages/create-dawn-app/dist/"),
      userFacingFiles,
    )
  } else {
    userFacingFiles.push(full)
  }
}

const knownDocHrefs = new Set(uniqueNavDocHrefs)
for (const filePath of userFacingFiles) {
  const source = readFileSync(filePath, "utf8")
  const links = source.matchAll(/(?:href:\s*|]\()["']?(\/docs\/[^"',)\s#}]+)/g)
  for (const match of links) {
    const href = match[1]
    if (href && !knownDocHrefs.has(href)) {
      failures.push(`${relativeToRoot(filePath)} links to unknown docs page ${href}`)
    }
  }
}

const today = new Date().toISOString().slice(0, 10)
for (const filePath of userFacingFiles) {
  const source = readFileSync(filePath, "utf8")
  if (isDraftBlogPost(filePath, source)) {
    continue
  }

  for (const { pattern, message, shouldCheck } of forbiddenContent) {
    if (typeof shouldCheck === "function" && !shouldCheck(filePath)) {
      continue
    }
    if (pattern.test(source)) {
      failures.push(`${relativeToRoot(filePath)} ${message}`)
    }
  }

  if (filePath.includes("/apps/web/content/blog/")) {
    const date = frontmatterDate(source)
    if (date && date > today) {
      failures.push(
        `${relativeToRoot(filePath)} is future-dated (${date}) but is not marked draft: true`,
      )
    }
  }
}

if (failures.length > 0) {
  console.error("Docs completeness check failed.")
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log("Docs completeness check passed.")
