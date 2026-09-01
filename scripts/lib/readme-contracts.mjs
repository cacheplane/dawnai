const DESCRIPTION_MINIMUM_LENGTH = 30
const DESCRIPTION_MAXIMUM_LENGTH = 180
const KEYWORD_MINIMUM_COUNT = 3
const KEYWORD_MAXIMUM_COUNT = 8
const KEYWORD_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

const ROOT_HEADINGS = [
  "Quickstart",
  "Why Dawn",
  "How Dawn fits",
  "What Dawn writes for you",
  "What are you building?",
  "When Dawn fits",
  "Build with a coding agent",
  "Run it live",
  "Maturity and support",
]

const DEFAULT_PUBLIC_PACKAGE_TIERS = {
  entry: ["create-dawn-ai-app", "@dawn-ai/sdk", "@dawn-ai/cli"],
  capability: [
    "@dawn-ai/ag-ui",
    "@dawn-ai/evals",
    "@dawn-ai/inspector",
    "@dawn-ai/memory",
    "@dawn-ai/memory-pgvector",
    "@dawn-ai/permissions",
    "@dawn-ai/postgres-storage",
    "@dawn-ai/sandbox",
    "@dawn-ai/sqlite-storage",
    "@dawn-ai/testing",
    "@dawn-ai/workspace",
  ],
  tooling: [
    "@dawn-ai/core",
    "@dawn-ai/langchain",
    "@dawn-ai/langgraph",
    "@dawn-ai/vite-plugin",
    "@dawn-ai/devkit",
    "@dawn-ai/config-biome",
    "@dawn-ai/config-typescript",
  ],
}

const OLD_GIF_CAPTION = "Dawn quickstart — scaffold a route and invoke it in under a minute"
const ROOT_LINK_CONTRACTS = {
  migration: {
    relative: new Set(["/docs/migrating-from-langgraph"]),
    absolute: new Set(["https://dawnai.org/docs/migrating-from-langgraph"]),
  },
  transcript: {
    relative: new Set(["docs/brand/demo/transcript.md", "./docs/brand/demo/transcript.md"]),
    absolute: new Set([
      "https://github.com/cacheplane/dawnai/blob/main/docs/brand/demo/transcript.md",
    ]),
  },
}

const CANONICAL_ROOT_HERO = `<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/dawn-logo-horizontal-white-on-black.png">
    <img src="docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="360">
  </picture>
</p>

<p align="center"><strong>TypeScript meta-framework for LangGraph.js</strong></p>

# Build LangGraph agents like Next.js apps.

Dawn adds file-system routes, shared and route-local tools, generated types,
deterministic tests, durable threads, and build targets around LangGraph.js.
Keep the runtime. Drop the boilerplate.`

const CANONICAL_ROOT_BADGES = `<p align="center">
  <a href="https://www.npmjs.com/package/create-dawn-ai-app"><img src="https://img.shields.io/npm/v/create-dawn-ai-app?label=create-dawn-ai-app" alt="create-dawn-ai-app npm version"></a>
  <a href="https://github.com/cacheplane/dawnai/actions/workflows/ci.yml"><img src="https://github.com/cacheplane/dawnai/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-111827.svg" alt="MIT license"></a>
  <a href="https://github.com/cacheplane/dawnai/stargazers"><img src="https://img.shields.io/github/stars/cacheplane/dawnai" alt="GitHub stars"></a>
  <a href="https://github.com/cacheplane/dawnai/actions/workflows/scorecard.yml"><img src="https://github.com/cacheplane/dawnai/actions/workflows/scorecard.yml/badge.svg" alt="OpenSSF Scorecard"></a>
</p>`

const CANONICAL_ROOT_NAVIGATION = `<p align="center">
  <a href="https://dawnai.org/docs/getting-started">Get started</a> ·
  <a href="https://dawnai.org/docs/migrating-from-langgraph">Migrate from LangGraph.js</a> ·
  <a href="https://dawnai.org/docs">Documentation</a> ·
  <a href="https://github.com/cacheplane/dawnai/discussions">Discussions</a>
</p>`

const CANONICAL_PRODUCT_LOOP_BLOCK = `<p align="center">
  <a href="https://dawnai.org/#product-loop">
    <img src="docs/brand/product-loop.gif" alt="Animation showing an existing generated research workspace, a deterministic test, and the Dawn Workbench" width="900">
  </a>
</p>`

