import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

import type { ExtractedToolSchema, JsonSchemaProperty } from "../types.js"

export interface ExtractToolSchemasOptions {
  readonly routeDir: string
  readonly sharedToolsDir: string | undefined
}

export async function extractToolSchemasForRoute(
  options: ExtractToolSchemasOptions,
): Promise<readonly ExtractedToolSchema[]> {
  const routeToolFiles = discoverToolFiles(join(options.routeDir, "tools"))
  const sharedToolFiles = options.sharedToolsDir
    ? discoverToolFiles(join(options.sharedToolsDir, "tools"))
    : new Map<string, string>()

  // Merge: route-local tools shadow shared tools
  const merged = new Map<string, string>(sharedToolFiles)
  for (const [name, filePath] of routeToolFiles) {
    merged.set(name, filePath)
  }

  if (merged.size === 0) return []

  const allFilePaths = [...merged.values()]
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    lib: ["lib.es2022.d.ts"],
  }

  const program = ts.createProgram(allFilePaths, compilerOptions)
  const checker = program.getTypeChecker()

  const results: ExtractedToolSchema[] = []

  for (const [name, filePath] of merged) {
    const sourceFile = program.getSourceFile(filePath)
    if (!sourceFile) continue

    const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
    if (!moduleSymbol) continue

    const exports = checker.getExportsOfModule(moduleSymbol)
    const defaultExport = exports.find((e) => e.escapedName === "default")
    if (!defaultExport) continue

    const exportType = checker.getTypeOfSymbolAtLocation(defaultExport, sourceFile)
    const signatures = checker.getSignaturesOfType(exportType, ts.SignatureKind.Call)
    if (signatures.length === 0) continue

    const signature = signatures[0]
    if (!signature) continue

    // Extract tool description from JSDoc
    const description = ts.displayPartsToString(defaultExport.getDocumentationComment(checker))

    const params = signature.getParameters()
    if (params.length === 0) {
      results.push({
        name,
        description,
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      })
      continue
    }

    const firstParam = params[0]
    if (!firstParam) continue
    const paramType = checker.getTypeOfSymbolAtLocation(firstParam, sourceFile)

    const properties: Record<string, JsonSchemaProperty> = {}
    const required: string[] = []

    for (const prop of paramType.getProperties()) {
      const propName = prop.getName()
      const propType = checker.getTypeOfSymbolAtLocation(prop, sourceFile)
      const schema = tsTypeToJsonSchema(propType, checker)

      // Extract property JSDoc description
      const propDoc = ts.displayPartsToString(prop.getDocumentationComment(checker))
      if (propDoc) {
        schema.description = propDoc
      }

      properties[propName] = schema

      // Check if property is optional
      const declarations = prop.getDeclarations()
      const isOptional =
        declarations !== undefined &&
        declarations.length > 0 &&
        declarations.some((d) => ts.isPropertySignature(d) && d.questionToken !== undefined)

      if (!isOptional) {
        required.push(propName)
      }
    }

    results.push({
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    })
  }

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

function tsTypeToJsonSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
): { type: string; description?: string; items?: JsonSchemaProperty; enum?: string[] } {
  // Strip undefined from unions (optional properties resolve as T | undefined)
  if (type.isUnion()) {
    const nonUndefined = type.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined))
    if (nonUndefined.length === 1 && nonUndefined[0]) {
      return tsTypeToJsonSchema(nonUndefined[0], checker)
    }

    // String literal union → enum
    const allStringLiterals = nonUndefined.every((t) => t.isStringLiteral())
    if (allStringLiterals && nonUndefined.length > 0) {
      const enumValues = nonUndefined.map((t) => (t as ts.StringLiteralType).value)
      return { type: "string", enum: enumValues }
    }
  }

  // Array type
  if (checker.isArrayType(type)) {
    const typeArgs = (type as ts.TypeReference).typeArguments
    const elementType = typeArgs && typeArgs.length > 0 && typeArgs[0]
    const items = elementType ? tsTypeToJsonSchema(elementType, checker) : { type: "string" }
    return { type: "array", items }
  }

  const typeString = checker.typeToString(type)

  if (typeString === "string") return { type: "string" }
  if (typeString === "number") return { type: "number" }
  if (typeString === "boolean") return { type: "boolean" }

  // Fallback to string for unknown types
  return { type: "string" }
}

function discoverToolFiles(toolsDir: string): Map<string, string> {
  const files = new Map<string, string>()
  if (!existsSync(toolsDir)) return files

  const entries = readdirSync(toolsDir)
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue
    if (entry.endsWith(".d.ts")) continue
    const name = entry.replace(/\.ts$/, "")
    files.set(name, join(toolsDir, entry))
  }

  return files
}
