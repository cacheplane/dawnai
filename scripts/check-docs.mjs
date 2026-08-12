import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { tsImport } from "tsx/esm/api"
import { NodeFlags, SyntaxKind } from "typescript/unstable/ast"
import {
  isAssertionExpression,
  isExpressionWithTypeArguments,
  isIdentifier,
  isIndexedAccessTypeNode,
  isInterfaceDeclaration,
  isIntersectionTypeNode,
  isLiteralTypeNode,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isParenthesizedTypeNode,
  isPropertyAssignment,
  isPropertySignatureDeclaration,
  isSatisfiesExpression,
  isStringLiteral,
  isTypeLiteralNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableStatement,
} from "typescript/unstable/ast/is"
import { createVirtualFileSystem } from "typescript/unstable/fs"
import { API } from "typescript/unstable/sync"
import {
  analyzeApiInventoryBatch,
  manifestArtifactEntries,
  readPublicSourceInventory,
} from "./lib/docs-api-inventory.mjs"

const repoRoot = resolve(import.meta.dirname, "..")
const { default: GithubSlugger } = await import(
  pathToFileURL(resolve(repoRoot, "apps/web/node_modules/github-slugger/index.js")).href
)

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

      const openingMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(content)
      const opening = openingMatch?.[1]
      if (!opening || (opening[0] === "`" && openingMatch?.[2]?.includes("`"))) return line
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