const CANONICAL_QUICKSTART_BLOCK = `Requires Node.js 24 or later.

\`\`\`bash
npm create dawn-ai-app@latest my-agent
cd my-agent
npm install
npm test
\`\`\``

const CANONICAL_TRANSCRIPT_LINK =
  "[Read the product-loop transcript](docs/brand/demo/transcript.md)."
const CANONICAL_FINAL_CTA = `Ready to start?

\`\`\`bash
npm create dawn-ai-app@latest my-agent
\`\`\``
const CANONICAL_LICENSE_SECTION = "## License\n\nMIT. See [LICENSE](./LICENSE)."
const CANONICAL_PROVIDER_CREDENTIAL_GUIDANCE = `Credentials are provider-specific: the published research starter's OpenAI live
path requires \`OPENAI_API_KEY\`, while a local Ollama route requires no provider
key.`

const COMMONMARK_BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul",
])
const RAW_TEXT_HTML_BLOCK_TAGS = new Set(["script", "style", "textarea"])

function maskText(value) {
  return value.replace(/[^\r\n]/gu, " ")
}

function blockquoteContainer(line) {
  let index = 0
  let depth = 0
  while (index < line.length) {
    let marker = index
    let spacesBeforeMarker = 0
    while (spacesBeforeMarker < 3 && line[marker] === " ") {
      marker++
      spacesBeforeMarker++
    }
    if (line[marker] !== ">") break
    index = marker + 1
    if (line[index] === " " || line[index] === "\t") index++
    depth++
  }
  return { content: line.slice(index), depth }
}

function indentationColumns(line) {
  let columns = 0
  for (const character of line) {
    if (character === " ") {
      columns++
      continue
    }
    if (character === "\t") {
      columns += 4 - (columns % 4)
      continue
    }
    break
  }
  return columns
}

function stripFenceIndent(line) {
  let index = 0
  while (index < 3 && line[index] === " ") index++
  return line.slice(index)
}

function listContainers(line) {
  const initialIndent = /^[ \t]*/u.exec(line)?.[0] ?? ""
  if (indentationColumns(initialIndent) >= 4) {
    return { content: line, indentedCode: true, listIndentColumns: 0 }
  }

  let index = initialIndent.length
  let columns = indentationColumns(initialIndent)
  let listIndentColumns = 0
  let foundList = false
  while (true) {
    const marker = /^(?:[-+*]|\d+[.)])/u.exec(line.slice(index))?.[0]
    if (!marker || !/[ \t]/u.test(line[index + marker.length])) break
    foundList = true
    index += marker.length
    columns += marker.length

    const whitespaceStart = index
    const columnsBeforeWhitespace = columns
    while (line[index] === " " || line[index] === "\t") {
      if (line[index] === " ") columns++
      else columns += 4 - (columns % 4)
      index++
    }
    if (columns - columnsBeforeWhitespace > 4) {
      return {
        content: line.slice(whitespaceStart),
        indentedCode: true,
        listIndentColumns: columnsBeforeWhitespace + 1,
      }
    }
    listIndentColumns = columns

    if (indentationColumns(line.slice(index)) >= 4) {
      return {
        content: line.slice(index),
        indentedCode: true,
        listIndentColumns,
      }
    }

    const nestedIndent = /^[ ]{0,3}/u.exec(line.slice(index))?.[0] ?? ""
    const nestedIndex = index + nestedIndent.length
    if (!/^(?:[-+*]|\d+[.)])[ \t]/u.test(line.slice(nestedIndex))) break
    index = nestedIndex
    columns += nestedIndent.length
  }

  return {
    content: foundList ? line.slice(index) : line,
    indentedCode: false,
    listIndentColumns,
  }
}

function contentAfterIndent(line, requiredColumns) {
  let columns = 0
  let index = 0
  while (columns < requiredColumns) {
    if (line[index] === " ") {
      columns++
      index++
      continue
    }
    if (line[index] === "\t") {
      columns += 4 - (columns % 4)
      index++
      continue
    }
    return null
  }
  return line.slice(index)
}

