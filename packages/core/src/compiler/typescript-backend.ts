import { basename, extname } from "node:path"

// TypeScript 7.0 has no stable compiler API, so Core pins the TypeScript 6 compatibility
// wrapper and implementation behind this boundary. Revisit a native port for TS 7.1.
// Tracking issue: https://github.com/microsoft/typescript-go/issues/4830
import ts from "typescript"

import type { AnalyzedTool, PropertyInfo, TypeInfo } from "./model.js"

const MAX_TYPE_DEPTH = 32

interface ResolutionState {
  readonly activeTypes: Set<ts.Type>
  readonly depth: number
  readonly isSourceFileDefaultLibrary: (sourceFile: ts.SourceFile) => boolean
}

type CreateProgram = (rootNames: readonly string[], options: ts.CompilerOptions) => ts.Program

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

export function createAnalyzeToolFiles(
  createProgram: CreateProgram = ts.createProgram,
): (toolFiles: ReadonlyMap<string, string>) => readonly AnalyzedTool[] {
  return (toolFiles) => {
    if (toolFiles.size === 0) return []

    const program = createProgram([...toolFiles.values()], compilerOptions())
    const results: AnalyzedTool[] = []

    for (const [name, fileName] of toolFiles) {
      const analyzed = analyzeProgramSource(program, fileName, name)
      if (analyzed) results.push(analyzed)
    }

    return results
  }
}

const analyzeToolFilesWithProgram = createAnalyzeToolFiles()

export function analyzeToolFiles(toolFiles: ReadonlyMap<string, string>): readonly AnalyzedTool[] {
  return analyzeToolFilesWithProgram(toolFiles)
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

  const moduleExports = checker.getExportsOfModule(moduleSymbol)
  const defaultExport = moduleExports.find((candidate) => candidate.escapedName === "default")
  if (!defaultExport) return null

  const callableTarget =
    defaultExport.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(defaultExport)
      : defaultExport
  const callableDeclaration =
    callableTarget.valueDeclaration ?? callableTarget.declarations?.[0] ?? sourceFile
  const exportType = checker.getTypeOfSymbolAtLocation(callableTarget, callableDeclaration)
  const signature = checker.getSignaturesOfType(exportType, ts.SignatureKind.Call)[0]
  if (!signature) return null

  const isSourceFileDefaultLibrary = (candidate: ts.SourceFile) =>
    program.isSourceFileDefaultLibrary(candidate)

  const firstParameter = signature.getParameters()[0]
  const parameterType = firstParameter
    ? checker.getTypeOfSymbolAtLocation(
        firstParameter,
        firstParameter.valueDeclaration ?? firstParameter.declarations?.[0] ?? sourceFile,
      )
    : null
  const returnType = unwrapPromise(
    checker.getReturnTypeOfSignature(signature),
    checker,
    isSourceFileDefaultLibrary,
  )
  const leadingJsDoc = extractLeadingDefaultExportJsDoc(sourceFile)
  const exportedDescription = ts.displayPartsToString(
    defaultExport.getDocumentationComment(checker),
  )
  const targetDescription = ts.displayPartsToString(callableTarget.getDocumentationComment(checker))
  const description = exportedDescription || targetDescription || leadingJsDoc.description

  return {
    name,
    description,
    exports: {
      description: hasRuntimeModuleExport(moduleExports, "description", checker, sourceFile),
      schema: hasRuntimeModuleExport(moduleExports, "schema", checker, sourceFile),
    },
    inputType: parameterType
      ? checker.typeToString(parameterType, undefined, ts.TypeFormatFlags.NoTruncation)
      : "void",
    outputType: checker.typeToString(returnType, undefined, ts.TypeFormatFlags.NoTruncation),
    parameter: parameterType
      ? resolveParameterType(parameterType, checker, sourceFile, isSourceFileDefaultLibrary)
      : null,
    parameterDescriptions: leadingJsDoc.parameterDescriptions,
  }
}

function hasRuntimeModuleExport(
  moduleExports: readonly ts.Symbol[],
  name: string,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): boolean {
  const exportedSymbol = moduleExports.find((candidate) => candidate.escapedName === name)
  if (!exportedSymbol) return false

  const visited = new Set<ts.Symbol>()
  let current = exportedSymbol
  while (!visited.has(current)) {
    visited.add(current)
    const declarations = current.declarations ?? []
    if (declarations.some(ts.isPartOfTypeOnlyImportOrExportDeclaration)) return false

    const localDeclarations = declarations.filter(
      (declaration) => declaration.getSourceFile() === sourceFile,
    )
    if (
      localDeclarations.length > 0 &&
      localDeclarations.every(
        (declaration) => !!(ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient),
      )
    ) {
      return false
    }

    if (!(current.flags & ts.SymbolFlags.Alias)) {
      return !!(current.flags & ts.SymbolFlags.Value)
    }

    const target = checker.getImmediateAliasedSymbol(current)
    if (!target) return false
    current = target
  }

  return false
}

