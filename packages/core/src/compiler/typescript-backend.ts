import { basename, extname } from "node:path"

// TypeScript 6 bridge: revisit this compiler boundary for TS 7.1 once the native API lands.
// Tracking issue: https://github.com/microsoft/typescript-go/issues/4830
import ts from "typescript"

import type { AnalyzedTool, PropertyInfo, TypeInfo } from "./model.js"

const MAX_TYPE_DEPTH = 32

interface JsDocInfo {
  readonly description: string
  readonly params: ReadonlyMap<string, string>
}

interface ResolutionState {
  readonly activeTypes: Set<ts.Type>
  readonly depth: number
}

export function analyzeToolSource(source: string, fileName: string): AnalyzedTool | null {
  const options = compilerOptions()

  const filesystemHost = ts.createCompilerHost(options)
  const host: ts.CompilerHost = {
    ...filesystemHost,
    fileExists(path) {
      if (path === fileName) return true
      return filesystemHost.fileExists(path)
    },
    getSourceFile(path, languageVersion) {
      if (path === fileName) {
        return ts.createSourceFile(path, source, languageVersion, true)
      }
      return filesystemHost.getSourceFile(path, languageVersion)
    },
    readFile(path) {
      if (path === fileName) return source
      return filesystemHost.readFile(path)
    },
  }

  const program = ts.createProgram([fileName], options, host)
  return analyzeProgramSource(program, fileName, basename(fileName, extname(fileName)))
}

export function analyzeToolFiles(toolFiles: ReadonlyMap<string, string>): readonly AnalyzedTool[] {
  if (toolFiles.size === 0) return []

  const program = ts.createProgram([...toolFiles.values()], compilerOptions())
  const results: AnalyzedTool[] = []

  for (const [name, fileName] of toolFiles) {
    const analyzed = analyzeProgramSource(program, fileName, name)
    if (analyzed) results.push(analyzed)
  }

  return results
}

function analyzeProgramSource(
  program: ts.Program,
  fileName: string,
  name: string,
): AnalyzedTool | null {
  const checker = program.getTypeChecker()
  const sourceFile = program.getSourceFile(fileName)
  if (!sourceFile) return null

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  if (!moduleSymbol) return null

  const defaultExport = checker
    .getExportsOfModule(moduleSymbol)
    .find((candidate) => candidate.escapedName === "default")
  if (!defaultExport) return null

  const exportType = checker.getTypeOfSymbolAtLocation(defaultExport, sourceFile)
  const signature = checker.getSignaturesOfType(exportType, ts.SignatureKind.Call)[0]
  if (!signature) return null

  const firstParameter = signature.getParameters()[0]
  const parameterType = firstParameter
    ? checker.getTypeOfSymbolAtLocation(
        firstParameter,
        firstParameter.valueDeclaration ?? firstParameter.declarations?.[0] ?? sourceFile,
      )
    : null
  const returnType = unwrapPromise(checker.getReturnTypeOfSignature(signature), checker)
  const jsDoc = extractJsDoc(sourceFile)

  return {
    name,
    description: jsDoc.description,
    inputType: parameterType
      ? checker.typeToString(parameterType, undefined, ts.TypeFormatFlags.NoTruncation)
      : "void",
    outputType: checker.typeToString(returnType, undefined, ts.TypeFormatFlags.NoTruncation),
    parameter: parameterType
      ? resolveType(parameterType, checker, { activeTypes: new Set(), depth: 0 })
      : null,
    parameterDescriptions: jsDoc.params,
  }
}

function compilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    lib: ["lib.es2022.d.ts"],
  }
}

function resolveType(type: ts.Type, checker: ts.TypeChecker, state: ResolutionState): TypeInfo {
  if (state.depth >= MAX_TYPE_DEPTH || state.activeTypes.has(type)) {
    return { kind: "unknown" }
  }

  state.activeTypes.add(type)
  try {
    return resolveTypeInner(type, checker, {
      activeTypes: state.activeTypes,
      depth: state.depth + 1,
    })
  } finally {
    state.activeTypes.delete(type)
  }
}