function fenceOpening(line) {
  const container = blockquoteContainer(line)
  const lists = listContainers(container.content)
  if (lists.indentedCode) return null

  const candidate = stripFenceIndent(lists.content)
  const match = /^(`{3,}|~{3,})(.*)$/u.exec(candidate)
  const opening = match?.[1]
  if (!opening || (opening[0] === "`" && match?.[2]?.includes("`"))) return null
  return {
    character: opening[0],
    length: opening.length,
    listIndentColumns: lists.listIndentColumns,
    quoteDepth: container.depth,
  }
}

function closingFenceRun(line, fence) {
  const container = blockquoteContainer(line)
  if (container.depth !== fence.quoteDepth) return null
  const content = contentAfterIndent(container.content, fence.listIndentColumns)
  if (content === null) return null
  return /^([`~]+)[ \t]*$/u.exec(stripFenceIndent(content))?.[1] ?? null
}

function isCompleteHtmlTag(source) {
  return /^(?:<\/[a-z][a-z0-9-]*[ \t]*>|<[a-z][a-z0-9-]*(?:[ \t]+[a-z_:][a-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*[ \t]*\/?>)[ \t]*$/iu.test(
    source,
  )
}

function rawHtmlBlockOpening(line) {
  const container = blockquoteContainer(line)
  const lists = listContainers(container.content)
  if (lists.indentedCode) return null

  const candidate = stripFenceIndent(lists.content)
  const location = {
    listIndentColumns: lists.listIndentColumns,
    quoteDepth: container.depth,
    openingContent: candidate,
  }
  if (candidate.startsWith("<?")) {
    return {
      ...location,
      kind: "processing-instruction",
      projection: "suppressed",
      termination: { type: "sequence", value: "?>" },
    }
  }
  if (candidate.startsWith("<![CDATA[")) {
    return {
      ...location,
      kind: "cdata",
      projection: "suppressed",
      termination: { type: "sequence", value: "]]>" },
    }
  }
  if (/^<![A-Z]/u.test(candidate)) {
    return {
      ...location,
      kind: "declaration",
      projection: "suppressed",
      termination: { type: "sequence", value: ">" },
    }
  }

  const explicitCloseTag = /^<(pre|script|style|textarea)(?=[\s>])/iu
    .exec(candidate)?.[1]
    ?.toLowerCase()
  if (explicitCloseTag) {
    return {
      ...location,
      kind: explicitCloseTag === "pre" ? "pre" : "raw-text",
      projection: RAW_TEXT_HTML_BLOCK_TAGS.has(explicitCloseTag) ? "suppressed" : "rendered",
      termination: { type: "closing-tag", tag: explicitCloseTag },
    }
  }

  const blockTag = /^<\/?([a-z][a-z0-9-]*)(?=[\s/>])/iu.exec(candidate)?.[1]?.toLowerCase()
  if (!blockTag || !COMMONMARK_BLOCK_TAGS.has(blockTag)) {
    if (!isCompleteHtmlTag(candidate)) return null
    return {
      ...location,
      kind: "complete-tag",
      projection: "rendered",
      termination: { type: "blank-line" },
    }
  }
  return {
    ...location,
    kind: "block-tag",
    projection: "rendered",
    termination: { type: "blank-line" },
  }
}

function htmlBlockEnds(line, htmlBlock) {
  if (htmlBlock.termination.type === "blank-line") {
    return line.trim().length === 0
  }
  if (htmlBlock.termination.type === "sequence") {
    return line.includes(htmlBlock.termination.value)
  }
  return new RegExp(`</${htmlBlock.termination.tag}[ \\t]*>`, "iu").test(line)
}

function markdownBlockProjections(source) {
  let fence = null
  let htmlBlock = null
  const markdown = []
  const rendered = []
  const append = (markdownLine, renderedLine = markdownLine) => {
    markdown.push(markdownLine)
    rendered.push(renderedLine)
  }

  for (const line of source.split(/(?<=\n)/u)) {
    const content = line.replace(/\r?\n$/u, "")
    if (fence) {
      const container = blockquoteContainer(content)
      const listContainerEnded =
        fence.listIndentColumns > 0 &&
        content.trim().length > 0 &&
        contentAfterIndent(container.content, fence.listIndentColumns) === null
      if (container.depth < fence.quoteDepth || listContainerEnded) {
        fence = null
      } else {
        const closing = closingFenceRun(content, fence)
        if (
          closing &&
          closing.length >= fence.length &&
          [...closing].every((character) => character === fence.character)
        ) {
          fence = null
        }
        append(maskText(line))
        continue
      }
    }

    if (htmlBlock) {
      const container = blockquoteContainer(content)
      const contentWithinList = contentAfterIndent(container.content, htmlBlock.listIndentColumns)
      const containerEnded =
        container.depth < htmlBlock.quoteDepth ||
        (htmlBlock.listIndentColumns > 0 && content.trim().length > 0 && contentWithinList === null)
      if (containerEnded) {
        htmlBlock = null
      } else if (htmlBlockEnds(contentWithinList ?? "", htmlBlock)) {
        const endedBlock = htmlBlock
        htmlBlock = null
        if (endedBlock.termination.type !== "blank-line") {
          append(maskText(line), endedBlock.projection === "rendered" ? line : maskText(line))
          continue
        }
      } else {
        append(maskText(line), htmlBlock.projection === "rendered" ? line : maskText(line))
        continue
      }
    }

    const container = blockquoteContainer(content)
    if (listContainers(container.content).indentedCode) {
      append(maskText(line))
      continue
    }

    const htmlOpening = rawHtmlBlockOpening(content)
    if (htmlOpening) {
      const { openingContent, ...block } = htmlOpening
      if (!htmlBlockEnds(openingContent, block)) htmlBlock = block
      append(maskText(line), block.projection === "rendered" ? line : maskText(line))
      continue
    }

    const opening = fenceOpening(content)
    if (opening) {
      fence = opening
      append(maskText(line))
      continue
    }
    append(line)
  }

  return { markdown: markdown.join(""), rendered: rendered.join("") }
}

function maskHtmlComments(source) {
  const blockProjections = markdownBlockProjections(source)
  const inlineMasked = maskInlineCode(blockProjections.rendered)
  const characters = source.split("")
  let index = 0
  while (index < source.length) {
    if (!source.startsWith("<!--", index) || isEscaped(source, index)) {
      index++
      continue
    }

    const renderedHtmlOpener = blockProjections.rendered.startsWith("<!--", index)
    const insideRawHtml = renderedHtmlOpener && !blockProjections.markdown.startsWith("<!--", index)
    const outsideLiteralContext = inlineMasked.startsWith("<!--", index)
    if (!insideRawHtml && !outsideLiteralContext) {
      index += 4
      continue
    }

    const closing = source.indexOf("-->", index + 4)
    const commentEnd = closing === -1 ? source.length : closing + 3
    for (let commentIndex = index; commentIndex < commentEnd; commentIndex++) {
      if (characters[commentIndex] !== "\r" && characters[commentIndex] !== "\n") {
        characters[commentIndex] = " "
      }
    }
    index = commentEnd
  }
  return characters.join("")
}

function htmlTagEnd(source, start) {
  let quote = null
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index]
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === ">") return index
  }
  return -1
}