function linkDestinationOccurrences(source) {
  const masked = maskMarkdownCodeAndComments(source)
  const occurrences = []
  const markdownLink = /\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
  for (const match of masked.matchAll(markdownLink)) {
    if (match[1] && !isMarkdownImage(masked, match.index)) {
      occurrences.push({ index: match.index, destination: match[1] })
    }
  }
  for (const match of masked.matchAll(/\bhref\s*(?::|=)\s*["']([^"']+)["']/g)) {
    if (match[1]) {
      occurrences.push({ index: match.index, destination: match[1] })
    }
  }
  for (const match of masked.matchAll(/^[ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*<?([^\s>]+)>?/gm)) {
    if (match[1]) {
      occurrences.push({ index: match.index, destination: match[1] })
    }
  }
  return occurrences.sort((left, right) => left.index - right.index)
}

function linkDestinations(source) {
  return linkDestinationOccurrences(source).map(({ destination }) => destination)
}

function analyzeCompatibilityStub({ source, retainedHeading, canonicalHref, maxChars = 600 }) {
  const headingSource = maskMarkdownCodeAndComments(source)
  const headings = [...headingSource.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gm)].map((match) => {
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

function markdownHeadings(source) {
  const masked = maskMarkdownCodeAndComments(source)
  const slugger = new GithubSlugger()
  return [...masked.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gm)].flatMap((match) => {
    if (match.index === undefined || !match[1]) return []
    const lineEnd = source.indexOf("\n", match.index)
    const originalLine = source.slice(match.index, lineEnd === -1 ? source.length : lineEnd)
    const text = normalizeCodeSpans(
      originalLine
        .replace(/^[ \t]{0,3}#{1,6}[ \t]+/, "")
        .replace(/[ \t]+#+[ \t]*$/, "")
        .trim(),
    )
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim()
    return [{ id: slugger.slug(text), index: match.index, level: match[1].length, text }]
  })
}

function markdownSectionRange(source, predicate) {
  const headings = markdownHeadings(source)
  const headingIndex = headings.findIndex(predicate)
  const heading = headings[headingIndex]
  if (!heading) return null
  const nextHeading = headings.slice(headingIndex + 1).find((entry) => entry.level <= heading.level)
  return { start: heading.index, end: nextHeading?.index ?? source.length }
}

function movedLinkGuardViolations(file, source, contracts) {
  const contractsByHref = new Map(contracts.map((contract) => [contract.legacyHref, contract]))
  return linkDestinationOccurrences(source).flatMap(({ index, destination }) => {
    const normalized = normalizeMaintainedDocsDestination(destination)
    const contract = normalized ? contractsByHref.get(normalized) : undefined
    if (!contract) return []
    const fragment = contract.legacyHref.split("#")[1]
    const compatibilityRange = fragment
      ? markdownSectionRange(source, (heading) => heading.id === fragment)
      : null
    if (
      file === contract.legacyFile &&
      compatibilityRange &&
      index >= compatibilityRange.start &&
      index < compatibilityRange.end
    ) {
      return []
    }
    return [`${file}: ${contract.legacyHref} -> ${contract.canonicalHref}`]
  })
}

function canonicalOwnerGuardViolations(source, contracts) {
  return contracts.flatMap(({ heading, required }) => {
    const range = markdownSectionRange(source, (candidate) => candidate.text === heading)
    const destinations = range
      ? linkDestinationOccurrences(source.slice(range.start, range.end)).flatMap(
          ({ destination }) => {
            const normalized = normalizeMaintainedDocsDestination(destination)
            return normalized ? [normalized] : []
          },
        )
      : []
    return required
      .filter((href) => !destinations.includes(href))
      .map((href) => `${heading}: missing ${href}`)
  })
}

const EXPECTED_API_REFERENCE_PAGE_TUPLES = [
  ["@dawn-ai/sdk", "/docs/api/sdk", "@dawn-ai/sdk", ["@dawn-ai/sdk"], "API Reference", "/docs/api"],
  ["@dawn-ai/cli", "/docs/api/cli", "@dawn-ai/cli", ["@dawn-ai/cli"], "API Reference", "/docs/api"],
  [
    "@dawn-ai/core",
    "/docs/api/core",
    "@dawn-ai/core",
    ["@dawn-ai/core"],
    "API Reference",
    "/docs/api",
  ],
  [
    "@dawn-ai/ag-ui",
    "/docs/api/ag-ui",
    "@dawn-ai/ag-ui",
    ["@dawn-ai/ag-ui"],
    "API Reference",
    "/docs/api",
  ],
  [
    "@dawn-ai/memory",
    "/docs/api/memory",
    "@dawn-ai/memory",
    ["@dawn-ai/memory"],
    "API Reference",
    "/docs/api",
  ],
  [
    "@dawn-ai/memory-pgvector",
    "/docs/api/memory-pgvector",
    "@dawn-ai/memory-pgvector",
    ["@dawn-ai/memory-pgvector"],
    "API Reference",
    "/docs/api",
  ],
  [
    "@dawn-ai/postgres-storage",
    "/docs/api/postgres-storage",
    "@dawn-ai/postgres-storage",
    ["@dawn-ai/postgres-storage"],
    "API Reference",
    "/docs/api",
  ],
  [
    "@dawn-ai/testing",
    "/docs/api/testing",
    "@dawn-ai/testing",
    ["@dawn-ai/testing"],
    "API Reference",
    "/docs/api",
  ],
  [
    "@dawn-ai/evals",
    "/docs/api/evals",
    "@dawn-ai/evals",
    ["@dawn-ai/evals"],
    "API Reference",
    "/docs/api",
  ],
  [
    "dawn:routes",
    "/docs/api/generated-routes",
    "dawn:routes",
    ["@dawn-ai/cli", "@dawn-ai/core"],
    "API Reference",
    "/docs/api",
  ],
]

const EXPECTED_API_ARTIFACT_POLICY_TUPLES = [
  ["import:@dawn-ai/sdk:.", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/sdk:./pure", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/sdk:./testing", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/cli:.", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/cli:./fetch", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/cli:./runtime", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/cli:./testing", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/core:.", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/core:./node", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/core:./internal/compiler", "internal", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/ag-ui:.", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/ag-ui:./sse", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/memory:.", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/memory:./browse", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/memory:./namespace", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/memory:./reconcile", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/memory-pgvector:.", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/postgres-storage:.", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/postgres-storage:./node", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/testing:.", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/evals:.", "detailed", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/permissions:.", "deferred-to-pr2", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/permissions:./node", "deferred-to-pr2", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/workspace:.", "deferred-to-pr2", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/workspace:./node", "deferred-to-pr2", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/sandbox:.", "deferred-to-pr2", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/sandbox:./testing", "deferred-to-pr2", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/langgraph:.", "deferred-to-pr2", "surfaceKind", "typescript-runtime"],
  [
    "import:@dawn-ai/langgraph:./define-entry",
    "deferred-to-pr2",
    "surfaceKind",
    "typescript-runtime",
  ],
  [
    "import:@dawn-ai/langgraph:./route-module",
    "deferred-to-pr2",
    "surfaceKind",
    "typescript-runtime",
  ],
  ["import:@dawn-ai/langchain:.", "deferred-to-pr2", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/langchain:./package.json", "deferred-to-pr2", "surfaceKind", "metadata"],
  ["import:@dawn-ai/sqlite-storage:.", "deferred-to-pr2", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/config-biome:.", "catalog-only", "surfaceKind", "config-artifact"],
  ["import:@dawn-ai/config-biome:./biome", "catalog-only", "surfaceKind", "config-artifact"],
  ["import:@dawn-ai/config-typescript:.", "catalog-only", "surfaceKind", "config-artifact"],
  ["import:@dawn-ai/config-typescript:./base", "catalog-only", "surfaceKind", "config-artifact"],
  ["import:@dawn-ai/config-typescript:./library", "catalog-only", "surfaceKind", "config-artifact"],
  ["import:@dawn-ai/config-typescript:./node", "catalog-only", "surfaceKind", "config-artifact"],
  ["import:@dawn-ai/config-typescript:./nextjs", "catalog-only", "surfaceKind", "config-artifact"],
  ["import:@dawn-ai/devkit:.", "internal", "surfaceKind", "typescript-runtime"],
  ["import:@dawn-ai/vite-plugin:.", "internal", "surfaceKind", "typescript-runtime"],
  ["operated:@dawn-ai/cli:bin.dawn", "detailed", "operatedKind", "executable"],
  [
    "operated:create-dawn-ai-app:bin.create-dawn-ai-app",
    "catalog-only",
    "operatedKind",
    "executable",
  ],
  [
    "operated:@dawn-ai/inspector:dawnInspector.server",
    "catalog-only",
    "operatedKind",
    "operated-application",
  ],
  ["generated:dawn:routes", "detailed", "surfaceKind", "generated-types"],
]

function apiArtifactAddress(artifact) {
  if (artifact.kind === "import") return `import:${artifact.packageName}:${artifact.subpath}`
  if (artifact.kind === "operated") return `operated:${artifact.packageName}:${artifact.selector}`
  return `generated:${artifact.moduleName}`
}

const DEPENDENCY_FREE_API_ADDRESSES = new Set([
  "import:@dawn-ai/sdk:./pure",
  "import:@dawn-ai/memory:./browse",
])
const EDGE_SAFE_API_ADDRESSES = new Set([
  "import:@dawn-ai/sdk:.",
  "import:@dawn-ai/sdk:./pure",
  "import:@dawn-ai/cli:./fetch",
  "import:@dawn-ai/core:.",
  "import:@dawn-ai/ag-ui:.",
  "import:@dawn-ai/ag-ui:./sse",
  "import:@dawn-ai/memory:./browse",
  "import:@dawn-ai/memory:./namespace",
  "import:@dawn-ai/memory:./reconcile",
  "import:@dawn-ai/postgres-storage:.",
  "import:@dawn-ai/permissions:.",
  "import:@dawn-ai/workspace:.",
  "import:@dawn-ai/langgraph:.",
  "import:@dawn-ai/langgraph:./define-entry",
  "import:@dawn-ai/langgraph:./route-module",
  "import:@dawn-ai/langchain:.",
])

function expectedApiGuardIds(address) {
  if (address.startsWith("operated:")) {
    return ["node-operated-bundle", "browser-operated-negative-control"]
  }
  const expectedTuple = EXPECTED_API_ARTIFACT_POLICY_TUPLES.find(
    ([candidate]) => candidate === address,
  )
  if (!address.startsWith("import:") || expectedTuple?.[3] !== "typescript-runtime") {
    return undefined
  }
  if (EDGE_SAFE_API_ADDRESSES.has(address)) {
    return [
      "edge-import-bundle",
      ...(DEPENDENCY_FREE_API_ADDRESSES.has(address) ? ["dependency-free-import-graph"] : []),
    ]
  }
  return ["node-import-bundle", "browser-import-negative-control"]
}

function tupleMismatchFields(actual, expected, fields) {
  return fields.filter(
    (_, index) => JSON.stringify(actual?.[index]) !== JSON.stringify(expected?.[index]),
  )
}

function analyzeApiReferenceRegistry({ pages = [], artifacts = [] }) {
  const analysisFailures = []
  const pageTuples = pages.map(({ label, href, surfaceName, ownerPackageNames, parent }) => [
    label,
    href,
    surfaceName,
    ownerPackageNames,
    parent?.label,
    parent?.href,
  ])
  const pageFields = [
    "label",
    "href",
    "surfaceName",
    "ownerPackageNames",
    "parent.label",
    "parent.href",
  ]
  for (
    let index = 0;
    index < Math.max(pageTuples.length, EXPECTED_API_REFERENCE_PAGE_TUPLES.length);
    index++
  ) {
    const actual = pageTuples[index]
    const expected = EXPECTED_API_REFERENCE_PAGE_TUPLES[index]
    const mismatches = tupleMismatchFields(actual, expected, pageFields)
    if (mismatches.length > 0) {
      analysisFailures.push(
        `API reference page tuple ${index + 1} (${expected?.[0] ?? actual?.[0] ?? "missing"}) mismatches ${mismatches.join(", ")}: expected ${JSON.stringify(expected ?? null)}, received ${JSON.stringify(actual ?? null)}`,
      )
    }
  }

  const labels = pages.map(({ label }) => label)
  const duplicateLabels = [...new Set(labels)].filter(
    (label) => labels.filter((candidate) => candidate === label).length > 1,
  )
  if (duplicateLabels.length > 0) {
    analysisFailures.push(`duplicate API reference page labels: ${duplicateLabels.join(", ")}`)
  }

  const artifactPolicyTuples = artifacts.map((artifact) => {
    const base =
      artifact.kind === "operated"
        ? [apiArtifactAddress(artifact), artifact.coverage, "operatedKind", artifact.operatedKind]
        : [apiArtifactAddress(artifact), artifact.coverage, "surfaceKind", artifact.surfaceKind]
    return [...base, artifact.runtime ?? null, artifact.purity ?? null, artifact.guardIds ?? null]
  })
  const expectedArtifactPolicyTuples = EXPECTED_API_ARTIFACT_POLICY_TUPLES.map((expected) => {
    const guardIds = expectedApiGuardIds(expected[0])
    return [
      ...expected,
      guardIds ? (EDGE_SAFE_API_ADDRESSES.has(expected[0]) ? "edge-safe" : "node-only") : null,
      DEPENDENCY_FREE_API_ADDRESSES.has(expected[0])
        ? "dependency-free"
        : guardIds && expected[0].startsWith("import:")
          ? "not-claimed"
          : null,
      guardIds ?? null,
    ]
  })
  const artifactFields = [
    "address",
    "coverage",
    "kind field",
    "surfaceKind/operatedKind",
    "runtime",
    "purity",
    "guardIds",
  ]
  for (
    let index = 0;
    index < Math.max(artifactPolicyTuples.length, expectedArtifactPolicyTuples.length);
    index++
  ) {
    const actual = artifactPolicyTuples[index]
    const expected = expectedArtifactPolicyTuples[index]
    const mismatches = tupleMismatchFields(actual, expected, artifactFields)
    if (mismatches.length > 0) {
      analysisFailures.push(
        `API artifact policy tuple ${index + 1} (${expected?.[0] ?? actual?.[0] ?? "missing"}) mismatches ${mismatches.join(", ")}: expected ${JSON.stringify(expected ?? null)}, received ${JSON.stringify(actual ?? null)}`,
      )
    }
  }

  return { failures: analysisFailures }
}

function analyzeApiReferenceManifests({ manifests = [], artifacts = [] }) {
  const analysisFailures = []
  const manifestEntries = manifestArtifactEntries(manifests)
  const manifestByAddress = new Map(manifestEntries.map((entry) => [entry.address, entry]))
  const registryByAddress = new Map(
    artifacts
      .filter(({ kind }) => kind !== "generated")
      .map((artifact) => [apiArtifactAddress(artifact), artifact]),
  )

  for (const entry of manifestEntries) {
    const artifact = registryByAddress.get(entry.address)
    if (!artifact) {
      analysisFailures.push(`manifest address ${entry.address} is missing from ARTIFACT_REGISTRY`)
      continue
    }
    if (artifact.kind === "operated" && entry.manifestTarget !== artifact.manifestTarget) {
      analysisFailures.push(
        `manifest target for ${entry.address} is ${JSON.stringify(entry.manifestTarget)}; ARTIFACT_REGISTRY expects ${JSON.stringify(artifact.manifestTarget)}`,
      )
    }
  }

  for (const [address] of registryByAddress) {
    if (!manifestByAddress.has(address)) {
      analysisFailures.push(`manifest is missing ARTIFACT_REGISTRY address ${address}`)
    }
  }

  return { failures: analysisFailures }
}

if (process.argv[2] === "--analyze-doc-link-guards") {
  const fixture = JSON.parse(process.argv[3] ?? "{}")
  process.stdout.write(
    `${JSON.stringify({
      movedViolations: movedLinkGuardViolations(
        fixture.file ?? "fixture.mdx",
        fixture.source ?? "",
        fixture.movedContracts ?? [],
      ),
      canonicalViolations: canonicalOwnerGuardViolations(
        fixture.source ?? "",
        fixture.canonicalContracts ?? [],
      ),
    })}\n`,
  )
  process.exit(0)
}

if (process.argv[2] === "--analyze-compatibility-stub") {
  const fixture = JSON.parse(process.argv[3] ?? "{}")
  process.stdout.write(`${JSON.stringify(analyzeCompatibilityStub(fixture))}\n`)
  process.exit(0)
}

if (process.argv[2] === "--analyze-doc-titles") {
  const fixture = JSON.parse(process.argv[3] ?? readFileSync(0, "utf8"))
  const analysis = Array.isArray(fixture)
    ? analyzeDocTitlesBatch(fixture)
    : analyzeDocTitles(fixture)
  process.stdout.write(`${JSON.stringify(analysis)}\n`)
  process.exit(0)
}

if (process.argv[2] === "--analyze-api-reference-registry") {
  const fixture = JSON.parse(process.argv[3] ?? "{}")
  process.stdout.write(`${JSON.stringify(analyzeApiReferenceRegistry(fixture))}\n`)
  process.exit(0)
}

if (process.argv[2] === "--analyze-api-reference-manifests") {
  const fixture = JSON.parse(process.argv[3] ?? "{}")
  process.stdout.write(`${JSON.stringify(analyzeApiReferenceManifests(fixture))}\n`)
  process.exit(0)
}

if (process.argv[2] === "--analyze-api-inventory") {
  const fixtures = JSON.parse(readFileSync(0, "utf8"))
  if (!Array.isArray(fixtures)) {
    throw new Error("--analyze-api-inventory expects one JSON fixture batch on stdin")
  }
  await new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(`${JSON.stringify(analyzeApiInventoryBatch(fixtures))}\n`, (error) => {
      if (error) rejectWrite(error)
      else resolveWrite()
    })
  })
  process.exit(0)
}

if (process.argv[2] === "--analyze-foundational-api-references") {
  const foundationalRegistry = await tsImport(
    pathToFileURL(resolve(repoRoot, "apps/web/app/components/docs/api-reference.ts")).href,
    import.meta.url,
  )
  const sourceInventory = await readPublicSourceInventory(repoRoot)
  const foundationalHrefs = new Set([
    "/docs/api/sdk",
    "/docs/api/cli",
    "/docs/api/core",
    "/docs/api/generated-routes",
  ])
  const pages = foundationalRegistry.API_REFERENCE_PAGES.filter(({ href }) =>
    foundationalHrefs.has(href),
  )
  const ownerByPackage = new Map(
    pages.flatMap((page) =>
      page.surfaceName === "dawn:routes"
        ? []
        : page.ownerPackageNames.map((name) => [name, page.href]),
    ),
  )
  const artifacts = foundationalRegistry.ARTIFACT_REGISTRY.flatMap((artifact) => {
    if (artifact.kind === "generated") return [artifact]
    if (
      artifact.kind !== "import" ||
      artifact.coverage !== "detailed" ||
      !ownerByPackage.has(artifact.packageName)
    ) {
      return []
    }
    return [{ ...artifact, ownerHref: ownerByPackage.get(artifact.packageName) }]
  })
  const documents = pages.map(({ href }) => ({
    href,
    path: docHrefToContentPath(href),
    source: readFileSync(resolve(repoRoot, docHrefToContentPath(href)), "utf8"),
  }))
  const authorityFiles = new Set(
    foundationalRegistry.API_BEHAVIOR_CONTRACTS.flatMap(({ authorities }) =>
      authorities.map(({ file }) => file),
    ),
  )
  for (const file of authorityFiles) {
    if (!Object.hasOwn(sourceInventory.files, file)) {
      sourceInventory.files[file] = readFileSync(resolve(repoRoot, file), "utf8")
    }
  }
  const generatedManifest = {
    appRoot: "/fixture/app",
    routes: [
      {
        id: "/hello/[tenant]",
        pathname: "/hello/[tenant]",
        kind: "workflow",
        entryFile: "/fixture/app/hello/[tenant].ts",
        routeDir: "/fixture/app/hello/[tenant]",
        segments: [
          { kind: "static", raw: "hello" },
          { kind: "dynamic", name: "tenant", raw: "[tenant]" },
        ],
      },
    ],
  }
  const { renderDawnTypes } = await tsImport(
    pathToFileURL(resolve(repoRoot, "packages/core/src/typegen/render-route-types.ts")).href,
    import.meta.url,
  )
  const generatedDeclarations = renderDawnTypes(
    generatedManifest,
    [
      {
        pathname: "/hello/[tenant]",
        tools: [{ name: "greet", description: "Greet", inputType: "void", outputType: "string" }],
      },
    ],
    [{ pathname: "/hello/[tenant]", fields: [{ name: "status", type: '"ready"' }] }],
  )
  const [analysis] = analyzeApiInventoryBatch([
    {
      name: "foundational-api-references",
      packages: sourceInventory.packages,
      artifacts,
      documents,
      behaviorContracts: foundationalRegistry.API_BEHAVIOR_CONTRACTS,
      files: sourceInventory.files,
      generatedAuthorities: [{ moduleName: "dawn:routes", declarations: generatedDeclarations }],
    },
  ])
  process.stdout.write(`${JSON.stringify({ failures: analysis.failures })}\n`)
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

const gettingStartedSource = readFileSync(
  resolve(repoRoot, "apps/web/content/docs/getting-started.mdx"),
  "utf8",
)
for (const required of [
  "[Deployment Options](/docs/deployment)",
  "[Node and Docker](/docs/deployment/node)",
]) {
  if (!gettingStartedSource.includes(required)) {
    failures.push(`apps/web/content/docs/getting-started.mdx is missing journey link: ${required}`)
  }
}
for (const forbidden of ["## 5. Ship it", "docker run -p 8000:8000"]) {
  if (gettingStartedSource.includes(forbidden)) {
    failures.push(
      `apps/web/content/docs/getting-started.mdx retains removed shipping tutorial text: ${forbidden}`,
    )
  }
}
const gettingStartedFinalCards = gettingStartedSource.slice(
  gettingStartedSource.indexOf("## Where to go next"),
)
const gettingStartedDecisionTitles = [
  ...gettingStartedFinalCards.matchAll(/\btitle:\s*"([^"]+)"/g),
].map((match) => match[1])
const expectedGettingStartedDecisionTitles = ["Mental Model", "Add a Tool", "Deployment Options"]
if (
  JSON.stringify(gettingStartedDecisionTitles) !==
  JSON.stringify(expectedGettingStartedDecisionTitles)
) {
  failures.push(
    `apps/web/content/docs/getting-started.mdx final decision cards must be ${expectedGettingStartedDecisionTitles.join(", ")}; found ${gettingStartedDecisionTitles.join(", ")}`,
  )
}

const recipesOverviewSource = readFileSync(
  resolve(repoRoot, "apps/web/content/docs/recipes/index.mdx"),
  "utf8",
)
for (const heading of ["Build", "Integrate", "Test", "Deploy"]) {
  if (!recipesOverviewSource.includes(`## ${heading}`)) {
    failures.push(`apps/web/content/docs/recipes/index.mdx is missing task group: ${heading}`)
  }
}
for (const label of [
  "Add a Tool",
  "Typed State",
  "Retry Transient Model Calls",
  "Dispatch from a Route",
  "Auth Middleware",
  "Stream Output",
  "Research Assistant Web UI",
]) {
  const count = recipesOverviewSource.split(`[${label}]`).length - 1
  if (count !== 1) {
    failures.push(
      `apps/web/content/docs/recipes/index.mdx must link recipe label ${label} exactly once; found ${count}`,
    )
  }
}
for (const required of [
  "[Scenario Testing](/docs/testing)",
  "[Agent Test Harness](/docs/testing-agents)",
  "[Fixtures and Recording](/docs/testing-agents/fixtures)",
  "[Deployment Options](/docs/deployment)",
  "[Node and Docker](/docs/deployment/node)",
  "[Kubernetes](/docs/deployment/kubernetes)",
]) {
  if (!recipesOverviewSource.includes(required)) {
    failures.push(
      `apps/web/content/docs/recipes/index.mdx is missing canonical guide link: ${required}`,
    )
  }
}

const accuracyContracts = [
  {
    file: "apps/web/content/docs/memory.mdx",
    required: [
      "three memory mechanisms",
      "workspace/AGENTS.md",
      "memory.md",
      "memory.ts",
      "not a fourth memory mechanism",
      "/docs/workspace",
      "/docs/memory/long-term",
      "/docs/memory/retrieval",
      "/docs/memory/episodes",
      "/docs/memory/distillation",
      "/docs/memory/browse",
      'import { defineMemory } from "@dawn-ai/sdk"',
      'kind: "semantic"',
      'scope: ["workspace", "route"]',
      "schema: z.object({",
      "subject: z.string()",
      "predicate: z.string()",
      "value: z.string()",
      "From this typed collection, continue with",
    ],
    forbidden: ["State is a fourth memory mechanism", "[Guide]("],
  },
  {
    file: "apps/web/content/docs/memory/long-term.mdx",
    required: [
      "# Long-term Memory",
      "generated `recall` and `remember` tools",
      "candidate",
      "resolveScope",
      "routePath",
      "appRoot",
      "does not receive verified identity",
      "procedural",
      "same millisecond",
      "seedMemory",
      'import { basename } from "node:path"',
      'import { serializeNamespace } from "@dawn-ai/memory/namespace"',
      'const store = sqliteMemoryStore({ path: ":memory:" })',
      "workspace: basename(appRoot)",
      'route: "/support"',
      "unknown decision is allowed",
      "without a permissions store, the supersede is also allowed",
      "supervision affordance, not a security boundary",
      "## Write governance",
      "## Reviewing candidates",
      "## Configuration",
      "## Testing",
    ],
    forbidden: [
      "procedural writes are generated",
      'namespace: "workspace=/srv/app|route=/support"',
      "ask mode is a security boundary",
      "unknown decisions fail closed in ask mode",
    ],
  },
  {
    file: "apps/web/content/docs/memory/retrieval.mdx",
    required: [
      "# Recall and Retrieval",
      "MemoryStore.search",
      "query-less",
      "Reciprocal Rank Fusion",
      "fixed evaluation timestamp",
      "model id",
      "exact vector scan",
      "HNSW",
      "approximate candidate",
      "The `memory.ts` scope declaration chooses which dimensions exist",
      "runtime values plus `memory.resolveScope` construct the namespace",
      "does not receive verified identity",
      "Tags are applied after the result limit",
      "Eligible tagged rows below that boundary are omitted",
      "newest token-matching rows before scoring",
      'import { openaiEmbedder } from "@dawn-ai/langchain"',
      "const embedder = openaiEmbedder()",
      "dimensions: embedder.dims",
      "vector: { embedder }",
      "must match the embedder output dimension",
      "Browse and Manage Memory",
      "## How recall ranks",
      "## Semantic recall (opt-in)",
      "## Postgres backend (pgvector)",
    ],
    forbidden: [
      "identical order across backends",
      "The route declaration supplies the exact namespace",
      "tags are applied before the limit",
      "tag filtering exhaustively fills the requested limit",
      "`resolveScope` receives verified identity",
    ],
  },
  {
    file: "apps/web/content/docs/memory/episodes.mdx",
    required: [
      "# Episodes",
      "disabled by default",
      "30 days",
      "500",
      "failed runs",
      "settled",
      "failed",
      "parked",
      "not completed until",
      "does not embed",
      '`memory.writes: "off"` makes the recorder a no-op',
      "failed episode records currently use `toolsUsed: []`",
      "## Episodic memory",
    ],
    forbidden: [
      "parked interrupts are completed runs",
      'episodes still record when `memory.writes` is `"off"`',
      "failed episodes include tools used before the error",
      "the episode recorder ignores `memory.writes`",
    ],
  },
  {
    file: "apps/web/content/docs/memory/distillation.mdx",
    required: [
      "# Distillation",
      "Nothing runs automatically",
      "dawn memory consolidate",
      "dawn memory reflect",
      "--dry-run",
      "write",
      "link",
      "watermark",
      "no-insight sentinel",
      "candidate",
      "maxRecords",
      "keyword",
      "provenance",
      "cost",
      "schedule",
      "leading namespace dimension",
      "full canonical namespace prefix",
      "There is no generic safe-to-rerun guarantee",
      "partial link failure",
      "below `minBatchSize`",
      "exits non-zero",
      "manual reconciliation",
      "active memory content is sent to the configured model provider",
      "active before source linking begins",
      "prompt injection",
      "rejecting every candidate insight deletes every persisted watermark",
      "repeat the model call and its cost",
      "## Distillation",
    ],
    forbidden: [
      "distillation runs automatically",
      "monitor failures and re-run safely",
      "--namespace 'route=/support'",
      "distillation is safe for sensitive data",
      "rejecting candidate insights preserves the reflection watermark",
    ],
  },
  {
    file: "apps/web/content/docs/memory/browse.mdx",
    required: [
      "# Browse and Manage Memory",
      "MemoryStore.browse",
      "MemoryStore.search",
      "authenticated",
      "authorized",
      "server-derived",
      "@dawn-ai/memory/browse",
      "node:sqlite",
      "closed whitelist",
      "opaque",
      "query fingerprint",
      "fixed `now`",
      "same transaction snapshot",
      "exact multiple",
      "Content filters are case-insensitive",
      "SQLite's built-in `lower()` folds ASCII only",
      "non-ASCII content matching can differ from Postgres",
      "Top-level `status: []` and `kind: []` are valid and match nothing",
      "empty `in` or `notIn` filter values are invalid",
      "BrowseQueryError",
      "HTTP 400",
      "raw = await request.json()",
      "error instanceof BrowseQueryError",
      "float4",
      "no semantic ranking",
    ],
    forbidden: [
      "byte-identical",
      "Dawn exposes a public memory browse HTTP endpoint",
      "Content filters have identical Unicode case-folding across SQLite and Postgres",
      "(await request.json()) as BrowseQuery",
      "invalid browse queries return HTTP 500",
      "empty top-level status and kind sets are unfiltered",
    ],
  },
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
      "app-dedicated database",
      "default `public` schema",
      "default `dawn` table prefix",
      "no application namespace",
      "unique `schema` or `tablePrefix`",
      "hand-composed store wiring",
    ],
    forbidden: [
      "thread deletion removes all",
      "performs best-effort checkpoint deletion",
      "generated Hono apps can safely share one database",
    ],
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
      "advanced lifecycle/store skeleton",
      "not a complete production edge/model host",
      "seedModelImporter",
      "seedRuntimeEnv",
      "literal provider imports",
      "generated `.dawn/build/app.mjs`",
    ],
    forbidden: [
      'from "@dawn-ai/cli/runtime"',
      "app.mount(",
      'app.route("/dawn"',
      "const handler = await createRuntimeFetchHandler",
      'mode: "interactive"',
      'from "@dawn-ai/permissions"',
      "copyable complete model host",
    ],
  },
  {
    file: "apps/web/content/docs/api.mdx",
    required: [
      "## @dawn-ai/cli",
      "### @dawn-ai/cli/fetch",
      "## @dawn-ai/memory",
      "### @dawn-ai/memory/browse",
      "lower-level tooling",
      "serveRuntime",
      "ServeRuntimeHandle",
      "ServeRuntimeOptions",
      "loadStaticModules",
      "DawnStaticModules",
      "createRuntimeFetchHandler",
      "RuntimeFetchHandler",
      "buildStaticRouteModule",
      "requestStores",
      "partial allocation",
      "does not own or close injected boot stores",
      "requires `modules` during handler construction",
      "boot `threadsStore` and `checkpointer` must be instances",
      "boot `permissionsStore` may be an instance or an async factory",
      "Only the boot `memoryStore` thunk is lazy",
      "`requestStores` runs before route dispatch",
      "may eagerly create its per-request memory store",
      "falls through to the corresponding boot store",
      "at least one query token",
      "query-less branch runs first",
      "BROWSE_DEFAULT_LIMIT = 50",
      "BROWSE_MAX_LIMIT = 1000",
      "1,024 UTF-8 bytes",
      "4,096 characters",
      "full millisecond UTC instants",
      "at most eight filters and three sort entries",
      "nonzero offset",
      "excludes `limit`, `offset`, and `cursor`",
      "readonly key: readonly BrowseCursorValue[]",
      "readonly field: BrowseSortField",
      "readonly column: string",
      'readonly field: "status"',
      'field: "updatedAt"',
      'column: "updated_at"',
      "inclusive UTC-day lower bound",
      "exclusive upper bound",
      "all-maximal prefix has no finite upper bound",
      "empty prefix",
      '"invalid-query"',
      '"continuation-invalid"',
    ],
    forbidden: [
      "@dawn-ai/cli/runtime is the application embedding",
      "the handler closes injected boot stores",
      "cursor and offset cannot be combined",
      "browse is capped at 1000 rows",
      "BROWSE_MAX_LIMIT is enforced automatically",
      "@dawn-ai/memory/browse imports node:sqlite",
      "subscribe to shutdownController",
      "Supplying both `queryEmbedding` and `embedderId` selects hybrid",
      "an omitted store fails only when an endpoint first uses that missing dependency",
      "an omitted store fails on first use",
      "memory store is always lazy",
    ],
    forbiddenRegexes: [/\bomitted store\b[^\r\n.]{0,120}\bfirst use\b/i],
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
    required: [
      "# Agent Test Harness",
      'title="test/agent.test.ts"',
      'new URL("..", import.meta.url)',
      "await h.close()",
      "process-global",
      "/docs/testing-agents/fixtures",
      'test -z "$(git status --porcelain -- test/fixtures/)"',
    ],
    forbidden: [
      'title="src/app/chat/agent.test.ts"',
      'new URL("../..", import.meta.url)',
      "proxy-record mode",
      "git diff --exit-code test/fixtures/",
    ],
  },
  {
    file: "apps/web/content/docs/testing-agents/fixtures.mdx",
    required: [
      "# Fixtures and Recording",
      "inline",
      "committed fixture file",
      "user text",
      "turnIndex",
      "hasToolResult",
      "`userMessage` compares against the latest user message that contains text",
      "`hasToolResult` examines only messages after the latest user message",
      "Earlier turns' tool results do not make the next turn's initial model call match `hasToolResult: true`",
      "writeFixtures",
      "loadFixtures",
      "supported top-level container",
      "does not validate every fixture entry",
      "does not fall back to a provider",
      "`turnIndex` mismatch is nonfatal by default",
      "AIMOCK_STRICT_TURN_INDEX=1",
      "Do not register the same fixture file at both scopes",
      "aimock selects the first registered matching fixture",
      "persist across later `h.run()` calls until `h.reset()`",
      "record: true",
      "getRecordedFixtures()",
      "one fresh-thread first run",
      "first user message in the captured request",
      "any tool-role message in the captured request",
      "zero-based index within only that latest run's captured calls",
      "not a safe way to mint a later-turn fixture for an already-active thread",
      "record({ out, provider? })",
      "separate process",
      "live: true",
      "registers no fixtures",
      "OPENAI_API_KEY",
      "process.cwd()",
      "relative to the test file",
      "await h.close()",
      "process-global",
      "fixture drift",
      'test -z "$(git status --porcelain -- test/fixtures/)"',
      "Never run live mode in CI",
    ],
    forbidden: [
      "proxy-record mode",
      "every test is offline",
      "Run-scoped fixtures",
      "validates the file shape",
      "git diff --exit-code test/fixtures/",
    ],
    forbiddenRegexes: [
      /`hasToolResult`[^.\n]*\b(?:any|all|anywhere)\b[^.\n]*\b(?:thread|conversation)\b/i,
      /(?:prior|earlier)[ -]turn tool results?[^.\n]*(?<!do not )(?:make|set|keep)[^.\n]*`hasToolResult`[^.\n]*true/i,
      /^const\s+\w+\s*=\s*await createAgentHarness\(\{[^\n]*live:\s*true/m,
      /getRecordedFixtures\(\)[^.\n]*cumulative `turnIndex`/i,
      /Replay is strict/i,
    ],
    requiredRegexes: [
      /createAgentHarness\(\{\s*appRoot,\s*route:\s*["']\/chat#agent["']\s*\}\)[\s\S]{0,500}?h\.run\(\{[\s\S]{0,300}?fixtures:\s*loadFixtures\(fixturesPath\)/,
      /createAgentHarness\(\{[\s\S]{0,300}?record:\s*true[\s\S]{0,300}?\}\)[\s\S]{0,800}?await\s+h\.run\([\s\S]{0,500}?getRecordedFixtures\(\)[\s\S]{0,300}?writeFixtures\(/,
      /record\(\{\s*out:\s*["'][^"']+["'](?:,\s*provider:\s*["'][^"']+["'])?\s*\}\)/,
      /it\.skipIf\(process\.env\.CI\s*\|\|\s*!process\.env\.OPENAI_API_KEY\)\([\s\S]{0,300}?async\s*\(\)\s*=>\s*\{[\s\S]{0,500}?createAgentHarness\(\{[\s\S]{0,200}?live:\s*true/,
    ],
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
      "Create `.dockerignore` before",
      ".env.*",
      "**/node_modules",
      "Keep `.dawn/build`",
      "image layer",
      "does not undo",
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
      "helm get values dawn-sandbox-infra --all",
      "complete intended subject list",
      "dawn-sandbox-infra-rbac-values.yaml",
    ],
    forbidden: ["/healthz proves dependency readiness", "HPA makes", "orchestrator.subjects[0]"],
  },
  {
    file: "apps/web/content/docs/sandbox.mdx",
    required: [
      "## Quickstart",
      "## What it is — and isn't",
      "Docker reference implementation",
      "--pids-limit 512",
      "resources.timeoutMs",
      "code `124`",
      "--network none",
      "best-effort",
      "preflight?():",
      "warnings?: readonly string[]",
      "pnpm add @dawn-ai/sandbox",
      'import type { SandboxHandle, SandboxPolicy } from "@dawn-ai/sandbox"',
      "Provider retention can shorten this lifecycle",
      "sandbox-docker-e2e",
      "/docs/sandbox/kubernetes",
      "collision-resistant, provider-safe canonical thread ID",
      "lossy sanitizer",
      "separate Docker daemon",
      "Mutually untrusted tenants must not share",
    ],
    forbidden: [
      "provider: kubernetesSandbox({",
      "helm upgrade --install dawn-sandbox-infra",
      'from "@dawn-ai/workspace"',
      'import type { SandboxHandle, SandboxPolicy, SandboxProvider } from "@dawn-ai/sandbox"',
      "workspace can survive idle reap, process restart, or compute replacement",
      "gives each Agent Protocol thread an isolated filesystem",
    ],
  },
  {
    file: "apps/web/content/docs/sandbox/kubernetes.mdx",
    required: [
      "# Kubernetes Sandbox",
      'namespace: "dawn-sandboxes"',
      "ReadWriteOnce",
      "automountServiceAccountToken: false",
      "policy-enforcing CNI",
      "DNS remains allowed",
      'network: { mode: "allow" }',
      "cannot override",
      "PID limits",
      "node/runtime",
      "Pod-create authorization only",
      "NetworkPolicy enforcement is unknown",
      "every unreferenced Dawn PVC",
      "still-live thread",
      "reaper.ttlHours",
      "scheduled reaper run deletes a currently unreferenced PVC",
      "stored marker is older than `reaper.ttlHours`",
      "reattachment resets the marker only if a reaper run observes",
      "short reattachment entirely between scheduled runs",
      "after recent use",
      "starts with an empty workspace",
      "tune `reaper.ttlHours` or disable the reaper",
      "emits no per-thread NetworkPolicy",
      "does not enforce `denylist`",
      "egress is open",
      "sandbox-k8s-e2e",
      "does not test DNS or blocked egress",
      "sandbox-k8s",
      "Calico",
      "combined evidence",
      "sleep infinity",
      "POSIX `sh`",
      "`timeout` when `resources.timeoutMs` is set",
      "UID/GID",
      "/docs/deployment/kubernetes",
      "collision-resistant, provider-safe canonical thread ID",
      "lossy sanitizer",
      "separate Kubernetes namespace",
      "Mutually untrusted tenants must not share",
    ],
    forbidden: [
      "helm install dawn-app",
      "helm upgrade --install dawn-app",
      "readOnlyRootFilesystem: false violates",
      "remains unreferenced longer than `reaper.ttlHours`",
      "Each conversation thread receives one keeper Pod",
    ],
  },
  {
    file: "apps/web/content/docs/configuration.mdx",
    required: [
      "# Configuration Reference",
      "/docs/persistence",
      "/docs/production-topology",
      "/docs/memory/long-term",
      "/docs/deployment",
      "/docs/sandbox",
      "reserved `tool` and `subagent` keys use exact matching",
      "resource paths, bash commands, and memory scopes use prefix matching",
      "stay in memory and do not seed the runtime permissions store",
      "three explicit entries",
      "application owns the pool",
      "records an env-file path, not variable names",
      "does not distribute active-run or cancel coordination",
      "injected `sandboxManager` takes precedence over `config.sandbox`",
      "injected `memoryStore` takes precedence over `config.memory.store`",
      'dockerSandbox({ image: "node:24-slim" })',
      "pnpm add @dawn-ai/postgres-storage pg",
    ],
    forbidden: [
      "dawn start loads",
      "before every CLI command and at runtime startup",
      "every commonly-used key",
      "#### Two entry points",
      "### What this does and does not run on",
      "### Storage shape and known limits",
      "dawn-sandbox:latest",
    ],
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
      "app-dedicated database",
      "default `public` schema",
      "default `dawn` table prefix",
      "no application namespace",
      "unique `schema` or `tablePrefix`",
      "hand-composed request stores",
    ],
    forbidden: [
      "Nothing else is gated",
      '```ts title="host.ts"',
      "generated Hono apps can safely share one database",
    ],
  },
  {
    file: "apps/web/content/docs/recipes/auth-middleware.mdx",
    required: [
      "execution authentication",
      "route-execution requests",
      "Thread create/read/delete/state",
      "cancellation",
      "memory-candidate management",
      "health checks",
      "outer host or reverse proxy",
      'href: "/docs/security-architecture", title: "Security Architecture"',
    ],
    forbidden: [
      "reject unauthenticated requests and pass the verified user identity to every tool call",
    ],
  },
  {
    file: "apps/web/content/docs/recipes/index.mdx",
    required: [
      "execution authentication",
      "thread management/state, cancellation, memory-candidate, and health routes",
      "outer host/proxy authentication",
    ],
    forbidden: ["short-circuit unauthorized requests"],
  },
  {
    file: "charts/dawn-app/templates/NOTES.txt",
    required: [
      "helm get values dawn-sandbox-infra --all",
      "complete intended subject list",
      "dawn-sandbox-infra-rbac-values.yaml",
    ],
    forbidden: ["orchestrator.subjects[0]", "same command shown above"],
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
      "Create or merge a secret-safe `.dockerignore` before",
      ".env.*",
      "**/node_modules",
      ".dawn/*",
      "!.dawn/build/**",
      "COPY . .",
      "image layer",
    ],
    forbidden: [
      "backend that does not exist yet",
      "until a shared threads and checkpoint backend ships",
      "langgraphjs dockerfile",
      "langgraphjs-built image",
      "image built the alternate way",
      "containerize the `langsmith` target",
      "generated Dockerfile copies only the files needed at runtime",
    ],
  },
  {
    file: "charts/dawn-app/values.yaml",
    required: [".dawn/build/server.mjs", "https://dawnai.org/docs/sandbox/kubernetes"],
    forbidden: [
      "apps/web/content/docs/sandbox.mdx",
      "# /docs/sandbox/kubernetes",
      "langgraphjs dockerfile",
      "langgraphjs-built image",
      "image built the alternate way",
      "containerize the langsmith target",
    ],
  },
  {
    file: "apps/web/content/docs/dev-server.mdx",
    required: [
      "child owns the HTTP listener",
      "default SQLite",
      "parent owns the app root, watcher, session, selected port, and stable URL across restarts",
      "replacement child reloads the app and `dawn.config.ts`",
      "Configuration edits take effect on that restart",
      "durable stores preserve data",
      "/docs/dev-server/agent-protocol",
      "/docs/ag-ui",
      "/docs/observability",
      "/docs/middleware",
      "/docs/security-architecture",
    ],
    forbidden: [
      "parent owns the HTTP server",
      "parent HTTP server is unaffected",
      "parent process keeps the HTTP server alive",
      "persisted-state configuration",
    ],
  },
  {
    file: "apps/web/content/docs/dev-server/agent-protocol.mdx",
    required: [
      "# Agent Protocol",
      "POST /threads",
      "GET /threads/:thread_id",
      "DELETE /threads/:thread_id",
      "GET /threads/:thread_id/state",
      "POST /threads/:thread_id/runs/wait",
      "POST /threads/:thread_id/runs/stream",
      "POST /threads/:thread_id/resume",
      "POST /threads/:thread_id/cancel",
      "GET /memory/candidates",
      "POST /memory/candidates/:id/approve",
      "POST /memory/candidates/:id/reject",
      ": ping",
      "not blanket server authentication",
      "`runs/wait`, `runs/stream`, and `resume`",
      "AG-UI route execution",
      "health routes bypass it",
      "every 15 seconds",
      "run_cancelled",
      "no_run_in_flight",
      'data: {"output":{"cancelled":true}}',
      "route failure",
      "process-local",
      "ordinary run-slot collision",
      "resume_in_progress",
      "resume claim is acquired before the run registry",
      "in-process",
      "thread-route map first",
      "persisted thread metadata",
      "last fallback",
      "does not redirect",
      "spans namespaces",
      "destructive",
      "tenant authorization",
      "outer authentication",
    ],
    forbidden: ["or `resume` request returns"],
    forbiddenRegexes: [/\b\d+\s+(?:HTTP\s+)?endpoints\b/i],
  },
  {
    file: "apps/web/content/docs/ag-ui.mdx",
    required: [
      "POST /agui/{routeId}",
      "%2Fchat%23agent",
      "@dawn-ai/ag-ui",
      "RunAgentInput.resume",
      "/docs/middleware",
      "/docs/security-architecture",
      "process-local",
      "run_in_flight",
      "ordinary run-slot collision",
      "resume_in_progress",
      "Agent Protocol viewer disconnects continue",
      "AG-UI viewer disconnects abort",
    ],
    forbidden: ["/docs/dev-server#ag-ui-endpoint", "the competing request"],
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

  for (const requiredRegex of contract.requiredRegexes ?? []) {
    requiredRegex.lastIndex = 0
    const containsRequiredText = requiredRegex.test(source)
    requiredRegex.lastIndex = 0
    if (!containsRequiredText) {
      failures.push(`${contract.file} is missing required accuracy pattern: ${requiredRegex}`)
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

// Configuration is the public DawnConfig schema reference. Parse property
// signatures through TypeScript's AST rather than indentation/brace regexes:
// the source interface contains nested literals, unions, callback signatures,
// comments, and an imported SandboxConfig. The explicit path inventory makes
// every public config addition or removal an intentional documentation change.
// Callback arguments and instance interfaces are leaves: they describe values
// assigned at one config path, not additional paths an app author configures.
function collectConfigSchemaPaths({ sources, rootInterface, expandInterfaces = [rootInterface] }) {
  const sourcePaths = sources.map((_, index) => `/configuration-schema-${index}.ts`)
  const virtualFiles = Object.fromEntries(
    sourcePaths.map((sourcePath, index) => [sourcePath, sources[index]]),
  )
  virtualFiles["/tsconfig.json"] = JSON.stringify({
    compilerOptions: { noLib: true },
    files: sourcePaths,
  })

  const api = new API({ cwd: "/", fs: createVirtualFileSystem(virtualFiles) })
  let snapshot
  try {
    snapshot = api.updateSnapshot({ openProjects: ["/tsconfig.json"] })
    const interfaces = new Map()
    const expandableInterfaces = new Set(expandInterfaces)
    for (const sourcePath of sourcePaths) {
      const project = snapshot.getDefaultProjectForFile(sourcePath)
      const sourceFile = project?.program.getSourceFile(sourcePath)
      for (const statement of sourceFile?.statements ?? []) {
        if (!isInterfaceDeclaration(statement)) continue
        const declarations = interfaces.get(statement.name.text) ?? []
        declarations.push(statement)
        interfaces.set(statement.name.text, declarations)
      }
    }

    const paths = new Set()
    const propertyName = (property) => {
      const name = property.name
      return isIdentifier(name) || isStringLiteral(name) ? name.text : null
    }

    const collectMembers = (members, prefix, stack) => {
      for (const member of members) {
        if (!isPropertySignatureDeclaration(member)) continue
        const name = propertyName(member)
        if (!name) continue
        const path = prefix ? `${prefix}.${name}` : name
        paths.add(path)
        if (member.type) collectType(member.type, path, stack)
      }
    }

    const collectInterface = (name, prefix, stack) => {
      if (stack.has(name)) return
      const declarations = interfaces.get(name)
      if (!declarations) return
      const nextStack = new Set([...stack, name])
      for (const declaration of declarations) {
        for (const clause of declaration.heritageClauses ?? []) {
          for (const heritageType of clause.types) {
            if (
              isExpressionWithTypeArguments(heritageType) &&
              isIdentifier(heritageType.expression)
            ) {
              collectInterface(heritageType.expression.text, prefix, nextStack)
            }
          }
        }
        collectMembers(declaration.members, prefix, nextStack)
      }
    }

    const collectType = (type, prefix, stack) => {
      if (isTypeLiteralNode(type)) {
        collectMembers(type.members, prefix, stack)
        return
      }
      if (isUnionTypeNode(type) || isIntersectionTypeNode(type)) {
        for (const memberType of type.types) collectType(memberType, prefix, stack)
        return
      }
      if (isParenthesizedTypeNode(type)) {
        collectType(type.type, prefix, stack)
        return
      }
      if (
        isTypeReferenceNode(type) &&
        isIdentifier(type.typeName) &&
        expandableInterfaces.has(type.typeName.text)
      ) {
        collectInterface(type.typeName.text, prefix, stack)
        return
      }
      if (!isIndexedAccessTypeNode(type)) return
      if (!isTypeReferenceNode(type.objectType) || !isIdentifier(type.objectType.typeName)) return
      if (!isLiteralTypeNode(type.indexType) || !isStringLiteral(type.indexType.literal)) return

      const declarations = interfaces.get(type.objectType.typeName.text)
      const selected = declarations
        ?.flatMap((declaration) => [...declaration.members])
        .find(
          (member) =>
            isPropertySignatureDeclaration(member) &&
            propertyName(member) === type.indexType.literal.text,
        )
      if (selected?.type) collectType(selected.type, prefix, stack)
    }

    collectInterface(rootInterface, "", new Set())
    return [...paths].sort()
  } finally {
    snapshot?.dispose()
    api.close()
  }
}

const schemaTraversalProbePaths = collectConfigSchemaPaths({
  expandInterfaces: ["BaseConfig", "MergedConfig"],
  rootInterface: "MergedConfig",
  sources: [
    `
      interface BaseConfig {
        inherited?: { nested?: boolean }
      }
      interface MergedConfig extends BaseConfig {
        direct?: string
      }
      interface MergedConfig {
        merged?: number
      }
    `,
  ],
})
const expectedSchemaTraversalProbePaths = ["direct", "inherited", "inherited.nested", "merged"]
if (
  JSON.stringify(schemaTraversalProbePaths) !== JSON.stringify(expectedSchemaTraversalProbePaths)
) {
  failures.push(
    `configuration schema AST traversal lost merged or inherited properties: expected ${expectedSchemaTraversalProbePaths.join(", ")}; received ${schemaTraversalProbePaths.join(", ")}`,
  )
}

const expectedDawnConfigSchemaPaths = [
  "appDir",
  "backends",
  "backends.exec",
  "backends.filesystem",
  "build",
  "build.targets",
  "checkpointer",
  "env",
  "memory",
  "memory.distill",
  "memory.distill.consolidate",
  "memory.distill.consolidate.maxBatchSize",
  "memory.distill.consolidate.minBatchSize",
  "memory.distill.consolidate.olderThanMs",
  "memory.distill.consolidate.sourceTtlMs",
  "memory.distill.consolidate.ttlMs",
  "memory.distill.maxBatches",
  "memory.distill.model",
  "memory.distill.provider",
  "memory.distill.reflect",
  "memory.distill.reflect.maxRecords",
  "memory.distill.reflect.minNewRecords",
  "memory.distill.reflect.writes",
  "memory.enabled",
  "memory.episodes",
  "memory.episodes.cap",
  "memory.episodes.embed",
  "memory.episodes.enabled",
  "memory.episodes.includeFailedRuns",
  "memory.episodes.ttlMs",
  "memory.indexMaxEntries",
  "memory.recall",
  "memory.recall.candidatePool",
  "memory.recall.recencyHalfLifeMs",
  "memory.recall.weights",
  "memory.recall.weights.confidence",
  "memory.recall.weights.recency",
  "memory.recall.weights.relevance",
  "memory.resolveScope",
  "memory.store",
  "memory.vector",
  "memory.vector.confidenceWeight",
  "memory.vector.embedder",
  "memory.vector.recencyWeight",
  "memory.vector.rrfK",
  "memory.vector.vectorK",
  "memory.vector.weights",
  "memory.vector.weights.keyword",
  "memory.vector.weights.vector",
  "memory.writes",
  "permissions",
  "permissions.allow",
  "permissions.deny",
  "permissions.mode",
  "permissions.store",
  "sandbox",
  "sandbox.env",
  "sandbox.idleTimeoutMs",
  "sandbox.network",
  "sandbox.network.allowlist",
  "sandbox.network.denylist",
  "sandbox.network.mode",
  "sandbox.provider",
  "sandbox.resources",
  "sandbox.resources.cpus",
  "sandbox.resources.diskGb",
  "sandbox.resources.memoryMb",
  "sandbox.resources.timeoutMs",
  "sandbox.security",
  "sandbox.security.dropAllCapabilities",
  "sandbox.security.noNewPrivileges",
  "sandbox.security.pidsLimit",
  "sandbox.security.readOnlyRootFilesystem",
  "sandbox.security.runAsNonRoot",
  "sandbox.security.runAsNonRoot.gid",
  "sandbox.security.runAsNonRoot.uid",
  "summarization",
  "summarization.enabled",
  "summarization.keepRecentTurns",
  "summarization.maxTokens",
  "summarization.model",
  "summarization.summarize",
  "summarization.tokenCounter",
  "threadsStore",
  "toolOutput",
  "toolOutput.gcThrottleMs",
  "toolOutput.maxBytes",
  "toolOutput.noOffloadTools",
  "toolOutput.offloadThresholdChars",
  "toolOutput.previewLines",
  "toolOutput.ttlMs",
].sort()

const dawnConfigSchemaPaths = collectConfigSchemaPaths({
  expandInterfaces: ["DawnConfig", "SandboxConfig", "SandboxSecurityPolicy"],
  rootInterface: "DawnConfig",
  sources: [
    readFileSync(resolve(repoRoot, "packages/core/src/types.ts"), "utf8"),
    readFileSync(resolve(repoRoot, "packages/workspace/src/sandbox-types.ts"), "utf8"),
  ],
})

if (JSON.stringify(dawnConfigSchemaPaths) !== JSON.stringify(expectedDawnConfigSchemaPaths)) {
  failures.push(
    `DawnConfig nested schema path inventory changed: expected ${expectedDawnConfigSchemaPaths.join(", ")}; received ${dawnConfigSchemaPaths.join(", ")}`,
  )
}

const configurationMdxSource = readFileSync(
  resolve(repoRoot, "apps/web/content/docs/configuration.mdx"),
  "utf8",
)
const completeConfigurationExample =
  /## Complete annotated example[\s\S]*?```ts[^\n]*\n([\s\S]*?)```/.exec(
    configurationMdxSource,
  )?.[1] ?? ""

const keyReferenceSource = configurationMdxSource.slice(
  configurationMdxSource.indexOf("## Key reference"),
  configurationMdxSource.indexOf("## Postgres backend"),
)
const documentedConfigSchemaSource = [
  "export interface DocumentedConfig {",
  ...[...keyReferenceSource.matchAll(/```ts[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]),
  "}",
].join("\n")
const documentedConfigSchemaPaths = collectConfigSchemaPaths({
  rootInterface: "DocumentedConfig",
  sources: [documentedConfigSchemaSource],
})

if (JSON.stringify(documentedConfigSchemaPaths) !== JSON.stringify(expectedDawnConfigSchemaPaths)) {
  failures.push(
    `apps/web/content/docs/configuration.mdx nested schema paths differ from DawnConfig: expected ${expectedDawnConfigSchemaPaths.join(", ")}; received ${documentedConfigSchemaPaths.join(", ")}`,
  )
}

for (const field of expectedDawnConfigSchemaPaths.filter((path) => !path.includes("."))) {
  if (!configurationMdxSource.includes(`### \`${field}\``)) {
    failures.push(
      `apps/web/content/docs/configuration.mdx is missing DawnConfig field heading: ${field}`,
    )
  }
  if (!new RegExp(`(?:^|\\W)${field}\\s*:`).test(completeConfigurationExample)) {
    failures.push(
      `apps/web/content/docs/configuration.mdx complete example is missing DawnConfig field: ${field}`,
    )
  }
}

for (const requiredExampleText of [
  '//   // network: { mode: "deny", allowlist: ["api.openai.com"] },',
  "//     // runAsNonRoot: { uid: 1000, gid: 1000 },",
]) {
  if (!completeConfigurationExample.includes(requiredExampleText)) {
    failures.push(
      `apps/web/content/docs/configuration.mdx complete example is missing schema alternative: ${requiredExampleText}`,
    )
  }
}

const appChartValuesSource = readFileSync(resolve(repoRoot, "charts/dawn-app/values.yaml"), "utf8")
const canonicalKubernetesSandboxUrl = "https://dawnai.org/docs/sandbox/kubernetes"
const canonicalKubernetesSandboxUrlCount =
  appChartValuesSource.split(canonicalKubernetesSandboxUrl).length - 1
if (canonicalKubernetesSandboxUrlCount !== 1) {
  failures.push(
    `charts/dawn-app/values.yaml must contain the canonical Kubernetes Sandbox URL exactly once; found ${canonicalKubernetesSandboxUrlCount}`,
  )
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
  "Create or merge a secret-safe `.dockerignore` before",
  ".env.*",
  ".git",
  "**/node_modules",
  "coverage",
  ".next",
  ".dawn/*",
  "!.dawn/build/**",
  "COPY . .",
  "image layer",
  "dawn check",
  "dawn build",
  "docker build -t ghcr.io/you/your-app:2026-08-10 .",
  "docker push ghcr.io/you/your-app:2026-08-10",
  "helm upgrade --install dawn-sandbox-infra",
]) {
  if (!chartReadmeSource.includes(required)) {
    failures.push(
      `charts/dawn-app/README.md copy-complete install prerequisite missing: ${required}`,
    )
  }
}
const chartReadmeDockerignore = chartReadmeSource.indexOf(
  "Create or merge a secret-safe `.dockerignore` before",
)
const chartReadmeDockerBuild = chartReadmeSource.indexOf(
  "docker build -t ghcr.io/you/your-app:2026-08-10 .",
)
if (chartReadmeDockerignore === -1 || chartReadmeDockerignore > chartReadmeDockerBuild) {
  failures.push(
    "charts/dawn-app/README.md must require its secret-safe .dockerignore before docker build",
  )
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
    file: "apps/web/content/docs/memory.mdx",
    retainedHeading: "Long-term collection (`memory.ts`)",
    canonicalHref: "/docs/memory/long-term",
  },
  {
    file: "apps/web/content/docs/memory.mdx",
    retainedHeading: "Generated tools",
    canonicalHref: "/docs/memory/long-term",
  },
  {
    file: "apps/web/content/docs/memory.mdx",
    retainedHeading: "How recall ranks",
    canonicalHref: "/docs/memory/retrieval",
  },
  {
    file: "apps/web/content/docs/memory.mdx",
    retainedHeading: "Semantic recall (opt-in)",
    canonicalHref: "/docs/memory/retrieval",
  },
  {
    file: "apps/web/content/docs/memory.mdx",
    retainedHeading: "Postgres backend (pgvector)",
    canonicalHref: "/docs/memory/retrieval",
  },
  {
    file: "apps/web/content/docs/memory.mdx",
    retainedHeading: "The injected index",
    canonicalHref: "/docs/memory/retrieval",
  },
  ...[
    "Episodic memory",
    "Enabling the run recorder",
    "What gets recorded",
    "Retention",
    "Time-windowed recall",
    "Governance",
    "Agent-authored episodes",
  ].map((retainedHeading) => ({
    file: "apps/web/content/docs/memory.mdx",
    retainedHeading,
    canonicalHref: "/docs/memory/episodes",
  })),
  {
    file: "apps/web/content/docs/memory.mdx",
    retainedHeading: "Distillation",
    canonicalHref: "/docs/memory/distillation",
    maxChars: 700,
  },
  ...[
    "Consolidation",
    "Reflection",
    "Distilled records are found by keyword",
    "Provenance",
    "Cost",
    "Running it on a schedule",
    "Distillation configuration",
  ].map((retainedHeading) => ({
    file: "apps/web/content/docs/memory.mdx",
    retainedHeading,
    canonicalHref: "/docs/memory/distillation",
  })),
  ...[
    "Write governance",
    "`ask` mode",
    "Reviewing candidates",
    "Configuration",
    "Testing",
    "Verifying against a real model",
    "What's deferred",
  ].map((retainedHeading) => ({
    file: "apps/web/content/docs/memory.mdx",
    retainedHeading,
    canonicalHref: "/docs/memory/long-term",
  })),
  {
    file: "apps/web/content/docs/deployment.mdx",
    retainedHeading: "Deploying to production (Node/Docker)",
    canonicalHref: "/docs/deployment/node",
  },
  {
    file: "apps/web/content/docs/deployment.mdx",
    retainedHeading: "Self-hosting",
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
  {
    file: "apps/web/content/docs/sandbox.mdx",
    retainedHeading: "Kubernetes provider",
    canonicalHref: "/docs/sandbox/kubernetes",
  },
  {
    file: "apps/web/content/docs/dev-server.mdx",
    retainedHeading: "Agent Protocol endpoints",
    canonicalHref: "/docs/dev-server/agent-protocol",
  },
  {
    file: "apps/web/content/docs/dev-server.mdx",
    retainedHeading: "SSE event types",
    canonicalHref: "/docs/dev-server/agent-protocol",
  },
  {
    file: "apps/web/content/docs/dev-server.mdx",
    retainedHeading: "Thread lifecycle with curl",
    canonicalHref: "/docs/dev-server/agent-protocol",
  },
  {
    file: "apps/web/content/docs/dev-server.mdx",
    retainedHeading: "One run at a time per thread",
    canonicalHref: "/docs/dev-server/agent-protocol",
  },
  {
    file: "apps/web/content/docs/dev-server.mdx",
    retainedHeading: "Client disconnect",
    canonicalHref: "/docs/dev-server/agent-protocol",
  },
  {
    file: "apps/web/content/docs/dev-server.mdx",
    retainedHeading: "AG-UI endpoint",
    canonicalHref: "/docs/ag-ui",
  },
  {
    file: "apps/web/content/docs/dev-server.mdx",
    retainedHeading: "Tracing",
    canonicalHref: "/docs/observability",
  },
  {
    file: "apps/web/content/docs/dev-server.mdx",
    retainedHeading: "Middleware",
    canonicalHref: "/docs/middleware",
  },
  {
    file: "apps/web/content/docs/sandbox.mdx",
    retainedHeading: "Security hardening on Kubernetes",
    canonicalHref: "/docs/sandbox/kubernetes",
  },
  {
    file: "apps/web/content/docs/sandbox.mdx",
    retainedHeading: "Network policy on Kubernetes",
    canonicalHref: "/docs/sandbox/kubernetes",
  },
  {
    file: "apps/web/content/docs/sandbox.mdx",
    retainedHeading: "Deploying the sandbox infrastructure (Helm)",
    canonicalHref: "/docs/sandbox/kubernetes",
  },
  {
    file: "apps/web/content/docs/sandbox.mdx",
    retainedHeading: "Key caveats",
    canonicalHref: "/docs/sandbox/kubernetes",
  },
  {
    file: "apps/web/content/docs/sandbox.mdx",
    retainedHeading: "Deploying a Dawn app (Helm)",
    canonicalHref: "/docs/sandbox/kubernetes",
  },
  {
    file: "apps/web/content/docs/sandbox.mdx",
    retainedHeading: "ServiceAccount and namespace wiring",
    canonicalHref: "/docs/sandbox/kubernetes",
  },
  {
    file: "apps/web/content/docs/sandbox.mdx",
    retainedHeading: "Env, secrets, and replicas",
    canonicalHref: "/docs/sandbox/kubernetes",
  },
  ...[
    "Fixture files: author, commit, replay",
    "Author inline and snapshot to a file",
    "Record from a real model (local only)",
    "Replay a fixture file in tests",
    "Live mode (real model)",
  ].map((retainedHeading) => ({
    file: "apps/web/content/docs/testing-agents.mdx",
    retainedHeading,
    canonicalHref: "/docs/testing-agents/fixtures",
  })),
  {
    file: "apps/web/content/docs/memory.mdx",
    retainedHeading: "Updating it",
    canonicalHref: "/docs/workspace",
  },
]

for (const { file, retainedHeading, canonicalHref, maxChars = 600 } of compatibilityStubContracts) {
  const filePath = resolve(repoRoot, file)
  if (!existsSync(filePath)) {
    failures.push(`${file} is missing`)
    continue
  }

  const source = readFileSync(filePath, "utf8")
  const analysis = analyzeCompatibilityStub({
    source,
    retainedHeading,
    canonicalHref,
    maxChars,
  })
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

function movedDeepLinks(legacyPath, canonicalHref, fragments) {
  return fragments.map((fragment) => ({
    legacyFile: docHrefToContentPath(legacyPath),
    legacyHref: `${legacyPath}#${fragment}`,
    canonicalHref,
  }))
}

const movedDeepLinkContracts = [
  ...movedDeepLinks("/docs/memory", "/docs/memory/long-term", [
    "long-term-collection-memoryts",
    "generated-tools",
    "write-governance",
    "ask-mode",
    "reviewing-candidates",
    "configuration",
    "testing",
    "verifying-against-a-real-model",
    "whats-deferred",
  ]),
  ...movedDeepLinks("/docs/memory", "/docs/memory/retrieval", [
    "how-recall-ranks",
    "semantic-recall-opt-in",
    "postgres-backend-pgvector",
    "the-injected-index",
  ]),
  ...movedDeepLinks("/docs/memory", "/docs/memory/episodes", [
    "episodic-memory",
    "enabling-the-run-recorder",
    "what-gets-recorded",
    "retention",
    "time-windowed-recall",
    "governance",
    "agent-authored-episodes",
  ]),
  ...movedDeepLinks("/docs/memory", "/docs/memory/distillation", [
    "distillation",
    "consolidation",
    "reflection",
    "distilled-records-are-found-by-keyword",
    "provenance",
    "cost",
    "running-it-on-a-schedule",
    "distillation-configuration",
  ]),
  ...movedDeepLinks("/docs/deployment", "/docs/deployment/node", [
    "deploying-to-production-nodedocker",
  ]),
  ...movedDeepLinks("/docs/deployment", "/docs/deployment/kubernetes", ["deploying-on-kubernetes"]),
  ...movedDeepLinks("/docs/deployment", "/docs/deployment/langsmith", [
    "the-langsmith--langgraph-platform-path",
  ]),
  ...movedDeepLinks("/docs/deployment", "/docs/deployment/edge", [
    "edge-runtimes",
    "the-dawn-aiclifetch-entry-point",
    "the-hono-build-target",
    "why-the-stores-are-per-request",
    "what-the-edge-cannot-serve",
    "what-is-proven-and-what-is-not",
  ]),
  ...movedDeepLinks("/docs/deployment", "/docs/deployment", [
    "what-dawn-does-not-do",
    "troubleshooting",
    "related",
  ]),
  ...movedDeepLinks("/docs/deployment", "/docs/deployment/node", ["self-hosting"]),
  ...movedDeepLinks("/docs/sandbox", "/docs/sandbox/kubernetes", [
    "kubernetes-provider",
    "security-hardening-on-kubernetes",
    "network-policy-on-kubernetes",
    "deploying-the-sandbox-infrastructure-helm",
    "key-caveats",
    "deploying-a-dawn-app-helm",
    "serviceaccount-and-namespace-wiring",
    "env-secrets-and-replicas",
  ]),
  ...movedDeepLinks("/docs/dev-server", "/docs/dev-server/agent-protocol", [
    "agent-protocol-endpoints",
    "sse-event-types",
    "thread-lifecycle-with-curl",
    "one-run-at-a-time-per-thread",
    "client-disconnect",
  ]),
  ...movedDeepLinks("/docs/dev-server", "/docs/ag-ui", ["ag-ui-endpoint"]),
  ...movedDeepLinks("/docs/dev-server", "/docs/observability", ["tracing"]),
  ...movedDeepLinks("/docs/dev-server", "/docs/middleware", ["middleware"]),
  ...movedDeepLinks("/docs/memory", "/docs/workspace", ["updating-it"]),
  ...movedDeepLinks("/docs/testing-agents", "/docs/testing-agents/fixtures", [
    "fixture-files-author-commit-replay",
    "author-inline-and-snapshot-to-a-file",
    "record-from-a-real-model-local-only",
    "replay-a-fixture-file-in-tests",
    "live-mode-real-model",
  ]),
]

const maintainedDeepLinkFiles = [
  ...walkFiles(resolve(repoRoot, "apps/web/content/docs"), (file) => file.endsWith(".mdx")),
  ...walkFiles(resolve(repoRoot, "packages"), (file) => basename(file) === "README.md"),
  ...walkFiles(resolve(repoRoot, "examples"), (file) => basename(file) === "README.md"),
]
for (const filePath of maintainedDeepLinkFiles) {
  const source = readFileSync(filePath, "utf8")
  failures.push(
    ...movedLinkGuardViolations(relativeToRoot(filePath), source, movedDeepLinkContracts).map(
      (violation) => `${violation} links a moved compatibility anchor`,
    ),
  )
}

function normalizeMaintainedDocsDestination(destination) {
  const [path] = destination.split("#")
  if (path === "/docs" || path?.startsWith("/docs/")) return destination
  try {
    const url = new URL(destination)
    if (
      url.protocol === "https:" &&
      url.hostname === "dawnai.org" &&
      (url.pathname === "/docs" || url.pathname.startsWith("/docs/"))
    ) {
      return `${url.pathname}${url.hash}`
    }
  } catch {
    // Relative non-doc links are outside the maintained docs topology.
  }
  return null
}

const canonicalOwnerContracts = [
  {
    file: "apps/web/content/docs/agents.mdx",
    heading: "Streaming",
    required: ["/docs/dev-server/agent-protocol"],
  },
  ...[
    "apps/web/content/docs/cli.mdx",
    "apps/web/content/docs/middleware.mdx",
    "apps/web/content/docs/mental-model.mdx",
    "apps/web/content/docs/observability.mdx",
    "apps/web/content/docs/planning.mdx",
    "apps/web/content/docs/recipes/dispatch-from-route.mdx",
    "apps/web/content/docs/recipes/stream-output.mdx",
    "apps/web/content/docs/subagents.mdx",
  ].map((file) => ({
    file,
    heading: "Related",
    required: ["/docs/dev-server/agent-protocol"],
  })),
  {
    file: "apps/web/content/docs/cli.mdx",
    heading: "dawn dev",
    required: ["/docs/dev-server/agent-protocol"],
  },
  {
    file: "apps/web/content/docs/observability.mdx",
    heading: "Live SSE streaming (no account required)",
    required: ["/docs/dev-server/agent-protocol"],
  },
  {
    file: "apps/web/content/docs/routes.mdx",
    heading: "Running a route",
    required: ["/docs/dev-server/agent-protocol"],
  },
  {
    file: "packages/ag-ui/README.md",
    heading: "@dawn-ai/ag-ui",
    required: ["/docs/ag-ui", "/docs/dev-server/agent-protocol"],
  },
  ...["dawn memory", "dawn inspect"].map((heading) => ({
    file: "apps/web/content/docs/cli.mdx",
    heading,
    required: ["/docs/memory/browse"],
  })),
  ...["Inspector", "Related"].map((heading) => ({
    file: "apps/web/content/docs/inspector.mdx",
    heading,
    required: ["/docs/memory/browse"],
  })),
  {
    file: "apps/web/content/docs/configuration.mdx",
    heading: "memory",
    required: [
      "/docs/memory/long-term",
      "/docs/memory/retrieval",
      "/docs/memory/episodes",
      "/docs/memory/distillation",
    ],
  },
  {
    file: "packages/memory-pgvector/README.md",
    heading: "@dawn-ai/memory-pgvector",
    required: ["/docs/memory/retrieval"],
  },
  {
    file: "apps/web/content/docs/permissions.mdx",
    heading: 'Memory write approval (writes: "ask")',
    required: ["/docs/memory/long-term"],
  },
  {
    file: "apps/web/content/docs/recipes/research-web-ui.mdx",
    heading: "Related",
    required: ["/docs/memory/long-term"],
  },
  ...["Execution: replay vs live", "Related"].map((heading) => ({
    file: "apps/web/content/docs/evals.mdx",
    heading,
    required: ["/docs/testing-agents/fixtures"],
  })),
  {
    file: "apps/web/content/docs/testing.mdx",
    heading: "Related",
    required: ["/docs/testing-agents/fixtures"],
  },
  {
    file: "packages/evals/README.md",
    heading: "@dawn-ai/evals",
    required: ["/docs/testing-agents/fixtures"],
  },
  {
    file: "apps/web/content/docs/api.mdx",
    heading: "Memory",
    required: ["/docs/memory/long-term"],
  },
  {
    file: "apps/web/content/docs/api.mdx",
    heading: "@dawn-ai/testing",
    required: ["/docs/testing-agents/fixtures"],
  },
  {
    file: "apps/web/content/docs/access-control.mdx",
    heading: "Execution sandbox — what a call can touch",
    required: ["/docs/sandbox/kubernetes"],
  },
  {
    file: "apps/web/content/docs/recipes/auth-middleware.mdx",
    heading: "Related",
    required: ["/docs/middleware"],
  },
]

for (const { file, heading, required } of canonicalOwnerContracts) {
  failures.push(
    ...canonicalOwnerGuardViolations(readFileSync(resolve(repoRoot, file), "utf8"), [
      { heading, required },
    ]).map((violation) => `${file} ${violation}`),
  )
}

const docsContentForLinkValidation = resolve(repoRoot, "apps/web/content/docs")
const maintainedDocsPages = new Map(
  walkFiles(docsContentForLinkValidation, (file) => file.endsWith(".mdx")).map((file) => {
    const relativePath = relative(docsContentForLinkValidation, file).replaceAll("\\", "/")
    const route = relativePath.endsWith("/index.mdx")
      ? `/docs/${relativePath.slice(0, -"/index.mdx".length)}`
      : `/docs/${relativePath.slice(0, -".mdx".length)}`
    const source = readFileSync(file, "utf8")
    const masked = maskMarkdownCodeAndComments(source)
    const slugger = new GithubSlugger()
    const headings = new Set(
      [...masked.matchAll(/^(?:#{1,6})\s+(.+?)[ \t]*$/gm)].flatMap((match) => {
        if (match.index === undefined) return []
        const lineEnd = source.indexOf("\n", match.index)
        const originalLine = source.slice(match.index, lineEnd === -1 ? source.length : lineEnd)
        const text = normalizeCodeSpans(
          originalLine
            .replace(/^[ \t]{0,3}#{1,6}[ \t]+/, "")
            .replace(/[ \t]+#+[ \t]*$/, "")
            .trim(),
        )
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/<[^>]+>/g, "")
          .trim()
        return [slugger.slug(text)]
      }),
    )
    return [route, headings]
  }),
)

const maintainedReadmeFiles = [
  ...walkFiles(resolve(repoRoot, "packages"), (file) => basename(file) === "README.md"),
  ...walkFiles(resolve(repoRoot, "examples"), (file) => basename(file) === "README.md"),
]
for (const filePath of maintainedReadmeFiles) {
  for (const destination of linkDestinations(readFileSync(filePath, "utf8"))) {
    const normalized = normalizeMaintainedDocsDestination(destination)
    if (!normalized) continue
    const [path, fragment] = normalized.split("#")
    const headings = maintainedDocsPages.get(path)
    if (!headings) {
      failures.push(`${relativeToRoot(filePath)} links missing docs page ${normalized}`)
    } else if (fragment && !headings.has(fragment)) {
      failures.push(`${relativeToRoot(filePath)} links missing docs heading ${normalized}`)
    }
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
  {
    pattern: /\brun\.url\b/,
    message: "uses legacy per-scenario run.url configuration",
  },
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
const apiReferenceRegistryPath = resolve(repoRoot, "apps/web/app/components/docs/api-reference.ts")
const apiReferencePagesPath = resolve(
  repoRoot,
  "apps/web/app/components/docs/api-reference-pages.ts",
)
const apiReferenceRegistry = await Promise.all([
  tsImport(pathToFileURL(apiReferenceRegistryPath).href, import.meta.url),
  tsImport(pathToFileURL(apiReferencePagesPath).href, import.meta.url),
])
  .then(([registry, pages]) => ({ ...registry, ...pages }))
  .catch((error) => {
    failures.push(
      `API reference registries could not be loaded from apps/web/app/components/docs (${error.message})`,
    )
    return null
  })
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
  { label: "Long-term Memory", href: "/docs/memory/long-term" },
  { label: "Recall and Retrieval", href: "/docs/memory/retrieval" },
  { label: "Episodes", href: "/docs/memory/episodes" },
  { label: "Distillation", href: "/docs/memory/distillation" },
  { label: "Planning", href: "/docs/planning" },
  { label: "Skills", href: "/docs/skills" },
  { label: "Subagents", href: "/docs/subagents" },
  { label: "Context Management", href: "/docs/context-management" },
  { label: "Reasoning Effort", href: "/docs/reasoning-effort" },
  { label: "Dev Server", href: "/docs/dev-server" },
  { label: "Agent Protocol", href: "/docs/dev-server/agent-protocol" },
  { label: "Middleware", href: "/docs/middleware" },
  { label: "AG-UI and Web Clients", href: "/docs/ag-ui" },
  { label: "Embed the Runtime", href: "/docs/embedding" },
  { label: "Blueprints", href: "/docs/blueprints" },
  { label: "Scenario Testing", href: "/docs/testing" },
  { label: "Agent Test Harness", href: "/docs/testing-agents" },
  { label: "Fixtures and Recording", href: "/docs/testing-agents/fixtures" },
  { label: "Evals", href: "/docs/evals" },
  { label: "Persistence and Tenancy", href: "/docs/persistence" },
  { label: "Production Topology", href: "/docs/production-topology" },
  { label: "Security Architecture", href: "/docs/security-architecture" },
  { label: "Access Control", href: "/docs/access-control" },
  { label: "Permissions", href: "/docs/permissions" },
  { label: "Retry", href: "/docs/retry" },
  { label: "Observability", href: "/docs/observability" },
  { label: "Inspector", href: "/docs/inspector" },
  { label: "Browse and Manage Memory", href: "/docs/memory/browse" },
  { label: "Upgrading", href: "/docs/upgrading" },
  { label: "Deployment Options", href: "/docs/deployment" },
  { label: "Node and Docker", href: "/docs/deployment/node" },
  { label: "Kubernetes", href: "/docs/deployment/kubernetes" },
  { label: "LangSmith", href: "/docs/deployment/langsmith" },
  { label: "Edge and Hono", href: "/docs/deployment/edge" },
  { label: "Execution Sandbox", href: "/docs/sandbox" },
  { label: "Kubernetes Sandbox", href: "/docs/sandbox/kubernetes" },
  { label: "Recipes Overview", href: "/docs/recipes" },
  { label: "Add a Tool", href: "/docs/recipes/add-a-tool" },
  { label: "Typed State", href: "/docs/recipes/typed-state" },
  { label: "Auth Middleware", href: "/docs/recipes/auth-middleware" },
  { label: "Stream Output", href: "/docs/recipes/stream-output" },
  {
    label: "Retry Transient Model Calls",
    href: "/docs/recipes/retry-flaky-tools",
  },
  { label: "Dispatch from a Route", href: "/docs/recipes/dispatch-from-route" },
  { label: "Research Assistant Web UI", href: "/docs/recipes/research-web-ui" },
  { label: "Configuration Reference", href: "/docs/configuration" },
  { label: "CLI Reference", href: "/docs/cli" },
  { label: "API Reference", href: "/docs/api" },
  { label: "Error Codes", href: "/docs/errors" },
  { label: "FAQ", href: "/docs/faq" },
]

if (/\bhref:\s*"\/docs"/.test(docsNav)) {
  failures.push("DOCS_NAV must omit the redirect-only /docs route")
}
if (!/export const DOCS_PAGES[^=]*=\s*DOCS_NAV\.flatMap\(/s.test(docsNav)) {
  failures.push("DOCS_PAGES must derive its reading order directly from DOCS_NAV")
}
if (!/export const ALL_DOCS_PAGES[^=]*=\s*DOCS_PAGES\.flatMap\(/s.test(docsNav)) {
  failures.push("ALL_DOCS_PAGES must derive from DOCS_PAGES and insert hidden reference leaves")
}
if (
  !/page\.href\s*===\s*"\/docs\/api"\s*\?\s*\[page,\s*\.\.\.API_REFERENCE_PAGES\]\s*:\s*\[page\]/s.test(
    docsNav,
  )
) {
  failures.push("ALL_DOCS_PAGES must insert API_REFERENCE_PAGES immediately after /docs/api")
}

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

if (apiReferenceRegistry) {
  const { API_REFERENCE_PAGES, ARTIFACT_REGISTRY, PACKAGE_CATALOG } = apiReferenceRegistry
  failures.push(
    ...analyzeApiReferenceRegistry({
      pages: API_REFERENCE_PAGES,
      artifacts: ARTIFACT_REGISTRY,
    }).failures,
  )

  const apiHubIndex = navDocEntries.findIndex(({ href }) => href === "/docs/api")
  const expectedAllDocsPages = [
    ...navDocEntries.slice(0, apiHubIndex + 1),
    ...API_REFERENCE_PAGES,
    ...navDocEntries.slice(apiHubIndex + 1),
  ]
  if (navDocEntries.length !== 58 || expectedAllDocsPages.length !== 68) {
    failures.push(
      `Docs page registries must retain 58 journey pages and 68 total pages; received ${navDocEntries.length} and ${expectedAllDocsPages.length}`,
    )
  }

  const artifactAddresses = ARTIFACT_REGISTRY.map(apiReferenceRegistry.artifactAddressFor)
  if (ARTIFACT_REGISTRY.length !== 46 || new Set(artifactAddresses).size !== 46) {
    failures.push("ARTIFACT_REGISTRY must contain exactly 46 unique artifact addresses")
  }
  const importCount = ARTIFACT_REGISTRY.filter(({ kind }) => kind === "import").length
  const operatedCount = ARTIFACT_REGISTRY.filter(({ kind }) => kind === "operated").length
  const generatedCount = ARTIFACT_REGISTRY.filter(({ kind }) => kind === "generated").length
  if (importCount !== 42 || operatedCount !== 3 || generatedCount !== 1) {
    failures.push(
      `ARTIFACT_REGISTRY must contain 42 imports, 3 operated artifacts, and 1 generated artifact; received ${importCount}, ${operatedCount}, and ${generatedCount}`,
    )
  }
  const expectedDeferredImports = [
    ["@dawn-ai/permissions", "."],
    ["@dawn-ai/permissions", "./node"],
    ["@dawn-ai/workspace", "."],
    ["@dawn-ai/workspace", "./node"],
    ["@dawn-ai/sandbox", "."],
    ["@dawn-ai/sandbox", "./testing"],
    ["@dawn-ai/langgraph", "."],
    ["@dawn-ai/langgraph", "./define-entry"],
    ["@dawn-ai/langgraph", "./route-module"],
    ["@dawn-ai/langchain", "."],
    ["@dawn-ai/langchain", "./package.json"],
    ["@dawn-ai/sqlite-storage", "."],
  ]
  const deferredImports = ARTIFACT_REGISTRY.filter(
    (artifact) => artifact.kind === "import" && artifact.coverage === "deferred-to-pr2",
  ).map(({ packageName, subpath }) => [packageName, subpath])
  if (JSON.stringify(deferredImports) !== JSON.stringify(expectedDeferredImports)) {
    failures.push("ARTIFACT_REGISTRY does not match the exact 12-import deferred-to-pr2 allowlist")
  }

  const invalidApplicationRecommendations = ARTIFACT_REGISTRY.filter(
    ({ coverage, audience }) =>
      (coverage === "catalog-only" || coverage === "internal") && audience === "application",
  )
  if (invalidApplicationRecommendations.length > 0) {
    failures.push("Catalog-only and internal artifacts cannot recommend an application audience")
  }

  try {
    apiReferenceRegistry.validateApiReferenceRegistries({
      pages: API_REFERENCE_PAGES,
      artifacts: ARTIFACT_REGISTRY,
      packages: PACKAGE_CATALOG,
    })
  } catch (error) {
    failures.push(`API reference registries violate their closed schemas (${error.message})`)
  }

  const { readPublicPackages } = await import("./lib/published-artifacts.mjs")
  const publicPackages = await readPublicPackages(repoRoot)
  failures.push(
    ...analyzeApiReferenceManifests({
      manifests: publicPackages.map(({ packageJson }) => packageJson),
      artifacts: ARTIFACT_REGISTRY,
    }).failures,
  )
  const publicPackageNames = publicPackages.map(({ packageJson }) => packageJson.name)
  const catalogPackageNames = PACKAGE_CATALOG.map(({ packageName }) => packageName)
  if (
    catalogPackageNames.length !== 21 ||
    JSON.stringify([...catalogPackageNames].sort()) !==
      JSON.stringify([...publicPackageNames].sort())
  ) {
    failures.push("PACKAGE_CATALOG must match readPublicPackages() bidirectionally with 21 records")
  }

  const artifactAddressesByPackage = new Map()
  for (const artifact of ARTIFACT_REGISTRY) {
    if (artifact.kind === "generated") continue
    const addresses = artifactAddressesByPackage.get(artifact.packageName) ?? []
    addresses.push(apiReferenceRegistry.artifactAddressFor(artifact))
    artifactAddressesByPackage.set(artifact.packageName, addresses)
  }
  for (const entry of PACKAGE_CATALOG) {
    const expectedAddresses = artifactAddressesByPackage.get(entry.packageName) ?? []
    if (
      JSON.stringify([...entry.artifactAddresses].sort()) !==
      JSON.stringify([...expectedAddresses].sort())
    ) {
      failures.push(`${entry.packageName} has incomplete or foreign artifactAddresses`)
    }
  }

  const referenceDestinationByPackage = new Map(
    API_REFERENCE_PAGES.flatMap((page) =>
      page.surfaceName === "dawn:routes"
        ? []
        : page.ownerPackageNames.map((packageName) => [packageName, page.href]),
    ),
  )
  for (const entry of PACKAGE_CATALOG) {
    const expectedDestination =
      referenceDestinationByPackage.get(entry.packageName) ??
      `/docs/api#${entry.packageName.replace(/^@/, "").replaceAll("/", "-")}`
    if (entry.canonicalReferenceDestination !== expectedDestination) {
      failures.push(
        `${entry.packageName} canonical reference destination must be ${expectedDestination}`,
      )
    }
  }
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
const apiReferencePageByHref = new Map(
  (apiReferenceRegistry?.API_REFERENCE_PAGES ?? []).map((page) => [page.href, page]),
)

for (const href of uniqueNavDocHrefs) {
  if (!contentDocHrefSet.has(href)) {
    failures.push(`DOCS_NAV references ${href}, but ${docHrefToContentPath(href)} is missing`)
  }
  if (!wrapperDocHrefSet.has(href)) {
    failures.push(`DOCS_NAV references ${href}, but ${docHrefToPagePath(href)} is missing`)
  }
}

const authoredRegisteredDocs = [
  ...navDocEntries,
  ...[...apiReferencePageByHref.values()].filter(
    ({ href }) => contentDocHrefSet.has(href) && wrapperDocHrefSet.has(href),
  ),
]

for (const { label, href } of authoredRegisteredDocs) {
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
  if (!navDocHrefSet.has(href) && !apiReferencePageByHref.has(href)) {
    failures.push(`Authored docs content for ${href} is not registered in DOCS_NAV`)
  } else if (apiReferencePageByHref.has(href) && !wrapperDocHrefSet.has(href)) {
    failures.push(`Authored API reference content for ${href} is missing its paired wrapper`)
  }
}

for (const href of wrapperDocHrefs) {
  if (!navDocHrefSet.has(href) && !apiReferencePageByHref.has(href)) {
    failures.push(`Docs wrapper for ${href} is not registered in DOCS_NAV`)
  } else if (apiReferencePageByHref.has(href) && !contentDocHrefSet.has(href)) {
    failures.push(`API reference wrapper for ${href} is missing its paired content`)
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

if (sdkEntry?.DAWN_ERRORS && docsBundle?.loadNav) {
  const registry = sdkEntry.DAWN_ERRORS
  const codes = Object.keys(registry)
  const navSlugs = new Set(
    (await docsBundle.loadNav(resolve(repoRoot, "apps/web/app/components/docs/nav.ts"))).map(
      (entry) => entry.slug,
    ),
  )

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
const frozenApiHeadingIds = [
  "api-reference",
  "package-and-surface-index",
  "reference-conventions",
  "dawn-aisdk",
  "agent",
  "agentconfig",
  "agentconfig-1",
  "reasoningconfig",
  "retryconfig",
  "dawnagent",
  "subagent-delegation-types",
  "isdawnagentvalue",
  "middleware",
  "definemiddlewarefn",
  "allowcontext",
  "rejectstatus-body",
  "dawnmiddleware",
  "middlewarerequest",
  "middlewareresult",
  "continueresult",
  "rejectresult",
  "memory",
  "definememorydef",
  "definedmemory",
  "memoryscopedimension",
  "route-configuration",
  "routeconfig",
  "routekind",
  "route-types",
  "routestatemap",
  "routetoolmap",
  "runtime",
  "runtimecontexttools",
  "runtimetool",
  "toolregistry",
  "dawntoolcontext",
  "workspacefs",
  "models",
  "knownmodelid",
  "modelproviderid",
  "openaimodelid",
  "googlemodelid",
  "anthropicmodelid",
  "xaimodelid",
  "inferprovidermodel",
  "supported_agent_providers",
  "validatemodelidopts",
  "modelidvalidation",
  "model-id-constants",
  "backend-adapter",
  "backendadapter",
  "utilities",
  "prettifyt",
  "dawn-aicli",
  "serveruntimeoptions",
  "loadstaticmodulesmanifesturl",
  "dawnstaticmodules-and-staticroutemodule",
  "dawn-aiclifetch",
  "dawn-aicliruntime",
  "dawn-aicore",
  "capability-exports",
  "createcapabilityregistrymarkers-and-applycapabilities",
  "gatetoolop-and-wraptoolwithapproval",
  "createworkspacefsoptions",
  "loaddawnconfigoptions-and-configvalue",
  "discoverroutesoptions-finddawnappoptions-and-route-segments",
  "state-and-typegen-helpers",
  "tool-scope",
  "storage-type-re-export",
  "dawn-aiag-ui",
  "id-factories",
  "toaguieventschunks-context",
  "fromrunagentinputinput",
  "sse-subpath-encodeaguisseevent-accept",
  "dawn-aimemory",
  "memorystore",
  "memoryrecord",
  "memoryquery",
  "browsequery-browsepage-and-memorystats",
  "dawn-aimemorybrowse",
  "dawn-aimemory-pgvector",
  "pgvectormemorystoreoptions",
  "pgvectormemorystore",
  "vectorcolumndefdimensions",
  "initschemaclient-options",
  "assertidentifiername-value",
  "dawn-aipostgres-storage",
  "postgresstoreoptions",
  "dawn-aipostgres-storagenode",
  "postgrescheckpointeroptions",
  "createpostgresthreadsstoreoptions",
  "createpostgrespermissionsstoreoptions",
  "assertidentifiername-value-1",
  "default_schema--default_table_prefix",
  "dawn-aitesting",
  "harnesses",
  "aimock-fixtures-and-recording",
  "matchers",
  "run-result-utilities",
  "memory-protocol-and-subprocess-helpers",
  "example",
  "dawn-aievals",
  "eval-definition-and-execution",
  "scores-and-gates",
  "built-in-scorers",
  "memory-scorers",
  "example-1",
  "dawnroutes-generated",
  "routetoolsp",
  "routestatep",
  "where-to-read-more",
  "related",
]
const apiHeadingIds = markdownHeadings(apiMdx).map(({ id }) => id)
const firstApiHeadingMismatch = Array.from(
  { length: Math.max(apiHeadingIds.length, frozenApiHeadingIds.length) },
  (_, index) => index,
).find((index) => apiHeadingIds[index] !== frozenApiHeadingIds[index])

if (firstApiHeadingMismatch !== undefined) {
  failures.push(
    `apps/web/content/docs/api.mdx heading ${firstApiHeadingMismatch + 1} mismatch: expected ${JSON.stringify(frozenApiHeadingIds[firstApiHeadingMismatch] ?? null)}, received ${JSON.stringify(apiHeadingIds[firstApiHeadingMismatch] ?? null)} (expected exactly ${frozenApiHeadingIds.length} ordered heading ids, received ${apiHeadingIds.length})`,
  )
}
const requiredApiPackageHeadings = [
  "@dawn-ai/sdk",
  "@dawn-ai/cli",
  "@dawn-ai/core",
  "@dawn-ai/ag-ui",
  "@dawn-ai/memory",
  "@dawn-ai/memory-pgvector",
  "@dawn-ai/postgres-storage",
  "@dawn-ai/testing",
  "@dawn-ai/evals",
]
for (const packageName of requiredApiPackageHeadings) {
  if (!apiMdx.split(/\r?\n/).includes(`## ${packageName}`)) {
    failures.push(`apps/web/content/docs/api.mdx is missing package heading: ${packageName}`)
  }
}

function collectExportedBindings(source) {
  const sourcePath = "/api-barrel.ts"
  const virtualFiles = {
    [sourcePath]: source,
    "/tsconfig.json": JSON.stringify({
      compilerOptions: { noLib: true },
      files: [sourcePath],
    }),
  }
  const api = new API({ cwd: "/", fs: createVirtualFileSystem(virtualFiles) })
  let snapshot
  try {
    snapshot = api.updateSnapshot({ openProjects: ["/tsconfig.json"] })
    const project = snapshot.getDefaultProjectForFile(sourcePath)
    const sourceFile = project?.program.getSourceFile(sourcePath)
    const bindings = new Set()

    for (const statement of sourceFile?.statements ?? []) {
      if (statement.kind === SyntaxKind.ExportDeclaration) {
        const clause = statement.exportClause
        if (clause?.kind === SyntaxKind.NamedExports) {
          for (const element of clause.elements) bindings.add(element.name.text)
        } else if (clause?.kind === SyntaxKind.NamespaceExport) {
          bindings.add(clause.name.text)
        }
        continue
      }

      if (!statement.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword)) {
        continue
      }
      if (isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (isIdentifier(declaration.name)) bindings.add(declaration.name.text)
        }
        continue
      }
      if (statement.name && isIdentifier(statement.name)) bindings.add(statement.name.text)
    }
    return bindings
  } finally {
    snapshot?.dispose()
    api.close()
  }
}

function typescriptCodeBlocks(markdown) {
  return [...markdown.matchAll(/```(?:ts|tsx|typescript)\b[^\r\n]*\r?\n([\s\S]*?)```/g)]
    .map((match) => match[1] ?? "")
    .join("\n")
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function referenceSection(markdown, heading, stopBeforeHeading) {
  const analysis = analyzeCompatibilityStub({
    source: markdown,
    retainedHeading: heading,
    canonicalHref: "",
    maxChars: Number.POSITIVE_INFINITY,
  })
  if (!analysis.found) return ""
  if (!stopBeforeHeading) return analysis.stub

  const masked = maskMarkdownCodeAndComments(analysis.stub)
  const boundary = new RegExp(`^#{1,6}\\s+${escapeRegex(stopBeforeHeading)}[ \\t]*$`, "m").exec(
    masked,
  )
  return boundary?.index === undefined ? analysis.stub : analysis.stub.slice(0, boundary.index)
}

function apiReferenceSection(heading, stopBeforeHeading) {
  return referenceSection(apiMdx, heading, stopBeforeHeading)
}

function documentedSectionBindings(markdown, heading, stopBeforeHeading) {
  return collectExportedBindings(
    typescriptCodeBlocks(referenceSection(markdown, heading, stopBeforeHeading)),
  )
}

// Mutation probes: comments, imports, and private declarations must not become
// false exported bindings; a named re-export (including an alias) must.
const exportBindingProbe = collectExportedBindings(`
// export const commentOnly = true
import { importOnly } from "./dependency.js"
const privateOnly = true
export const publicValue = true
export { sourceValue as aliasedValue } from "./dependency.js"
`)
for (const nonExport of ["commentOnly", "importOnly", "privateOnly", "sourceValue"]) {
  if (exportBindingProbe.has(nonExport)) {
    failures.push(`API export AST mutation probe false-positive: ${nonExport}`)
  }
}
for (const actualExport of ["publicValue", "aliasedValue"]) {
  if (!exportBindingProbe.has(actualExport)) {
    failures.push(`API export AST mutation probe missed export: ${actualExport}`)
  }
}

const rootScopeFixtures = [
  {
    heading: "@dawn-ai/cli",
    stopBeforeHeading: "@dawn-ai/cli/fetch",
    symbol: "ServeRuntimeHandle",
    rootDeclaration: "export interface ServeRuntimeHandle {}",
    markdown: `
## @dawn-ai/cli

\`\`\`ts
export interface ServeRuntimeHandle {}
\`\`\`

### @dawn-ai/cli/fetch

\`\`\`ts
export type { ServeRuntimeHandle } from "./nested.js"
\`\`\`
`,
  },
  {
    heading: "@dawn-ai/memory",
    stopBeforeHeading: "@dawn-ai/memory/browse",
    symbol: "MemoryStore",
    rootDeclaration: "export interface MemoryStore {}",
    markdown: `
## @dawn-ai/memory

\`\`\`ts
export interface MemoryStore {}
\`\`\`

### @dawn-ai/memory/browse

\`\`\`ts
export type { MemoryStore } from "./nested.js"
\`\`\`
`,
  },
]

for (const fixture of rootScopeFixtures) {
  const baseline = documentedSectionBindings(
    fixture.markdown,
    fixture.heading,
    fixture.stopBeforeHeading,
  )
  if (!baseline.has(fixture.symbol)) {
    failures.push(`API root-scope mutation probe baseline missed: ${fixture.symbol}`)
  }
  const rootDeleted = fixture.markdown.replace(fixture.rootDeclaration, "")
  const mutated = documentedSectionBindings(rootDeleted, fixture.heading, fixture.stopBeforeHeading)
  if (mutated.has(fixture.symbol)) {
    failures.push(
      `API root-scope mutation probe accepted nested-only declaration: ${fixture.symbol}`,
    )
  }
}

// Application-facing API reference ↔ public barrel authority. Each symbol must
// be an actual exported binding in its barrel and an exported declaration or
// re-export inside the owning API section's TypeScript blocks.
const apiSurfaceAuthorities = [
  {
    file: "packages/cli/src/index.ts",
    heading: "@dawn-ai/cli",
    stopBeforeHeading: "@dawn-ai/cli/fetch",
    symbols: [
      "serveRuntime",
      "ServeRuntimeHandle",
      "ServeRuntimeOptions",
      "loadStaticModules",
      "DawnStaticModules",
      "StaticRouteModule",
    ],
  },
  {
    file: "packages/cli/src/fetch-exports.ts",
    heading: "@dawn-ai/cli/fetch",
    symbols: [
      "createRuntimeFetchHandler",
      "RuntimeFetchHandler",
      "buildStaticRouteModule",
      "normalizeMiddlewareModule",
      "DawnStaticModules",
      "StaticRouteModule",
      "StaticRouteModuleInput",
      "StaticToolModuleInput",
      "RequestStores",
      "StartRuntimeServerOptions",
      "RuntimeEnv",
      "readRuntimeEnv",
      "seedDawnConfig",
      "seedRuntimeEnv",
      "seedModelImporter",
      "BootResolvedInstances",
      "RuntimeBootFallbacks",
      "StreamChunk",
    ],
  },
  {
    file: "packages/memory/src/index.ts",
    heading: "@dawn-ai/memory",
    stopBeforeHeading: "@dawn-ai/memory/browse",
    symbols: [
      "MemoryStore",
      "MemoryQuery",
      "MemoryRecord",
      "BrowseQuery",
      "BrowsePage",
      "MemoryStats",
    ],
  },
  {
    file: "packages/memory/src/browse.ts",
    heading: "@dawn-ai/memory/browse",
    symbols: [
      "BROWSE_CURSOR_VERSION",
      "browseCursorKey",
      "browseQueryFingerprint",
      "decodeBrowseCursor",
      "encodeBrowseCursor",
      "normalizeSetFilter",
      "DEFAULT_BROWSE_ORDER",
      "resolveBrowseOrder",
      "namespacePrefixUpperBound",
      "utcDayAfter",
      "utcDayStart",
      "BROWSE_DEFAULT_LIMIT",
      "BROWSE_MAX_LIMIT",
      "BROWSE_SORT_FIELDS",
      "BrowseQueryError",
      "validateBrowseQuery",
      "BrowseCursorPayload",
      "BrowseCursorValue",
      "ResolvedBrowseSort",
      "BrowseFilter",
      "BrowsePage",
      "BrowseQuery",
      "BrowseSortEntry",
      "BrowseSortField",
      "MemoryKind",
      "MemoryRecord",
      "MemorySource",
      "MemoryStatus",
    ],
  },
]

for (const authority of apiSurfaceAuthorities) {
  const source = readFileSync(resolve(repoRoot, authority.file), "utf8")
  const exportedBindings = collectExportedBindings(source)
  const section = apiReferenceSection(authority.heading, authority.stopBeforeHeading)
  const documentedBindings = collectExportedBindings(typescriptCodeBlocks(section))
  for (const symbol of authority.symbols) {
    if (!exportedBindings.has(symbol)) {
      failures.push(`${authority.file} no longer exports documented API symbol: ${symbol}`)
    }
    if (!documentedBindings.has(symbol)) {
      failures.push(
        `apps/web/content/docs/api.mdx section ${authority.heading} is missing an exported signature or definition for: ${symbol}`,
      )
    }
  }
}

function hasExactSubpathExport(manifest, subpath, expected) {
  const actual = manifest?.exports?.[subpath]
  return actual?.types === expected.types && actual?.default === expected.default
}

const apiSubpathAuthorities = [
  {
    manifest: "packages/cli/package.json",
    subpath: "./fetch",
    expected: {
      types: "./dist/fetch-exports.d.ts",
      default: "./dist/fetch-exports.js",
    },
  },
  {
    manifest: "packages/memory/package.json",
    subpath: "./browse",
    expected: { types: "./dist/browse.d.ts", default: "./dist/browse.js" },
  },
]

for (const authority of apiSubpathAuthorities) {
  const manifestPath = resolve(repoRoot, authority.manifest)
  const packageDir = manifestPath.replace(/\/package\.json$/, "")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (!hasExactSubpathExport(manifest, authority.subpath, authority.expected)) {
    failures.push(
      `${authority.manifest} ${authority.subpath} must point to ${JSON.stringify(authority.expected)}`,
    )
  }
  for (const target of Object.values(authority.expected)) {
    if (!existsSync(resolve(packageDir, target))) {
      failures.push(`${authority.manifest} ${authority.subpath} target is missing: ${target}`)
    }
  }

  const removed = JSON.parse(JSON.stringify(manifest))
  delete removed.exports[authority.subpath]
  if (hasExactSubpathExport(removed, authority.subpath, authority.expected)) {
    failures.push(`${authority.manifest} ${authority.subpath} removal mutation was not detected`)
  }
  const redirected = JSON.parse(JSON.stringify(manifest))
  redirected.exports[authority.subpath] = {
    ...authority.expected,
    default: "./dist/wrong.js",
  }
  if (hasExactSubpathExport(redirected, authority.subpath, authority.expected)) {
    failures.push(`${authority.manifest} ${authority.subpath} redirect mutation was not detected`)
  }
}
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

// Current protocol-ownership contract. This is deliberately a static list, not
// runtime route discovery: route matching is implemented with regex literals,
// and additions require an explicit product-doc decision about which page owns
// their public contract.
const agentProtocolDocsPath = resolve(
  repoRoot,
  "apps/web/content/docs/dev-server/agent-protocol.mdx",
)
const agentProtocolDocs = existsSync(agentProtocolDocsPath)
  ? readFileSync(agentProtocolDocsPath, "utf8")
  : ""
const agUiDocs = readFileSync(resolve(repoRoot, "apps/web/content/docs/ag-ui.mdx"), "utf8")
for (const required of [
  "POST /agui/{routeId}",
  "%2Fchat%23agent",
  "@dawn-ai/ag-ui",
  "RunAgentInput.resume",
]) {
  if (!agUiDocs.includes(required)) {
    failures.push(`apps/web/content/docs/ag-ui.mdx is missing AG-UI endpoint text: ${required}`)
  }
}

for (const endpoint of [
  "POST /threads/:thread_id/cancel",
  "GET /memory/candidates",
  "POST /memory/candidates/:id/approve",
  "POST /memory/candidates/:id/reject",
]) {
  if (!agentProtocolDocs.includes(endpoint)) {
    failures.push(
      `apps/web/content/docs/dev-server/agent-protocol.mdx is missing endpoint text: ${endpoint}`,
    )
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

const knownDocHrefs = new Set([
  ...uniqueNavDocHrefs,
  ...(apiReferenceRegistry?.API_REFERENCE_PAGES.map(({ href }) => href) ?? []),
])
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