function resolveTypeInner(
  type: ts.Type,
  checker: ts.TypeChecker,
  state: ResolutionState,
): TypeInfo {
  if (type.isStringLiteral()) return { kind: "literal", value: type.value }
  if (type.isNumberLiteral()) return { kind: "literal", value: type.value }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    const intrinsicName = (type as unknown as { intrinsicName: string }).intrinsicName
    return { kind: "literal", value: intrinsicName === "true" }
  }

  if (type.flags & ts.TypeFlags.String) return { kind: "string" }
  if (type.flags & ts.TypeFlags.Number) return { kind: "number" }
  if (type.flags & ts.TypeFlags.Boolean) return { kind: "boolean" }
  if (type.flags & ts.TypeFlags.Null) return { kind: "null" }

  if (type.isUnion()) {
    const members = type.types
    const definedMembers = members.filter((member) => !(member.flags & ts.TypeFlags.Undefined))
    const resolved = resolveUnionMembers(definedMembers, checker, state)
    return definedMembers.length === members.length
      ? resolved
      : { kind: "optional", inner: resolved }
  }

  if (type.isIntersection()) {
    return {
      kind: "intersection",
      members: type.types.map((member) => resolveType(member, checker, state)),
    }
  }

  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType

    if (checker.isTupleType(type)) {
      return {
        kind: "tuple",
        elements: checker
          .getTypeArguments(objectType as ts.TypeReference)
          .map((element) => resolveType(element, checker, state)),
      }
    }

    const typeArguments = checker.getTypeArguments(objectType as ts.TypeReference)

    if (checker.isArrayType(type) || isStandardLibraryType(type, ["ReadonlyArray"])) {
      return {
        kind: "array",
        element: typeArguments[0]
          ? resolveType(typeArguments[0], checker, state)
          : { kind: "unknown" },
      }
    }

    if (isStandardLibraryType(type, ["Map", "ReadonlyMap"])) {
      return {
        kind: "map",
        key: typeArguments[0] ? resolveType(typeArguments[0], checker, state) : { kind: "unknown" },
        value: typeArguments[1]
          ? resolveType(typeArguments[1], checker, state)
          : { kind: "unknown" },
      }
    }

    if (isStandardLibraryType(type, ["Set", "ReadonlySet"])) {
      return {
        kind: "set",
        element: typeArguments[0]
          ? resolveType(typeArguments[0], checker, state)
          : { kind: "unknown" },
      }
    }

    const properties = type.getProperties()
    const stringIndexType = checker.getIndexTypeOfType(type, ts.IndexKind.String)
    if (stringIndexType && properties.length === 0) {
      return {
        kind: "record",
        key: { kind: "string" },
        value: resolveType(stringIndexType, checker, state),
      }
    }

    if (properties.length > 0) {
      return {
        kind: "object",
        properties: properties.map((property) => resolveProperty(property, checker, state)),
      }
    }
  }

  return { kind: "unknown" }
}

function resolveProperty(
  property: ts.Symbol,
  checker: ts.TypeChecker,
  state: ResolutionState,
): PropertyInfo {
  const declaration = property.valueDeclaration ?? property.declarations?.[0]
  const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration ?? ({} as ts.Node))
  const optional = !!(property.flags & ts.SymbolFlags.Optional)
  const description = ts.displayPartsToString(property.getDocumentationComment(checker)).trim()

  let resolvedType: TypeInfo
  if (optional && propertyType.isUnion()) {
    const definedMembers = propertyType.types.filter(
      (member) => !(member.flags & ts.TypeFlags.Undefined),
    )
    if (definedMembers.length === 1 && definedMembers[0]) {
      resolvedType = resolveType(definedMembers[0], checker, state)
    } else {
      resolvedType = resolveUnionMembers(definedMembers, checker, state)
    }
  } else {
    resolvedType = resolveType(propertyType, checker, state)
  }

  return {
    name: property.getName(),
    type: resolvedType,
    optional,
    ...(description ? { description } : {}),
  }
}

function resolveUnionMembers(
  members: readonly ts.Type[],
  checker: ts.TypeChecker,
  state: ResolutionState,
): TypeInfo {
  if (members.length === 1 && members[0]) return resolveType(members[0], checker, state)
  if (
    members.length === 2 &&
    members.every((member) => member.flags & ts.TypeFlags.BooleanLiteral)
  ) {
    return { kind: "boolean" }
  }
  if (members.length > 0 && members.every((member) => member.isStringLiteral())) {
    return {
      kind: "enum",
      values: members.map((member) => (member as ts.StringLiteralType).value),
    }
  }
  return {
    kind: "union",
    members: members.map((member) => resolveType(member, checker, state)),
  }
}

function isStandardLibraryType(type: ts.Type, names: readonly string[]): boolean {
  const symbol = type.getSymbol()
  return (
    !!symbol &&
    names.includes(symbol.getName()) &&
    !!symbol.declarations?.some((declaration) => declaration.getSourceFile().hasNoDefaultLib)
  )
}

function unwrapPromise(type: ts.Type, checker: ts.TypeChecker): ts.Type {
  if (!isStandardLibraryType(type, ["Promise"])) return type
  return checker.getTypeArguments(type as ts.TypeReference)[0] ?? type
}

function extractJsDoc(sourceFile: ts.SourceFile): JsDocInfo {
  const defaultExportNode = sourceFile.statements.find(isDefaultExport)
  if (!defaultExportNode) return { description: "", params: new Map() }

  const source = sourceFile.getFullText()
  const commentRanges = ts.getLeadingCommentRanges(source, defaultExportNode.getFullStart()) ?? []
  const jsDocRange = commentRanges
    .filter((range) => source.slice(range.pos, range.end).startsWith("/**"))
    .at(-1)
  if (!jsDocRange) return { description: "", params: new Map() }

  const comment = source.slice(jsDocRange.pos, jsDocRange.end)
  const lines = comment
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
  const descriptionLines: string[] = []
  const params = new Map<string, string>()

  for (const line of lines) {
    if (line.startsWith("@param")) {
      const match = line.match(/^@param\s+(\S+)\s*(?:-\s*)?(.*)$/)
      if (match?.[1]) params.set(match[1], (match[2] ?? "").trim())
    } else if (!line.startsWith("@")) {
      descriptionLines.push(line)
    }
  }

  return {
    description: descriptionLines
      .filter((line) => line.length > 0)
      .join(" ")
      .trim(),
    params,
  }
}

function isDefaultExport(statement: ts.Statement): boolean {
  if (ts.isExportAssignment(statement)) return !statement.isExportEquals
  return (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    !!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    !!statement.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  )
}