function maskNestedRawTextElements(source) {
  const characters = source.split("")
  let index = 0
  while (index < source.length) {
    if (source[index] !== "<" || isEscaped(source, index)) {
      index++
      continue
    }

    const openingTag = /^<([a-z][a-z0-9-]*)(?=[\s/>])/iu
      .exec(source.slice(index))?.[1]
      ?.toLowerCase()
    const openingEnd = htmlTagEnd(source, index)
    if (openingEnd === -1) break
    if (!openingTag || !RAW_TEXT_HTML_BLOCK_TAGS.has(openingTag)) {
      index = openingEnd + 1
      continue
    }

    const closingPattern = new RegExp(`</${openingTag}[ \\t\\r\\n]*>`, "giu")
    closingPattern.lastIndex = openingEnd + 1
    const closing = closingPattern.exec(source)
    const rawTextEnd = closing ? closing.index + closing[0].length : source.length
    for (let rawIndex = index; rawIndex < rawTextEnd; rawIndex++) {
      if (characters[rawIndex] !== "\r" && characters[rawIndex] !== "\n") {
        characters[rawIndex] = " "
      }
    }
    index = rawTextEnd
  }
  return characters.join("")
}

function codeSpanDelimiterLength(source, start) {
  let end = start
  while (source[end] === "`") end++
  return end - start
}

function inlineCodeEnd(source, start, delimiterLength) {
  let index = start + delimiterLength
  while (index < source.length && source[index] !== "\r" && source[index] !== "\n") {
    if (source[index] !== "`") {
      index++
      continue
    }
    const candidateLength = codeSpanDelimiterLength(source, index)
    if (candidateLength === delimiterLength) return index + delimiterLength
    index += candidateLength
  }
  return -1
}