function resolveParameterType(
  type: ts.Type,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  isSourceFileDefaultLibrary: (sourceFile: ts.SourceFile) => boolean,
): TypeInfo {
  const resolved = resolveType(type, checker, {
    activeTypes: new Set(),
    depth: 0,
    isSourceFileDefaultLibrary,
  })
  if (!type.isIntersection() || resolved.kind !== "intersection") return resolved

  const effectiveProperties = resolved.members.every(
    (member) => member.kind === "object" || member.kind === "record",
  )
    ? type.getProperties().map((property) =>
        resolveRootParameterProperty(property, checker, sourceFile, {
          activeTypes: new Set([type]),
          depth: 1,
          isSourceFileDefaultLibrary,
        }),
      )
    : undefined

  return {
    ...resolved,
    ...(effectiveProperties !== undefined ? { effectiveProperties } : {}),
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
      isSourceFileDefaultLibrary: state.isSourceFileDefaultLibrary,
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

    if (
      checker.isArrayType(type) ||
      isStandardLibraryType(type, ["ReadonlyArray"], state.isSourceFileDefaultLibrary)
    ) {
      return {
        kind: "array",
        element: typeArguments[0]
          ? resolveType(typeArguments[0], checker, state)
          : { kind: "unknown" },
      }
    }

    if (isStandardLibraryType(type, ["Map", "ReadonlyMap"], state.isSourceFileDefaultLibrary)) {
      return {
        kind: "map",
        key: typeArguments[0] ? resolveType(typeArguments[0], checker, state) : { kind: "unknown" },
        value: typeArguments[1]
          ? resolveType(typeArguments[1], checker, state)
          : { kind: "unknown" },
      }
    }

    if (isStandardLibraryType(type, ["Set", "ReadonlySet"], state.isSourceFileDefaultLibrary)) {
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

  return {
    name: property.getName(),
    type: resolvePropertyType(propertyType, optional, checker, state),
    optional,
    ...(description ? { description } : {}),
  }
}

function resolveRootParameterProperty(
  property: ts.Symbol,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  state: ResolutionState,
): PropertyInfo {
  const propertyType = checker.getTypeOfSymbolAtLocation(property, sourceFile)
  const optional = !!(property.flags & ts.SymbolFlags.Optional)
  const description = ts.displayPartsToString(property.getDocumentationComment(checker)).trim()

  return {
    name: property.getName(),
    type: resolvePropertyType(propertyType, optional, checker, state),
    optional,
    ...(description ? { description } : {}),
  }
}

function resolvePropertyType(
  propertyType: ts.Type,
  optional: boolean,
  checker: ts.TypeChecker,
  state: ResolutionState,
): TypeInfo {
  if (!optional || !propertyType.isUnion()) {
    return resolveType(propertyType, checker, state)
  }

  const definedMembers = propertyType.types.filter(
    (member) => !(member.flags & ts.TypeFlags.Undefined),
  )
  if (definedMembers.length === 1 && definedMembers[0]) {
    return resolveType(definedMembers[0], checker, state)
  }
  return resolveUnionMembers(definedMembers, checker, state)
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

function isStandardLibraryType(
  type: ts.Type,
  names: readonly string[],
  isSourceFileDefaultLibrary: (sourceFile: ts.SourceFile) => boolean,
): boolean {
  const symbol = type.getSymbol()
  return (
    !!symbol &&
    names.includes(symbol.getName()) &&
    !!symbol.declarations?.some((declaration) =>
      isSourceFileDefaultLibrary(declaration.getSourceFile()),
    )
  )
}

function unwrapPromise(
  type: ts.Type,
  checker: ts.TypeChecker,
  isSourceFileDefaultLibrary: (sourceFile: ts.SourceFile) => boolean,
): ts.Type {
  if (!isStandardLibraryType(type, ["Promise"], isSourceFileDefaultLibrary)) return type
  return checker.getTypeArguments(type as ts.TypeReference)[0] ?? type
}

function extractLeadingDefaultExportJsDoc(sourceFile: ts.SourceFile): {
  readonly description: string
  readonly parameterDescriptions: ReadonlyMap<string, string>
} {
  const defaultExportNode = sourceFile.statements.find(isDefaultExport)
  if (!defaultExportNode) return { description: "", parameterDescriptions: new Map() }

  const source = sourceFile.getFullText()
  const commentRanges = ts.getLeadingCommentRanges(source, defaultExportNode.getFullStart()) ?? []
  const jsDocRange = commentRanges
    .filter((range) => source.slice(range.pos, range.end).startsWith("/**"))
    .at(-1)
  if (!jsDocRange) return { description: "", parameterDescriptions: new Map() }

  const comment = source.slice(jsDocRange.pos, jsDocRange.end)
  const lines = comment
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
  const params = new Map<string, string>()
  const descriptionLines: string[] = []
  let reachedTags = false

  for (const line of lines) {
    if (line.startsWith("@param")) {
      reachedTags = true
      const match = line.match(/^@param\s+(\S+)\s*(?:-\s*)?(.*)$/)
      if (match?.[1]) params.set(match[1], (match[2] ?? "").trim())
    } else if (line.startsWith("@")) {
      reachedTags = true
    } else if (!reachedTags && line.length > 0) {
      descriptionLines.push(line)
    }
  }

  return {
    description: descriptionLines.join("\n"),
    parameterDescriptions: params,
  }
}

function isDefaultExport(statement: ts.Statement): boolean {
  if (ts.isExportAssignment(statement)) return !statement.isExportEquals
  if (ts.isExportDeclaration(statement) && statement.exportClause) {
    return (
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some((element) => element.name.text === "default")
    )
  }
  return (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    !!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    !!statement.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  )
}
