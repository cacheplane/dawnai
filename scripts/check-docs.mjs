import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { NodeFlags, SyntaxKind } from "typescript/unstable/ast"
import {
  isAssertionExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isStringLiteral,
  isVariableStatement,
} from "typescript/unstable/ast/is"
import { createVirtualFileSystem } from "typescript/unstable/fs"
import { API } from "typescript/unstable/sync"

const repoRoot = resolve(import.meta.dirname, "..")

function maskText(value) {
  return value.replace(/[^\r\n]/g, " ")
}

function maskFencedCode(source) {
  let fence = null
  return source
    .split(/(?<=\n)/)
    .map((line) => {
      const content = line.replace(/\r?\n$/, "")
      if (fence) {
        const activeFence = fence
        const closingRun = /^[ \t]{0,3}([`~]+)[ \t]*$/.exec(content)?.[1]
        const closesFence =
          closingRun !== undefined &&
          closingRun.length >= activeFence.length &&
          [...closingRun].every((character) => character === activeFence.character)
        if (closesFence) fence = null
        return maskText(line)
      }

      const opening = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(content)?.[1]
      if (!opening) return line
      fence = { character: opening[0], length: opening.length }
      return maskText(line)
    })
    .join("")
}

function maskRange(characters, start, end) {
  for (let index = start; index < end; index++) {
    if (characters[index] !== "\r" && characters[index] !== "\n") characters[index] = " "
  }
}

function inlineCodeEnd(source, start, delimiterLength) {
  let index = start + delimiterLength
  while (index < source.length && source[index] !== "\r" && source[index] !== "\n") {
    if (source[index] !== "`") {
      index++
      continue
    }
    let runEnd = index
    while (source[runEnd] === "`") runEnd++
    if (runEnd - index === delimiterLength) return runEnd
    index = runEnd
  }
  return -1
}

function maskInlineCodeAndComments(source) {
  const characters = source.split("")
  let index = 0
  while (index < source.length) {
    if (source.startsWith("<!--", index)) {
      const closing = source.indexOf("-->", index + 4)
      const end = closing === -1 ? source.length : closing + 3
      maskRange(characters, index, end)
      index = end
      continue
    }
    if (source.startsWith("{/*", index)) {
      const closing = source.indexOf("*/}", index + 3)
      const end = closing === -1 ? source.length : closing + 3
      maskRange(characters, index, end)
      index = end
      continue
    }
    if (source[index] === "`") {
      let runEnd = index
      while (source[runEnd] === "`") runEnd++
      const end = inlineCodeEnd(source, index, runEnd - index)
      if (end !== -1) {
        maskRange(characters, index, end)
        index = end
        continue
      }
      index = runEnd
      continue
    }
    index++
  }
  return characters.join("")
}

function maskMarkdownCodeAndComments(source) {
  return maskInlineCodeAndComments(maskFencedCode(source))
}

function maskLeadingYamlFrontmatter(source) {
  const opening = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.exec(source)
  if (!opening) return source

  const remainder = source.slice(opening[0].length)
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(remainder)
  if (closing?.index === undefined) return source

  const characters = source.split("")
  maskRange(characters, 0, opening[0].length + closing.index + closing[0].length)
  return characters.join("")
}

function codeSpanDelimiterLength(source, start) {
  let end = start
  while (source[end] === "`") end++
  return end - start
}

function normalizeCodeSpans(source) {
  let normalized = ""
  let index = 0
  while (index < source.length) {
    if (source[index] !== "`") {
      normalized += source[index]
      index++
      continue
    }

    const delimiterLength = codeSpanDelimiterLength(source, index)
    let closingIndex = index + delimiterLength
    while (closingIndex < source.length) {
      const candidate = source.indexOf("`", closingIndex)
      if (candidate === -1) break
      const candidateLength = codeSpanDelimiterLength(source, candidate)
      if (candidateLength === delimiterLength) {
        let content = source.slice(index + delimiterLength, candidate).replace(/\r\n?|\n/g, " ")
        if (content.startsWith(" ") && content.endsWith(" ") && /[^ ]/.test(content)) {
          content = content.slice(1, -1)
        }
        normalized += content
        index = candidate + delimiterLength
        closingIndex = -1
        break
      }
      closingIndex = candidate + candidateLength
    }

    if (closingIndex !== -1) {
      normalized += "`".repeat(delimiterLength)
      index += delimiterLength
    }
  }
  return normalized
}

function normalizeAtxHeading(line) {
  const content = line
    .replace(/^[ \t]{0,3}#[ \t]+/, "")
    .replace(/[ \t]+#+[ \t]*$/, "")
    .trim()
  return normalizeCodeSpans(content)
}

function firstRenderedMdxH1(source) {
  const masked = maskMarkdownCodeAndComments(maskLeadingYamlFrontmatter(source))
  const heading = /^[ \t]{0,3}#[ \t]+/m.exec(masked)
  if (heading?.index === undefined) return null

  const lineEnd = source.indexOf("\n", heading.index)
  return normalizeAtxHeading(source.slice(heading.index, lineEnd === -1 ? source.length : lineEnd))
}

function unwrapExpression(expression) {
  let current = expression
  while (
    isParenthesizedExpression(current) ||
    isAssertionExpression(current) ||
    isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function exportedMetadataTitle(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!isVariableStatement(statement)) continue
    if (!statement.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword))
      continue
    if (!(statement.declarationList.flags & NodeFlags.Const)) continue

    for (const declaration of statement.declarationList.declarations) {
      if (!isIdentifier(declaration.name) || declaration.name.text !== "metadata") continue
      if (!declaration.initializer) return null
      const initializer = unwrapExpression(declaration.initializer)
      if (!isObjectLiteralExpression(initializer)) return null

      for (const property of initializer.properties) {
        if (!isPropertyAssignment(property)) continue
        const name = property.name
        if ((!isIdentifier(name) && !isStringLiteral(name)) || name.text !== "title") continue
        const title = unwrapExpression(property.initializer)
        return isStringLiteral(title) ? title.text : null
      }
      return null
    }
  }
  return null
}

function exportedMetadataTitles(sources) {
  const wrapperPaths = sources.map((_, index) => `/wrapper-${index}.tsx`)
  const virtualFiles = Object.fromEntries(
    wrapperPaths.map((wrapperPath, index) => [wrapperPath, sources[index]]),
  )
  virtualFiles["/tsconfig.json"] = JSON.stringify({
    compilerOptions: { jsx: "preserve", noLib: true },
    files: wrapperPaths,
  })

  const api = new API({ cwd: "/", fs: createVirtualFileSystem(virtualFiles) })
  let snapshot
  try {
    snapshot = api.updateSnapshot({ openProjects: ["/tsconfig.json"] })
    return wrapperPaths.map((wrapperPath) => {
      const project = snapshot.getDefaultProjectForFile(wrapperPath)
      const sourceFile = project?.program.getSourceFile(wrapperPath)
      return sourceFile ? exportedMetadataTitle(sourceFile) : null
    })
  } finally {
    snapshot?.dispose()
    api.close()
  }
}

function analyzeDocTitlesBatch(fixtures) {
  const metadataTitles = exportedMetadataTitles(fixtures.map(({ wrapperSource }) => wrapperSource))
  return fixtures.map(({ mdxSource }, index) => ({
    firstH1: firstRenderedMdxH1(mdxSource),
    metadataTitle: metadataTitles[index] ?? null,
  }))
}

function analyzeDocTitles(fixture) {
  return analyzeDocTitlesBatch([fixture])[0]
}

function isMarkdownImage(source, linkStart) {
  if (source[linkStart - 1] !== "!") return false
  let backslashes = 0
  for (let index = linkStart - 2; index >= 0 && source[index] === "\\"; index--) backslashes++
  return backslashes % 2 === 0
}

function linkDestinations(source) {
  const masked = maskMarkdownCodeAndComments(source)
  const destinations = []
  const markdownLink = /\[[^\]\r\n]*\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
  for (const match of masked.matchAll(markdownLink)) {
    if (match[1] && !isMarkdownImage(masked, match.index)) {
      destinations.push({ index: match.index, destination: match[1] })
    }
  }
  for (const match of masked.matchAll(/\bhref\s*(?::|=)\s*["']([^"']+)["']/g)) {
    if (match[1]) {
      destinations.push({ index: match.index, destination: match[1] })
    }
  }
  return destinations
    .sort((left, right) => left.index - right.index)
    .map(({ destination }) => destination)
}

function analyzeCompatibilityStub({ source, retainedHeading, canonicalHref, maxChars = 600 }) {
  const headingSource = maskMarkdownCodeAndComments(source)
  const headings = [...headingSource.matchAll(/^(#{1,6})\s+(.+?)[ \t]*$/gm)].map((match) => {
    const lineEnd = source.indexOf("\n", match.index)
    const originalLine = source.slice(match.index, lineEnd === -1 ? source.length : lineEnd)
    return {
      index: match.index,
      level: match[1].length,
      // Heading discovery uses the masked source so fences/comments cannot
      // create boundaries, but matching uses the original line so inline-code
      // delimiters remain part of an exact retained heading contract.
      text: originalLine
        .replace(/^#{1,6}\s+/, "")
        .replace(/[ \t]+#+[ \t]*$/, "")
        .trim(),
    }
  })
  const headingIndex = headings.findIndex((heading) => heading.text === retainedHeading)
  if (headingIndex === -1) {
    return {
      found: false,
      stub: "",
      destinations: [],
      charCount: 0,
      maxChars,
      hasCanonicalLink: false,
      exceedsMaxChars: false,
    }
  }

  const heading = headings[headingIndex]
  const nextHeading = headings
    .slice(headingIndex + 1)
    .find((candidate) => candidate.level <= heading.level)
  const stub = source.slice(heading.index, nextHeading?.index ?? source.length).trim()
  const destinations = linkDestinations(stub)
  return {
    found: true,
    stub,
    destinations,
    charCount: stub.length,
    maxChars,
    hasCanonicalLink: destinations.includes(canonicalHref),
    exceedsMaxChars: stub.length > maxChars,
  }
}

if (process.argv[2] === "--analyze-compatibility-stub") {
  const fixture = JSON.parse(process.argv[3] ?? "{}")
  process.stdout.write(`${JSON.stringify(analyzeCompatibilityStub(fixture))}\n`)
  process.exit(0)
}

if (process.argv[2] === "--analyze-doc-titles") {
  const fixture = JSON.parse(process.argv[3] ?? "{}")
  const analysis = Array.isArray(fixture)
    ? analyzeDocTitlesBatch(fixture)
    : analyzeDocTitles(fixture)
  process.stdout.write(`${JSON.stringify(analysis)}\n`)
  process.exit(0)
}

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
    file: "apps/web/content/docs/ag-ui.mdx",
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

const accuracyContracts = [
  {
    file: "apps/web/content/docs/persistence.mdx",
    required: [
      "checkpoints",
      "thread metadata",
      "permission",
      "long-term memory",
      "workspace files",
      "sandbox volumes",
      "does not automatically",
      "once at Node boot",
      "does not auto-refresh",
      "application owns the refresh",
      "retention",
      "backup",
      "encryption",
      "not transactional",
      "metadata first",
      "prevent sandbox cleanup",
      "204",
      "reconciliation",
      "idempotent retry",
      "does not cancel",
      "does not wait",
      "quiesce",
      "owning process",
      "settled before",
      "later checkpoint writes",
      "sandbox destruction can race",
      "successful cancel",
      "does not prove route completion",
      "204 confirms only the sequential cleanup calls",
    ],
    forbidden: ["thread deletion removes all", "performs best-effort checkpoint deletion"],
  },
  {
    file: "apps/web/content/docs/production-topology.mdx",
    required: [
      "process-local",
      "shared durable stores",
      "thread-aware",
      "/healthz",
      "does not prove",
      "does not currently install signal handlers",
    ],
    forbidden: [
      "HPA makes",
      "generated server handles graceful termination",
      "graceful termination is automatic",
    ],
  },
  {
    file: "apps/web/content/docs/security-architecture.mdx",
    required: [
      "outer authentication",
      "tenant",
      "/threads/:thread_id/cancel",
      "/memory/candidates",
      "bypass",
      "authored tools",
      "build artifact",
    ],
    forbidden: ["middleware protects every", "thread ID is an authorization"],
  },
  {
    file: "apps/web/content/docs/embedding.mdx",
    required: [
      "serveRuntime",
      "@dawn-ai/cli/fetch",
      "@dawn-ai/cli/runtime",
      "lower-level tooling surface",
      'app.route("/", dawnApp)',
      '"/my-app"',
      "/healthz",
      "/threads",
      "/agui",
      "/memory",
      "close()",
      "let handlerPromise",
      "handlerPromise ??= createRuntimeFetchHandler",
      "handlerPromise = undefined",
      "must exactly match",
      "await permissionsStore.load()",
      "type PostgresPermissionsStoreOptions,",
      "type PermissionPolicy = Required<",
      'Pick<PostgresPermissionsStoreOptions, "mode" | "config">',
      "mode: policy.mode",
      "config: policy.config",
      "used as-is",
      "does not call `load()`",
      "does not reapply sibling",
      "mode, static allow/deny policy, hydration, refresh, and disposal",
      "made ready and migrated, but it is not hydrated",
      "omits the resolved mode and config-seeded allow/deny",
      "persisted interactive grants",
      "await handler.close()",
      "await pool.end()",
      "await pool.end().catch(() => undefined)",
    ],
    forbidden: [
      'from "@dawn-ai/cli/runtime"',
      "app.mount(",
      'app.route("/dawn"',
      "const handler = await createRuntimeFetchHandler",
      'mode: "interactive"',
      'from "@dawn-ai/permissions"',
    ],
  },
  {
    file: "apps/web/content/docs/recipes/typed-state.mdx",
    required: [
      "tenant: z.string()",
      "input: unknown",
      "workflow imports and parses",
      "agent-state discovery",
    ],
    forbidden: ["input: HelloInput", "[tenant] is injected from the pathname"],
  },
  {
    file: "apps/web/content/docs/recipes/stream-output.mdx",
    required: ['input: { messages: [{ role: "user"', 'typeof payload === "string"'],
    forbidden: ["payload.content"],
  },
  {
    file: "apps/web/content/docs/state.mdx",
    required: [
      'tenant: z.string().default("")',
      'import state from "./state.js"',
      "input: unknown",
      "state.parse(input)",
      "Plain workflows must parse",
      "validating `{}`",
      "rejects `{}`",
      "is skipped",
    ],
    forbidden: ["tenant: z.string(),", 'Zod-parsed default `""` is applied when caller omits it'],
  },
  {
    file: "apps/web/content/docs/testing-agents.mdx",
    required: ['title="test/agent.test.ts"', 'new URL("..", import.meta.url)'],
    forbidden: ['title="src/app/chat/agent.test.ts"', 'new URL("../..", import.meta.url)'],
  },
  {
    file: "apps/web/content/docs/tools.mdx",
    required: [
      "src/tools/",
      "capability tools",
      "callable `graph` function",
      "precompiled raw LangGraph object",
      "RunnableConfig",
      "owns or imports",
      'import state from "./state.js"',
      "export async function workflow(\n  input: unknown,",
      "const parsed = state.parse(input)",
      "tenant: parsed.tenant",
      "return { ...parsed, greeting:",
    ],
    forbidden: [
      "only its own route-local `tools/*.ts`",
      "inside `workflow`/`graph` route entries",
      "Inside a `workflow` or `graph` route",
      "imports its own tools instead",
      'import type state from "./state.js"',
      "state: HelloState",
    ],
  },
  {
    file: "apps/web/content/docs/deployment.mdx",
    required: [
      "/docs/deployment/node",
      "/docs/deployment/kubernetes",
      "/docs/deployment/langsmith",
      "/docs/deployment/edge",
      "Specifying build targets replaces",
    ],
    forbidden: ["backend that does not exist yet"],
  },
  {
    file: "apps/web/content/docs/deployment/node.mdx",
    required: [
      "Node 24",
      ".dawn/build/server.mjs",
      "127.0.0.1:8000:8000",
      "does not currently install signal handlers",
      "COPY . .",
      "chown -R 1000:1000 /app/.dawn",
      "USER 1000:1000",
      "/app/workspace",
      "root-owned",
      "EACCES",
      "COPY --chown",
    ],
    forbidden: ["Node 22"],
  },
  {
    file: "apps/web/content/docs/deployment/kubernetes.mdx",
    required: [
      "liveness",
      "not dependency readiness",
      "dawn-sandboxes",
      "dawn-orchestrator",
      "shared durable stores",
      "thread-aware",
      "No orchestrator RoleBinding is needed",
    ],
    forbidden: ["/healthz proves dependency readiness", "HPA makes"],
  },
  {
    file: "apps/web/content/docs/deployment/langsmith.mdx",
    required: [
      'node_version: "22"',
      "Node 24",
      "does not include",
      "middleware",
      "AG-UI",
      "sandbox",
    ],
    forbidden: ["same runtime"],
  },
  {
    file: "apps/web/content/docs/deployment/edge.mdx",
    required: [
      "modules.edge.mjs",
      '"/my-app"',
      "app.route",
      "DAWN_E1005",
      "local workerd",
      "not a live",
      "transitive dependency",
      "`DAWN_E1005` checks only Dawn-known capabilities",
      "arbitrary Node built-ins",
      "not guaranteed to be free of Node built-ins",
      '```js title="host.mjs"',
    ],
    forbidden: ["Nothing else is gated", '```ts title="host.ts"'],
  },
  {
    file: "charts/dawn-app/README.md",
    required: [
      "Scaling requirements",
      ".dawn/build/server.mjs",
      "helm lint --strict",
      "returns zero with that warning",
      "helm template",
      "fails when `image.repository` is unset",
    ],
    forbidden: [
      "backend that does not exist yet",
      "until a shared threads and checkpoint backend ships",
      "langgraphjs dockerfile",
      "langgraphjs-built image",
      "image built the alternate way",
      "containerize the `langsmith` target",
    ],
  },
  {
    file: "charts/dawn-app/values.yaml",
    required: [".dawn/build/server.mjs"],
    forbidden: [
      "langgraphjs dockerfile",
      "langgraphjs-built image",
      "image built the alternate way",
      "containerize the langsmith target",
    ],
  },
  {
    file: "apps/web/content/docs/dev-server.mdx",
    required: [
      "not blanket server authentication",
      "/threads/:thread_id/cancel",
      "/memory/candidates",
      "spans namespaces",
      "entire service",
      "parent watcher/session keeps the same URL",
      "child owns the HTTP listener",
      "default SQLite",
    ],
    forbidden: [
      "parent owns the HTTP server",
      "parent HTTP server is unaffected",
      "parent process keeps the HTTP server alive",
    ],
  },
  {
    file: "apps/web/content/prompts/index.ts",
    required: [
      "dawn start",
      'targets: ["node"]',
      "scenarios(",
      ".server(",
      'topic: z.string().default("")',
      'import state from "./state.js"',
      "input: unknown",
      "state.parse(input)",
      "callable \\`graph\\` function",
      "precompiled raw LangGraph object",
      "RunnableConfig",
      "owns or imports",
      "return { ...parsed, result: parsed.topic }",
    ],
    forbidden: [
      "Dawn itself is not a production runtime",
      "For a \\`workflow\\` or \\`graph\\` route",
      "ctx.tools.<toolName>",
      "topic: z.string(),",
    ],
  },
  {
    file: "apps/web/app/llms.txt/route.ts",
    required: [
      "dawn start",
      "dawn inspect",
      "/threads/:thread_id/cancel",
      "fetch and print an integration blueprint",
      "`dawn add` — list the blueprint catalog",
      "five phases",
      "runtime readiness",
      "middleware-bypassing management routes",
      "entire service",
    ],
    forbidden: ["Production runs on LangSmith or another runtime"],
  },
  {
    file: "apps/web/content/blueprints/retrieval/pgvector.md",
    required: [
      "callable `graph` function",
      "precompiled raw LangGraph object",
      "RunnableConfig",
      "owns or imports",
    ],
    forbidden: ["workflow and `graph` routes can call it through `ctx.tools`"],
  },
  {
    file: "apps/web/content/blueprints/retrieval/pinecone.md",
    required: [
      "callable `graph` function",
      "precompiled raw LangGraph object",
      "RunnableConfig",
      "owns or imports",
    ],
    forbidden: ["workflow and `graph` routes can call it through `ctx.tools`"],
  },
  {
    file: "apps/web/content/docs/migrating-from-langgraph.mdx",
    required: [
      "configurable.thread_id",
      "does not translate",
      "wrapper or configuration adaptation",
      "validate that target boundary",
    ],
    forbidden: [
      "the checkpointer, LangSmith — none of it changes",
      "LangSmith, the checkpointer, model providers, every LangChain package — unchanged",
      "Whatever you pass to `.compile({ checkpointer })` keeps working",
    ],
  },
  {
    file: "apps/web/app/components/landing/KeepTheRuntime.tsx",
    required: [
      "Node and Hono targets are Dawn HTTP runtimes",
      "LangSmith target emits graph",
      "Agent routes materialize LangGraph graphs",
      "raw graph and chain exports remain portable",
    ],
    forbidden: [
      "Dawn is not a runtime",
      "Dawn compiles to LangGraph constructs",
      "Routes become nodes",
    ],
  },
  {
    file: "apps/web/app/components/landing/WhyDawn.tsx",
    required: [
      "Node and Hono HTTP runtimes",
      "raw graph and chain exports stay portable",
      "durable stores",
    ],
    forbidden: [
      "Dawn is not a runtime",
      "persisted state available across child-runtime restarts.",
    ],
  },
  {
    file: "apps/web/app/components/landing/FeatureRouting.tsx",
    required: ["Agent routes materialize as LangGraph graphs", "keep their authored entry form"],
    forbidden: ["Dawn wires it into the graph", "routes compile to plain LangGraph"],
  },
  {
    file: "apps/web/app/components/landing/FeatureDevLoop.tsx",
    required: [
      "restarts the child runtime",
      "parent watcher/session",
      "child-owned HTTP listener restarts",
      "default SQLite",
    ],
    forbidden: [
      "parent listener stays up",
      "Stable parent listener",
      "persisted thread/checkpoint state remains available",
      "only schema-incompatible",
      "First compile in ~400ms",
      "incremental in tens of ms",
    ],
  },
  {
    file: "apps/web/app/components/landing/DevLoopAnimation.tsx",
    required: [
      "Parent watcher/session keeps the same URL",
      "Restarting child HTTP runtime",
      "Child HTTP listener ready",
      "Default SQLite thread/checkpoint state",
    ],
    forbidden: [
      "Compiled in 412ms",
      "Graph state preserved across reload",
      "Updated route /support in 87ms",
      "updated in 31ms",
      "compiled in 22ms",
    ],
  },
  {
    file: "apps/web/content/blueprints/deploy/docker.md",
    required: [".dawn/build/server.mjs", "node:24-slim"],
    forbidden: ["Dawn has no standalone server", "Dawn's default deploy target"],
  },
  {
    file: "apps/web/app/llms-full.txt/route.ts",
    required: ["historical", "non-normative"],
    forbidden: [],
  },
]

for (const contract of accuracyContracts) {
  const filePath = resolve(repoRoot, contract.file)
  if (!existsSync(filePath)) {
    failures.push(`${contract.file} is missing`)
    continue
  }
  const source = readFileSync(filePath, "utf8")

  for (const required of contract.required) {
    if (!source.includes(required)) {
      failures.push(`${contract.file} is missing required accuracy text: ${required}`)
    }
  }

  for (const forbidden of contract.forbidden) {
    if (source.includes(forbidden)) {
      failures.push(`${contract.file} retains forbidden accuracy text: ${forbidden}`)
    }
  }

  // Future file-specific contracts can reject non-literal prose, for example
  // forbiddenRegexes: [/\b\d+\s+(?:HTTP\s+)?endpoints\b/i] on Agent Protocol.
  for (const forbiddenRegex of contract.forbiddenRegexes ?? []) {
    forbiddenRegex.lastIndex = 0
    const retainsForbiddenText = forbiddenRegex.test(source)
    forbiddenRegex.lastIndex = 0
    if (retainsForbiddenText) {
      failures.push(`${contract.file} retains forbidden accuracy text: ${forbiddenRegex}`)
    }
  }
}

// Every dawn-app installation example must select the image that the guide
// built, rather than silently falling back to the chart's AppVersion. Keep the
// expected command counts exact so a new unpinned example cannot hide beside
// an older pinned one.
const helmInstallExampleContracts = [
  { file: "apps/web/content/docs/deployment/kubernetes.mdx", expectedCount: 3 },
  {
    file: "charts/dawn-app/README.md",
    expectedCount: 2,
    requiredInEveryCommand: [
      "--namespace dawn-sandboxes",
      "--set image.repository=ghcr.io/you/your-app",
      "--set image.tag=2026-08-10",
    ],
  },
]

for (const { file, expectedCount, requiredInEveryCommand = [] } of helmInstallExampleContracts) {
  const source = readFileSync(resolve(repoRoot, file), "utf8")
  const commands = [
    ...source.matchAll(/^helm (?:install|upgrade --install) dawn-app\b[\s\S]*?(?=\n\n|```)/gm),
  ].map((match) => match[0])
  if (commands.length !== expectedCount) {
    failures.push(
      `${file} contains ${commands.length} dawn-app install examples; expected exactly ${expectedCount}`,
    )
  }
  for (const [index, command] of commands.entries()) {
    if (!/--set image\.(?:tag|digest)=\S+/.test(command)) {
      failures.push(
        `${file} dawn-app install example ${index + 1} does not pin image.tag or image.digest`,
      )
    }
    for (const required of requiredInEveryCommand) {
      if (!command.includes(required)) {
        failures.push(`${file} dawn-app install example ${index + 1} is missing: ${required}`)
      }
    }
  }
}

const chartReadmeSource = readFileSync(resolve(repoRoot, "charts/dawn-app/README.md"), "utf8")
for (const required of [
  "dawn check",
  "dawn build",
  "docker build -t ghcr.io/you/your-app:2026-08-10 .",
  "docker push ghcr.io/you/your-app:2026-08-10",
  "helm upgrade --install dawn-sandbox-infra",
]) {
  if (!chartReadmeSource.includes(required)) {
    failures.push(`charts/dawn-app/README.md copy-complete install prerequisite missing: ${required}`)
  }
}
if (chartReadmeSource.includes("--set image.tag=latest")) {
  failures.push("charts/dawn-app/README.md install examples must not use mutable image.tag=latest")
}

const kubernetesDeploymentSource = readFileSync(
  resolve(repoRoot, "apps/web/content/docs/deployment/kubernetes.mdx"),
  "utf8",
)
const crossNamespaceRoleBinding = kubernetesDeploymentSource.indexOf(
  "helm upgrade dawn-sandbox-infra oci://ghcr.io/cacheplane/charts/dawn-sandbox-infra",
)
const crossNamespaceAppInstall = kubernetesDeploymentSource.indexOf(
  "helm upgrade --install dawn-app oci://ghcr.io/cacheplane/charts/dawn-app",
  kubernetesDeploymentSource.indexOf("For a separate application namespace"),
)
if (crossNamespaceRoleBinding === -1 || crossNamespaceAppInstall === -1) {
  failures.push(
    "apps/web/content/docs/deployment/kubernetes.mdx must show both cross-namespace RoleBinding update and app install",
  )
} else if (crossNamespaceRoleBinding > crossNamespaceAppInstall) {
  failures.push(
    "apps/web/content/docs/deployment/kubernetes.mdx must update the cross-namespace RoleBinding before installing the app ServiceAccount",
  )
}
for (const required of ["future ServiceAccount", "Ready-but-sandbox-broken"]) {
  if (!kubernetesDeploymentSource.includes(required)) {
    failures.push(
      `apps/web/content/docs/deployment/kubernetes.mdx cross-namespace ordering explanation missing: ${required}`,
    )
  }
}
const noSandboxInstall = [
  ...kubernetesDeploymentSource.matchAll(
    /^helm (?:install|upgrade --install) dawn-app\b[\s\S]*?(?=\n\n|```)/gm,
  ),
]
  .map((match) => match[0])
  .find((command) => command.includes("--set automountServiceAccountToken=false"))

if (!noSandboxInstall) {
  failures.push(
    "apps/web/content/docs/deployment/kubernetes.mdx is missing a complete no-sandbox dawn-app install with automountServiceAccountToken=false",
  )
} else {
  for (const required of [
    "--namespace my-app",
    "--set image.repository=ghcr.io/you/my-dawn-app",
    "--set image.tag=2026-08-10",
    "--set serviceAccount.create=true",
    "--set serviceAccount.name=dawn-app",
  ]) {
    if (!noSandboxInstall.includes(required)) {
      failures.push(
        `apps/web/content/docs/deployment/kubernetes.mdx no-sandbox install is missing: ${required}`,
      )
    }
  }
}

// Compatibility stubs keep a moved heading linkable without allowing the old
// overview to grow back into a second copy of the canonical guide.
const compatibilityStubContracts = [
  {
    file: "apps/web/content/docs/deployment.mdx",
    retainedHeading: "Deploying to production (Node/Docker)",
    canonicalHref: "/docs/deployment/node",
  },
  {
    file: "apps/web/content/docs/deployment.mdx",
    retainedHeading: "Deploying on Kubernetes",
    canonicalHref: "/docs/deployment/kubernetes",
  },
  {
    file: "apps/web/content/docs/deployment.mdx",
    retainedHeading: "The LangSmith / LangGraph Platform path",
    canonicalHref: "/docs/deployment/langsmith",
  },
  {
    file: "apps/web/content/docs/deployment.mdx",
    retainedHeading: "Edge runtimes",
    canonicalHref: "/docs/deployment/edge",
  },
  {
    file: "apps/web/content/docs/deployment.mdx",
    retainedHeading: "The `@dawn-ai/cli/fetch` entry point",
    canonicalHref: "/docs/deployment/edge",
  },
  {
    file: "apps/web/content/docs/deployment.mdx",
    retainedHeading: "The `hono` build target",
    canonicalHref: "/docs/deployment/edge",
  },
  {
    file: "apps/web/content/docs/deployment.mdx",
    retainedHeading: "Why the stores are per-request",
    canonicalHref: "/docs/deployment/edge",
  },
  {
    file: "apps/web/content/docs/deployment.mdx",
    retainedHeading: "What the edge cannot serve",
    canonicalHref: "/docs/deployment/edge",
  },
  {
    file: "apps/web/content/docs/deployment.mdx",
    retainedHeading: "What is proven, and what is not",
    canonicalHref: "/docs/deployment/edge",
  },
]

for (const { file, retainedHeading, canonicalHref, maxChars = 600 } of compatibilityStubContracts) {
  const filePath = resolve(repoRoot, file)
  if (!existsSync(filePath)) {
    failures.push(`${file} is missing`)
    continue
  }

  const source = readFileSync(filePath, "utf8")
  const analysis = analyzeCompatibilityStub({ source, retainedHeading, canonicalHref, maxChars })
  if (!analysis.found) {
    failures.push(`${file} is missing compatibility heading: ${retainedHeading}`)
    continue
  }

  if (!analysis.hasCanonicalLink) {
    failures.push(
      `${file} compatibility heading ${retainedHeading} is missing canonical link: ${canonicalHref}`,
    )
  }
  if (analysis.exceedsMaxChars) {
    failures.push(
      `${file} compatibility heading ${retainedHeading} is ${analysis.charCount} characters (max ${maxChars})`,
    )
  }
}

// Current scaffold CTAs must include both the package tag and a target directory.
// Keep this scoped to active website surfaces so historical snapshots remain intact.
const targetBearingCtaFiles = [
  "apps/web/app/components/HeaderInner.tsx",
  "apps/web/app/components/MobileMenu.tsx",
  "apps/web/app/components/landing/Hero.tsx",
  "apps/web/app/components/landing/FinalCta.tsx",
  "apps/web/app/components/landing/Quickstart.tsx",
  "apps/web/app/opengraph-image.tsx",
]
const canonicalScaffoldCommand = "npm create dawn-ai-app@latest my-agent"
const targetlessScaffoldCommand = /\b(?:npm|pnpm) create dawn-ai-app(?!@latest my-agent)\b/

for (const file of targetBearingCtaFiles) {
  const source = readFileSync(resolve(repoRoot, file), "utf8")
  if (!source.includes(canonicalScaffoldCommand)) {
    failures.push(`${file} is missing the canonical target-bearing scaffold command`)
  }
  if (targetlessScaffoldCommand.test(source)) {
    failures.push(`${file} retains a targetless scaffold command`)
  }
}

// Scenario examples in current docs must use the typed builder API. Historical
// blog posts are intentionally outside this contract and remain non-normative.
const normativeScenarioFiles = [
  ...walkFiles(resolve(repoRoot, "apps/web/content/docs"), (file) => file.endsWith(".mdx")),
  resolve(repoRoot, "apps/web/content/prompts/index.ts"),
]
const legacyScenarioPatterns = [
  { pattern: /\brun\.url\b/, message: "uses legacy per-scenario run.url configuration" },
  {
    pattern: /\brun:\s*\{\s*url\b/,
    message: "uses a legacy raw scenario run.url object",
  },
  {
    pattern: /export\s+default\s+\[/,
    message: "default-exports a raw scenario array instead of scenarios(...) builder chains",
  },
  {
    pattern: /per-scenario tool mocking is not supported/i,
    message: "claims per-scenario tool mocking is unsupported",
  },
]

for (const filePath of normativeScenarioFiles) {
  const source = readFileSync(filePath, "utf8")
  for (const { pattern, message } of legacyScenarioPatterns) {
    if (pattern.test(source)) {
      failures.push(`${relativeToRoot(filePath)} ${message}`)
    }
  }
}

// Docs topology check — nav, authored MDX, and app wrappers must describe the
// same route set. Link targets and fragments are validated by the web MDX tests.
const docsNavPath = resolve(repoRoot, "apps/web/app/components/docs/nav.ts")
const docsNav = readFileSync(docsNavPath, "utf8")
const navDocEntries = [
  ...docsNav.matchAll(/^\s*\{\s*label:\s*"([^"]+)",\s*href:\s*"((?:\/docs\/)[^"]+)"\s*\},?\s*$/gm),
].map((match) => ({ label: match[1], href: match[2] }))
const expectedNavDocEntries = [
  { label: "Getting Started", href: "/docs/getting-started" },
  { label: "Mental Model", href: "/docs/mental-model" },
  { label: "Migrating from LangGraph", href: "/docs/migrating-from-langgraph" },
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
  { label: "Dev Server", href: "/docs/dev-server" },
  { label: "Middleware", href: "/docs/middleware" },
  { label: "AG-UI and Web Clients", href: "/docs/ag-ui" },
  { label: "Embed the Runtime", href: "/docs/embedding" },
  { label: "Blueprints", href: "/docs/blueprints" },
  { label: "Scenario Testing", href: "/docs/testing" },
  { label: "Agent Test Harness", href: "/docs/testing-agents" },
  { label: "Evals", href: "/docs/evals" },
  { label: "Persistence and Tenancy", href: "/docs/persistence" },
  { label: "Production Topology", href: "/docs/production-topology" },
  { label: "Security Architecture", href: "/docs/security-architecture" },
  { label: "Access Control", href: "/docs/access-control" },
  { label: "Permissions", href: "/docs/permissions" },
  { label: "Retry", href: "/docs/retry" },
  { label: "Observability", href: "/docs/observability" },
  { label: "Inspector", href: "/docs/inspector" },
  { label: "Upgrading", href: "/docs/upgrading" },
  { label: "Deployment Options", href: "/docs/deployment" },
  { label: "Node and Docker", href: "/docs/deployment/node" },
  { label: "Kubernetes", href: "/docs/deployment/kubernetes" },
  { label: "LangSmith", href: "/docs/deployment/langsmith" },
  { label: "Edge and Hono", href: "/docs/deployment/edge" },
  { label: "Execution Sandbox", href: "/docs/sandbox" },
  { label: "Recipes Overview", href: "/docs/recipes" },
  { label: "Add a Tool", href: "/docs/recipes/add-a-tool" },
  { label: "Typed State", href: "/docs/recipes/typed-state" },
  { label: "Auth Middleware", href: "/docs/recipes/auth-middleware" },
  { label: "Stream Output", href: "/docs/recipes/stream-output" },
  { label: "Retry Transient Model Calls", href: "/docs/recipes/retry-flaky-tools" },
  { label: "Dispatch from a Route", href: "/docs/recipes/dispatch-from-route" },
  { label: "Research Assistant Web UI", href: "/docs/recipes/research-web-ui" },
  { label: "Configuration Reference", href: "/docs/configuration" },
  { label: "CLI Reference", href: "/docs/cli" },
  { label: "API Reference", href: "/docs/api" },
  { label: "Error Codes", href: "/docs/errors" },
  { label: "FAQ", href: "/docs/faq" },
]

if (navDocEntries.length !== expectedNavDocEntries.length) {
  failures.push(
    `DOCS_NAV registry has ${navDocEntries.length} rows; expected exactly ${expectedNavDocEntries.length}`,
  )
}

const firstNavRegistryMismatch = Array.from(
  { length: Math.max(navDocEntries.length, expectedNavDocEntries.length) },
  (_, index) => index,
).find((index) => {
  const actual = navDocEntries[index]
  const expected = expectedNavDocEntries[index]
  return actual?.label !== expected?.label || actual?.href !== expected?.href
})

if (firstNavRegistryMismatch !== undefined) {
  failures.push(
    `DOCS_NAV registry row ${firstNavRegistryMismatch + 1} mismatch: expected ${JSON.stringify(expectedNavDocEntries[firstNavRegistryMismatch] ?? null)}, received ${JSON.stringify(navDocEntries[firstNavRegistryMismatch] ?? null)}`,
  )
}
const navDocHrefs = navDocEntries.map(({ href }) => href)
const uniqueNavDocHrefs = [...new Set(navDocHrefs)].sort()
const duplicateNavDocHrefs = uniqueNavDocHrefs.filter(
  (href) => navDocHrefs.filter((candidate) => candidate === href).length > 1,
)

if (duplicateNavDocHrefs.length > 0) {
  failures.push(`DOCS_NAV contains duplicate hrefs: ${duplicateNavDocHrefs.join(", ")}`)
}

const docsContentRoot = resolve(repoRoot, "apps/web/content/docs")
const docsWrapperRoot = resolve(repoRoot, "apps/web/app/docs")
const contentDocHrefs = walkFiles(docsContentRoot, (file) => file.endsWith(".mdx"))
  .map((file) => {
    const relativePath = relative(docsContentRoot, file).replaceAll("\\", "/")
    const slug = relativePath.endsWith("/index.mdx")
      ? relativePath.slice(0, -"/index.mdx".length)
      : relativePath.slice(0, -".mdx".length)
    return `/docs/${slug}`
  })
  .sort()
const wrapperDocHrefs = walkFiles(docsWrapperRoot, (file) => basename(file) === "page.tsx")
  .filter((file) => file !== join(docsWrapperRoot, "page.tsx"))
  .map((file) => {
    const relativePath = relative(docsWrapperRoot, file).replaceAll("\\", "/")
    return `/docs/${relativePath.slice(0, -"/page.tsx".length)}`
  })
  .sort()
const navDocHrefSet = new Set(uniqueNavDocHrefs)
const contentDocHrefSet = new Set(contentDocHrefs)
const wrapperDocHrefSet = new Set(wrapperDocHrefs)

for (const href of uniqueNavDocHrefs) {
  if (!contentDocHrefSet.has(href)) {
    failures.push(`DOCS_NAV references ${href}, but ${docHrefToContentPath(href)} is missing`)
  }
  if (!wrapperDocHrefSet.has(href)) {
    failures.push(`DOCS_NAV references ${href}, but ${docHrefToPagePath(href)} is missing`)
  }
}

for (const { label, href } of navDocEntries) {
  if (!contentDocHrefSet.has(href) || !wrapperDocHrefSet.has(href)) continue

  const contentPath = resolve(repoRoot, docHrefToContentPath(href))
  const wrapperPath = resolve(repoRoot, docHrefToPagePath(href))
  const { firstH1, metadataTitle } = analyzeDocTitles({
    mdxSource: readFileSync(contentPath, "utf8"),
    wrapperSource: readFileSync(wrapperPath, "utf8"),
  })

  if (firstH1 !== label) {
    failures.push(
      `${docHrefToContentPath(href)} first H1 ${JSON.stringify(firstH1)} does not match DOCS_NAV label ${JSON.stringify(label)}`,
    )
  }
  if (metadataTitle !== label) {
    failures.push(
      `${docHrefToPagePath(href)} metadata.title ${JSON.stringify(metadataTitle)} does not match DOCS_NAV label ${JSON.stringify(label)}`,
    )
  }
}

for (const href of contentDocHrefs) {
  if (!navDocHrefSet.has(href)) {
    failures.push(`Authored docs content for ${href} is not registered in DOCS_NAV`)
  }
}

for (const href of wrapperDocHrefs) {
  if (!navDocHrefSet.has(href)) {
    failures.push(`Docs wrapper for ${href} is not registered in DOCS_NAV`)
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
// runtime-fetch-core route additions that expose new client-facing protocols.
const runtimeFetchCoreSource = readFileSync(
  resolve(repoRoot, "packages/cli/src/lib/dev/runtime-fetch-core.ts"),
  "utf8",
)
const devServerDocs = readFileSync(
  resolve(repoRoot, "apps/web/content/docs/dev-server.mdx"),
  "utf8",
)
if (runtimeFetchCoreSource.includes("/agui/:routeId")) {
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

for (const endpoint of [
  "POST /threads/:thread_id/cancel",
  "GET /memory/candidates",
  "POST /memory/candidates/:id/approve",
  "POST /memory/candidates/:id/reject",
]) {
  if (runtimeFetchCoreSource.includes(endpoint) && !devServerDocs.includes(endpoint)) {
    failures.push(`apps/web/content/docs/dev-server.mdx is missing endpoint text: ${endpoint}`)
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
  // Changesets become CHANGELOG prose verbatim when the Version PR runs. Scanning
  // them here is what makes a banned phrase fail on the PR that writes it, rather
  // than on main after the release bakes it in — the failure mode that took main
  // red when a changeset described a template as byte-identical to its source.
  ".changeset",
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