function maskInlineCode(source) {
  const characters = source.split("")
  let index = 0
  while (index < source.length) {
    if (source[index] !== "`") {
      index++
      continue
    }
    const delimiterLength = codeSpanDelimiterLength(source, index)
    const end = inlineCodeEnd(source, index, delimiterLength)
    if (end === -1) {
      index += delimiterLength
      continue
    }
    for (let characterIndex = index; characterIndex < end; characterIndex++) {
      characters[characterIndex] = " "
    }
    index = end
  }
  return characters.join("")
}

function visibleBlockProjections(source) {
  const projections = markdownBlockProjections(maskHtmlComments(source))
  return {
    markdown: maskInlineCode(projections.markdown),
    rendered: maskNestedRawTextElements(maskInlineCode(projections.rendered)),
  }
}

function markdownHeadings(source) {
  const visible = markdownBlockProjections(maskHtmlComments(source)).markdown
  return [...visible.matchAll(/^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/gmu)].map((match) => ({
    index: match.index,
    level: match[1].length,
    text: match[2].replace(/[ \t]+#+[ \t]*$/u, "").trim(),
  }))
}

function hasHeading(headings, names) {
  const accepted = new Set(names.map((name) => name.toLowerCase()))
  return headings.some((heading) => accepted.has(heading.text.toLowerCase()))
}

function hasPurposeStatement(readme, firstH1, headings) {
  if (!firstH1) return false
  const nextHeading = headings.find((heading) => heading.index > firstH1.index)
  const h1LineEnd = readme.indexOf("\n", firstH1.index)
  const body = readme.slice(h1LineEnd === -1 ? readme.length : h1LineEnd + 1, nextHeading?.index)
  const visible = visibleBlockProjections(body).rendered
  return visible
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some(
      (line) =>
        /[\p{L}\p{N}][\p{L}\p{N}-]*\s+[\p{L}\p{N}]/u.test(line) &&
        !line.startsWith("**Use this when:**") &&
        !/^[-*_]{3,}$/u.test(line) &&
        !/^[-*+>]?(?:\s*$|\s+)/u.test(line) &&
        !/^\d+[.)]\s+/u.test(line) &&
        !/^\|/u.test(line) &&
        !/^\[[^\]]+\]:/u.test(line) &&
        !/^<?(?:img|picture|source)\b/iu.test(line) &&
        !/^!?\[[^\]]*\]/u.test(line) &&
        !/^</u.test(line),
    )
}

function productLoopImagePresent(markdownSource, htmlSource) {
  return (
    /!\[[^\]]*\]\([^\r\n)]*docs\/brand\/product-loop\.gif(?:[?#][^\r\n)]*)?\)/iu.test(
      markdownSource,
    ) ||
    /<img\b[^>]*\bsrc=["'][^"']*docs\/brand\/product-loop\.gif(?:[?#][^"']*)?["'][^>]*>/iu.test(
      htmlSource,
    )
  )
}

function matchingDelimiterEnd(source, start, opening, closing) {
  let depth = 0
  for (let index = start; index < source.length; index++) {
    if (source[index] === "\\") {
      index++
      continue
    }
    if (source[index] === opening) depth++
    if (source[index] !== closing) continue
    depth--
    if (depth === 0) return index
  }
  return -1
}

function isEscaped(source, index) {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) {
    backslashes++
  }
  return backslashes % 2 === 1
}

function validLinkTitle(value) {
  if (value.length === 0) return true
  return /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))$/u.test(value)
}

function linkDestination(linkBody) {
  const body = linkBody.trim()
  if (body.length === 0) return null
  if (body.startsWith("<")) {
    const closing = body.indexOf(">")
    const suffix = body.slice(closing + 1)
    if (
      closing === -1 ||
      (suffix.length > 0 && !/^\s/u.test(suffix)) ||
      !validLinkTitle(suffix.trim())
    ) {
      return null
    }
    return body.slice(1, closing)
  }

  let depth = 0
  let destinationEnd = body.length
  for (let index = 0; index < body.length; index++) {
    if (body[index] === "\\") {
      index++
      continue
    }
    if (body[index] === "(") depth++
    if (body[index] === ")") depth--
    if (/\s/u.test(body[index]) && depth === 0) {
      destinationEnd = index
      break
    }
  }
  if (!validLinkTitle(body.slice(destinationEnd).trim())) return null
  return body.slice(0, destinationEnd)
}

