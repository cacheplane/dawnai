import ts from "typescript"

export interface JsDocInfo {
  readonly description?: string
  readonly params: Record<string, string>
}

export function extractJsDoc(source: string, fileName: string): JsDocInfo {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
  )

  // Find the default export node
  let defaultExportNode: ts.Node | undefined

  for (const statement of sourceFile.statements) {
    // export default <expression>
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      defaultExportNode = statement
      break
    }

    // export default function / export default async function
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      defaultExportNode = statement
      break
    }

    // export default class
    if (
      ts.isClassDeclaration(statement) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      defaultExportNode = statement
      break
    }
  }

  if (!defaultExportNode) {
    return { params: {} }
  }

  // Get leading comment ranges on the default export node
  const fullText = sourceFile.getFullText()
  const nodeStart = defaultExportNode.getFullStart()
  const commentRanges = ts.getLeadingCommentRanges(fullText, nodeStart) ?? []

  // Filter for /** ... */ JSDoc-style comments
  const jsDocRanges = commentRanges.filter((range) => {
    if (range.kind !== ts.SyntaxKind.MultiLineCommentTrivia) return false
    const text = fullText.slice(range.pos, range.end)
    return text.startsWith("/**")
  })

  if (jsDocRanges.length === 0) {
    return { params: {} }
  }

  // Use the last JSDoc comment
  const lastRange = jsDocRanges[jsDocRanges.length - 1]
  if (!lastRange) {
    return { params: {} }
  }
  const commentText = fullText.slice(lastRange.pos, lastRange.end)

  return parseJsDocComment(commentText)
}

function parseJsDocComment(comment: string): JsDocInfo {
  // Strip /** and */
  const inner = comment.replace(/^\/\*\*/, "").replace(/\*\/$/, "")

  const lines = inner.split("\n").map((line) => {
    // Strip leading whitespace and optional leading *
    return line.replace(/^\s*\*\s?/, "").trimEnd()
  })

  const descriptionLines: string[] = []
  const params: Record<string, string> = {}

  for (const line of lines) {
    if (line.startsWith("@param")) {
      // @param name - description  OR  @param name description
      const match = line.match(/^@param\s+(\S+)\s*(?:-\s*)?(.*)$/)
      if (match?.[1] !== undefined) {
        const name = match[1]
        const desc = (match[2] ?? "").trim()
        params[name] = desc
      }
    } else if (line.startsWith("@")) {
      // Other tags — skip
    } else {
      descriptionLines.push(line)
    }
  }

  // Join non-empty description lines with spaces
  const descriptionText = descriptionLines
    .filter((l) => l.length > 0)
    .join(" ")
    .trim()

  if (descriptionText.length > 0) {
    return { description: descriptionText, params }
  }
  return { params }
}
