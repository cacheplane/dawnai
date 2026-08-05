import { basename, extname } from "node:path"

// TypeScript 6 bridge: revisit this compiler boundary for TS 7.1 once the native API lands.
// Tracking issue: https://github.com/microsoft/typescript-go/issues/4830
import ts from "typescript"

import type { JsonSchemaProperty } from "../types.js"
import type { AnalyzedTool, PropertyInfo, TypeInfo } from "./model.js"

const MAX_TYPE_DEPTH = 32
const MAX_SCHEMA_DEPTH = 8

interface JsDocInfo {
  readonly description: string
  readonly params: ReadonlyMap<string, string>
}

interface ResolutionState {
  readonly activeTypes: Set<ts.Type>
  readonly depth: number
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
    parameter: parameterType ? resolveParameterType(parameterType, checker, sourceFile) : null,
    parameterDescriptions: jsDoc.params,
  }
}

function resolveParameterType(
  type: ts.Type,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): TypeInfo {
  const resolved = resolveType(type, checker, { activeTypes: new Set(), depth: 0 })
  if (!type.isIntersection() || resolved.kind !== "intersection") return resolved

  const effectiveProperties = type.types.every(
    (member) => (member.flags & ts.TypeFlags.Object) !== 0,
  )
    ? type.getProperties().map((property) =>
        resolveRootParameterProperty(property, checker, sourceFile, {
          activeTypes: new Set([type]),
          depth: 1,
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
  const schemaProjection = resolveSchemaProjection(property, propertyType, checker)
  const description = ts.displayPartsToString(property.getDocumentationComment(checker)).trim()

  return {
    name: property.getName(),
    type: resolvePropertyType(propertyType, optional, checker, state),
    optional,
    ...(description ? { description } : {}),
    ...(schemaProjection !== undefined ? { schemaProjection } : {}),
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
    schemaProjection: {
      schema: compilerTypeToJsonSchema(propertyType, checker),
      optional: isLegacyOptionalProperty(property),
    },
  }
}

function resolveSchemaProjection(
  property: ts.Symbol,
  propertyType: ts.Type,
  checker: ts.TypeChecker,
): PropertyInfo["schemaProjection"] {
  return {
    schema: compilerTypeToJsonSchema(propertyType, checker),
    optional: isLegacyOptionalProperty(property),
  }
}

function isLegacyOptionalProperty(property: ts.Symbol): boolean {
  return (
    property
      .getDeclarations()
      ?.some(
        (declaration) =>
          ts.isPropertySignature(declaration) && declaration.questionToken !== undefined,
      ) ?? false
  )
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

function compilerTypeToJsonSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth = 0,
): JsonSchemaProperty {
  if (depth > MAX_SCHEMA_DEPTH) return { type: "string" }

  if (type.isUnion()) {
    const definedMembers = type.types.filter((member) => !(member.flags & ts.TypeFlags.Undefined))
    if (definedMembers.length === 1 && definedMembers[0]) {
      return compilerTypeToJsonSchema(definedMembers[0], checker, depth)
    }

    if (definedMembers.length > 0 && definedMembers.every((member) => member.isStringLiteral())) {
      return {
        type: "string",
        enum: definedMembers.map((member) => (member as ts.StringLiteralType).value),
      }
    }

    if (
      definedMembers.length > 1 &&
      definedMembers.every(
        (member) =>
          (member.flags & ts.TypeFlags.Object) !== 0 &&
          (member.getProperties().length > 0 ||
            checker.getIndexTypeOfType(member, ts.IndexKind.String)),
      )
    ) {
      return {
        anyOf: definedMembers.map((member) => compilerTypeToJsonSchema(member, checker, depth + 1)),
      }
    }
  }

  if (checker.isArrayType(type)) {
    const element = checker.getTypeArguments(type as ts.TypeReference)[0]
    return {
      type: "array",
      items: element ? compilerTypeToJsonSchema(element, checker, depth + 1) : { type: "string" },
    }
  }

  const typeString = checker.typeToString(type)
  if (typeString === "string") return { type: "string" }
  if (typeString === "number") return { type: "number" }
  if (typeString === "boolean") return { type: "boolean" }

  if (type.isStringLiteral()) return { type: "string", enum: [type.value] }
  if (type.isNumberLiteral()) return { type: "number" }
  if (type.flags & ts.TypeFlags.BooleanLiteral) return { type: "boolean" }

  return tryCompilerObjectSchema(type, checker, depth) ?? { type: "string" }
}

function tryCompilerObjectSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
): JsonSchemaProperty | undefined {
  if ((type.flags & ts.TypeFlags.Object) === 0) return undefined

  const properties = type.getProperties()
  const indexType = checker.getIndexTypeOfType(type, ts.IndexKind.String)
  if (properties.length === 0 && indexType) {
    return {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: compilerTypeToJsonSchema(indexType, checker, depth + 1),
    }
  }
  if (properties.length === 0) return undefined

  const schemas: Record<string, JsonSchemaProperty> = {}
  const required: string[] = []
  for (const property of properties) {
    const propertyType = checker.getTypeOfSymbolAtLocation(
      property,
      property.valueDeclaration ?? property.declarations?.[0] ?? ({} as ts.Node),
    )
    const schema = compilerTypeToJsonSchema(propertyType, checker, depth + 1)
    const description = ts.displayPartsToString(property.getDocumentationComment(checker))
    schemas[property.getName()] = description ? { ...schema, description } : schema
    if (!isLegacyOptionalProperty(property)) required.push(property.getName())
  }

  return {
    type: "object",
    properties: schemas,
    required,
    additionalProperties: false,
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