function markdownLinkDestinations(source) {
  const destinations = []
  for (let index = 0; index < source.length; index++) {
    if (
      source[index] !== "[" ||
      (source[index - 1] === "!" && !isEscaped(source, index - 1)) ||
      isEscaped(source, index)
    ) {
      continue
    }
    const labelEnd = matchingDelimiterEnd(source, index, "[", "]")
    if (labelEnd === -1 || source[labelEnd + 1] !== "(") continue
    if (markdownLinkDestinations(source.slice(index + 1, labelEnd)).length > 0) {
      index = labelEnd
      continue
    }
    const linkEnd = matchingDelimiterEnd(source, labelEnd + 1, "(", ")")
    if (linkEnd === -1) continue
    const destination = linkDestination(source.slice(labelEnd + 2, linkEnd))
    if (destination) destinations.push(destination)
    index = linkEnd
  }
  return destinations
}

function markdownLinkPresent(source, contract) {
  return markdownLinkDestinations(source).some((destination) => {
    if (!/^https?:\/\//iu.test(destination)) {
      return contract.relative.has(destination.split(/[?#]/u, 1)[0])
    }
    try {
      const url = new URL(destination)
      if (url.username || url.password) return false
      return contract.absolute.has(`${url.origin}${url.pathname}`)
    } catch {
      return false
    }
  })
}

function canonicalScaffoldCommandPresent(source) {
  return /(?:^|[\s`$>])npm create dawn-ai-app@latest my-agent(?=$|[\s`'";|&])/mu.test(source)
}

function universalCredentialClaimPresent(source) {
  const withoutNegatedClaims = source.replace(
    /\bnot\s+(?:all|every)\s+live model calls?\s+(?:requires?|needs?)\s+(?:an?\s+)?(?:api\s+)?(?:key|credentials)\b/giu,
    "",
  )
  return [
    /\b(?:all|every)\s+live model calls?\s+(?:requires?|needs?)\s+(?:an?\s+)?(?:api\s+)?(?:key|credentials)\b/iu,
    /\blive model calls?\s+(?:always\s+)?(?:requires?|needs?)\s+(?:an?\s+)?(?:api\s+)?(?:key|credentials)\b/iu,
    /\blive provider runs?\s+always\s+(?:requires?|needs?)\s+(?:an?\s+)?(?:api\s+)?(?:key|credentials)\b/iu,
  ].some((pattern) => pattern.test(withoutNegatedClaims))
}

function validateCanonicalRootReadme(readme, withoutComments, visibleRendered) {
  const failures = []

  if (!readme.startsWith(CANONICAL_ROOT_HERO)) {
    failures.push("README is missing the exact canonical hero")
  }
  if (!readme.includes(CANONICAL_ROOT_BADGES)) {
    failures.push("README must contain exactly five approved badges")
  }
  if (!readme.includes(CANONICAL_ROOT_NAVIGATION)) {
    failures.push("README must contain exactly four canonical hero navigation links")
  }

  const quickstartHeading = /^## Quickstart[ \t]*$/mu.exec(visibleRendered)
  const firstScroll = visibleRendered.slice(0, quickstartHeading?.index ?? visibleRendered.length)
  const firstScrollImages = [
    ...firstScroll.matchAll(/<img\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)')[^>]*>/giu),
  ]
    .map((match) => match[1] ?? match[2])
    .filter(
      (source) =>
        source !== "docs/brand/dawn-logo-horizontal-black-on-white.png" &&
        source !== "docs/brand/product-loop.gif",
    )
  if (firstScrollImages.length !== 5) {
    failures.push("README must contain exactly five approved badges")
  }
  const firstScrollTextLinks = [...firstScroll.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/giu)].filter(
    (match) => !/<img\b/iu.test(match[1]),
  )
  if (firstScrollTextLinks.length !== 4) {
    failures.push("README must contain exactly four canonical hero navigation links")
  }

  const firstCommand = withoutComments.indexOf("npm create dawn-ai-app@latest my-agent")
  const productLoopGif = withoutComments.indexOf("docs/brand/product-loop.gif")
  if (firstCommand === -1 || productLoopGif === -1 || firstCommand >= productLoopGif) {
    failures.push("README must put the first scaffold command before the product-loop GIF")
  }

  if (!readme.includes(CANONICAL_PRODUCT_LOOP_BLOCK)) {
    failures.push(
      "README is missing the linked product-loop GIF with canonical anchor and alt text",
    )
  }
  if (!readme.includes(CANONICAL_QUICKSTART_BLOCK)) {
    failures.push("README is missing the complete no-key Quickstart sequence")
  }
  if (!readme.includes(CANONICAL_TRANSCRIPT_LINK)) {
    failures.push("README is missing the canonical product-loop transcript link")
  }
  if (!readme.includes(CANONICAL_FINAL_CTA)) {
    failures.push("README is missing the final scaffold CTA")
  }
  if (!readme.trimEnd().endsWith(CANONICAL_LICENSE_SECTION)) {
    failures.push("README is missing the canonical License section")
  }
  if (!readme.includes(CANONICAL_PROVIDER_CREDENTIAL_GUIDANCE)) {
    failures.push("README is missing canonical provider-specific credential guidance")
  }

  return failures
}

export function validatePackageDiscoveryMetadata(manifest) {
  const failures = []
  const packageName = typeof manifest?.name === "string" ? manifest.name : "package"
  const description = manifest?.description

  if (
    typeof description !== "string" ||
    description.length < DESCRIPTION_MINIMUM_LENGTH ||
    description.length > DESCRIPTION_MAXIMUM_LENGTH
  ) {
    failures.push(
      `${packageName}: package.json description must be a string of ${DESCRIPTION_MINIMUM_LENGTH}-${DESCRIPTION_MAXIMUM_LENGTH} characters`,
    )
  } else if (description !== description.trim()) {
    failures.push(`${packageName}: package.json description must be trimmed`)
  }

  const keywords = manifest?.keywords
  if (
    !Array.isArray(keywords) ||
    keywords.length < KEYWORD_MINIMUM_COUNT ||
    keywords.length > KEYWORD_MAXIMUM_COUNT
  ) {
    failures.push(
      `${packageName}: package.json keywords must contain ${KEYWORD_MINIMUM_COUNT}-${KEYWORD_MAXIMUM_COUNT} values`,
    )
  }

  if (Array.isArray(keywords)) {
    if (new Set(keywords).size !== keywords.length) {
      failures.push(`${packageName}: package.json keywords must be unique`)
    }
    if (keywords.some((keyword) => typeof keyword !== "string" || !KEYWORD_PATTERN.test(keyword))) {
      failures.push(`${packageName}: package.json keywords must be lowercase kebab-case strings`)
    }
  }

  return failures
}

export function validatePackageReadme({ tier, manifest, readme }) {
  if (!Object.hasOwn(DEFAULT_PUBLIC_PACKAGE_TIERS, tier)) {
    throw new Error(`Unknown README tier "${tier}"`)
  }

  const failures = validatePackageDiscoveryMetadata(manifest)
  const packageName = manifest?.name
  const source = typeof readme === "string" ? readme : ""
  const headings = markdownHeadings(source)
  const firstH1 = headings.find((heading) => heading.level === 1)

  if (typeof packageName !== "string" || firstH1?.text !== packageName) {
    failures.push(
      `${packageName ?? "package"}: README H1 must be the package name ${packageName ?? ""}`.trim(),
    )
  }
  if (!hasPurposeStatement(source, firstH1, headings)) {
    failures.push(`${packageName ?? "package"}: README must begin with a purpose statement`)
  }

  const visible = visibleBlockProjections(source)
  if (!/^\*\*Use this when:\*\*[ \t]+\S/mu.test(visible.markdown)) {
    failures.push(`${packageName ?? "package"}: README is missing **Use this when:** guidance`)
  }
  if (!hasHeading(headings, ["Install", "Installation", "Invocation"])) {
    failures.push(`${packageName ?? "package"}: README needs an Install or Invocation heading`)
  }

  if (tier === "entry" || tier === "capability") {
    if (!hasHeading(headings, ["Example"])) {
      failures.push(`${packageName ?? "package"}: ${tier} README needs an Example heading`)
    }
  } else if (!hasHeading(headings, ["Example", "Configuration"])) {
    failures.push(
      `${packageName ?? "package"}: tooling README needs an Example or Configuration heading`,
    )
  }

  for (const heading of ["Runtime and stability", "Related", "Maturity and support", "License"]) {
    if (!hasHeading(headings, [heading])) {
      failures.push(`${packageName ?? "package"}: README is missing the ${heading} heading`)
    }
  }

  if (tier === "entry" && !productLoopImagePresent(visible.markdown, visible.rendered)) {
    failures.push(
      `${packageName ?? "package"}: entry README is missing the docs/brand/product-loop.gif image`,
    )
  }

  return failures
}

export function validateRootReadme(source, options = {}) {
  const failures = []
  const readme = typeof source === "string" ? source : ""
  const headings = markdownHeadings(readme)
  const rootHeadings = headings.filter((heading) => heading.level === 2)
  const requiredIndexes = []

  for (const required of ROOT_HEADINGS) {
    const matches = rootHeadings
      .map((heading, index) => ({ heading, index }))
      .filter(({ heading }) => heading.text === required)
    if (matches.length === 0) {
      failures.push(`README is missing the ${required} H2 heading`)
      requiredIndexes.push(null)
      continue
    }
    if (matches.length > 1) {
      failures.push(`README must contain exactly one ${required} H2 heading`)
    }
    requiredIndexes.push(matches[0].index)
  }

  const presentRequiredIndexes = requiredIndexes.filter((index) => index !== null)
  if (
    presentRequiredIndexes.some(
      (index, position) => position > 0 && index <= presentRequiredIndexes[position - 1],
    )
  ) {
    failures.push("README required headings are out of order")
  }

  const withoutComments = maskHtmlComments(readme)
  const visible = visibleBlockProjections(readme)
  if (!canonicalScaffoldCommandPresent(withoutComments)) {
    failures.push(
      "README is missing the canonical scaffold command: npm create dawn-ai-app@latest my-agent",
    )
  }
  if (!productLoopImagePresent(visible.markdown, visible.rendered)) {
    failures.push("README is missing the docs/brand/product-loop.gif image")
  }
  if (!markdownLinkPresent(visible.markdown, ROOT_LINK_CONTRACTS.migration)) {
    failures.push("README is missing the /docs/migrating-from-langgraph migration link")
  }
  if (!markdownLinkPresent(visible.markdown, ROOT_LINK_CONTRACTS.transcript)) {
    failures.push("README is missing the docs/brand/demo/transcript.md link")
  }
  if (readme.includes(OLD_GIF_CAPTION)) {
    failures.push("README still contains the old GIF caption")
  }
  if (universalCredentialClaimPresent(visible.rendered)) {
    failures.push("README: not every live model call requires credentials")
  }
  if (options?.canonical === true) {
    failures.push(...validateCanonicalRootReadme(readme, withoutComments, visible.rendered))
  }

  return failures
}

export function assertDisjointPackageTiers(definitions) {
  const classifications = new Map()
  for (const tier of ["entry", "capability", "tooling"]) {
    const packages = definitions?.[tier]
    if (!Array.isArray(packages)) {
      throw new TypeError(`Public package tier ${tier} must be an array`)
    }
    for (const packageName of packages) {
      if (classifications.has(packageName)) {
        throw new Error(`Multiple classifications for public package: ${packageName}`)
      }
      classifications.set(packageName, tier)
    }
  }
}

export function resolvePublicPackageTiers(publicPackageNames) {
  if (!Array.isArray(publicPackageNames)) {
    throw new TypeError("Public package names must be an array")
  }

  const inventorySeen = new Set()
  for (const packageName of publicPackageNames) {
    if (inventorySeen.has(packageName)) {
      throw new Error(`Duplicate public package: ${packageName}`)
    }
    inventorySeen.add(packageName)
  }

  assertDisjointPackageTiers(DEFAULT_PUBLIC_PACKAGE_TIERS)

  const classifications = new Map()
  for (const tier of ["entry", "capability", "tooling"]) {
    const packages = DEFAULT_PUBLIC_PACKAGE_TIERS[tier]
    for (const packageName of packages) {
      classifications.set(packageName, tier)
    }
  }

  for (const packageName of publicPackageNames) {
    if (!classifications.has(packageName)) {
      throw new Error(`Unknown public package: ${packageName}`)
    }
  }
  for (const packageName of classifications.keys()) {
    if (!inventorySeen.has(packageName)) {
      throw new Error(`Missing known public package: ${packageName}`)
    }
  }

  return Object.fromEntries(
    publicPackageNames.map((packageName) => [packageName, classifications.get(packageName)]),
  )
}
