import ts from "typescript"

import type { PropertyInfo, TypeInfo } from "./type-info.js"

/**
 * Extracts the TypeInfo for the first parameter of the default-exported function.
 * Returns null if no default export is found.
 */
export function extractParameterType(
  source: string,
  fileName: string,
): TypeInfo | null {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    lib: ["lib.es2022.d.ts"],
  }

  const defaultHost = ts.createCompilerHost(options)

  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile(name, languageVersion) {
      if (name === fileName) {
        return ts.createSourceFile(name, source, languageVersion, true)
      }
      return defaultHost.getSourceFile(name, languageVersion)
    },
    fileExists(name) {
      if (name === fileName) return true
      return defaultHost.fileExists(name)
    },
    readFile(name) {
      if (name === fileName) return source
      return defaultHost.readFile(name)
    },
  }

  const program = ts.createProgram([fileName], options, host)
  const checker = program.getTypeChecker()
  const sourceFile = program.getSourceFile(fileName)

  if (!sourceFile) return null

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  if (!moduleSymbol) return null

  const exports = checker.getExportsOfModule(moduleSymbol)
  const defaultExport = exports.find(
    (e) => e.escapedName === "default",
  )

  if (!defaultExport) return null

  const exportType = checker.getTypeOfSymbolAtLocation(
    defaultExport,
    sourceFile,
  )
  const signatures = checker.getSignaturesOfType(
    exportType,
    ts.SignatureKind.Call,
  )

  if (signatures.length === 0) return null

  const firstSignature = signatures[0]!
  const params = firstSignature.getParameters()

  if (params.length === 0) return null

  const firstParam = params[0]!
  const paramType = checker.getTypeOfSymbolAtLocation(firstParam, sourceFile)

  return resolveType(paramType, checker)
}

function resolveType(type: ts.Type, checker: ts.TypeChecker): TypeInfo {
  // Handle literal types first
  if (type.isStringLiteral()) {
    return { kind: "literal", value: type.value }
  }
  if (type.isNumberLiteral()) {
    return { kind: "literal", value: type.value }
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    const intrinsicName = (type as unknown as { intrinsicName: string })
      .intrinsicName
    return { kind: "literal", value: intrinsicName === "true" }
  }

  // Handle primitive types
  if (type.flags & ts.TypeFlags.String) {
    return { kind: "string" }
  }
  if (type.flags & ts.TypeFlags.Number) {
    return { kind: "number" }
  }
  if (type.flags & ts.TypeFlags.Boolean) {
    return { kind: "boolean" }
  }
  if (type.flags & ts.TypeFlags.Null) {
    return { kind: "null" }
  }

  // Handle unions
  if (type.isUnion()) {
    const members = type.types

    // Filter out "true" and "false" boolean literal types that form a boolean
    const isBooleanUnion =
      members.length === 2 &&
      members.every((m) => m.flags & ts.TypeFlags.BooleanLiteral)
    if (isBooleanUnion) {
      return { kind: "boolean" }
    }

    // Check if all non-undefined members are string literals → enum
    const nonUndefinedMembers = members.filter(
      (m) => !(m.flags & ts.TypeFlags.Undefined),
    )
    const allStringLiterals = nonUndefinedMembers.every((m) =>
      m.isStringLiteral(),
    )

    if (allStringLiterals && nonUndefinedMembers.length > 0) {
      const values = nonUndefinedMembers.map(
        (m) => (m as ts.StringLiteralType).value,
      )
      const enumType: TypeInfo = { kind: "enum", values }
      // If there were undefined members, wrap in optional
      if (nonUndefinedMembers.length < members.length) {
        return { kind: "optional", inner: enumType }
      }
      return enumType
    }

    // General union
    const resolvedMembers = members.map((m) => resolveType(m, checker))
    return { kind: "union", members: resolvedMembers }
  }

  // Handle intersections
  if (type.isIntersection()) {
    const members = type.types
    const resolvedMembers = members.map((m) => resolveType(m, checker))

    // If all members resolve to objects, merge their properties
    if (resolvedMembers.every((m) => m.kind === "object")) {
      const allProperties = resolvedMembers.flatMap(
        (m) => (m as Extract<TypeInfo, { kind: "object" }>).properties,
      )
      return { kind: "object", properties: allProperties }
    }

    return { kind: "intersection", members: resolvedMembers }
  }

  // Handle object types (including arrays, maps, sets, tuples)
  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType

    // Check for tuple
    if (checker.isTupleType(type)) {
      const typeArgs = checker.getTypeArguments(
        objectType as ts.TypeReference,
      )
      const elements = typeArgs.map((t) => resolveType(t, checker))
      return { kind: "tuple", elements }
    }

    // Check symbol name for built-in generic types
    const symbol = type.getSymbol()
    const symbolName = symbol?.getName()

    if (symbolName === "Array" || symbolName === "ReadonlyArray") {
      const typeArgs = checker.getTypeArguments(
        objectType as ts.TypeReference,
      )
      const element = typeArgs[0]
        ? resolveType(typeArgs[0], checker)
        : { kind: "unknown" as const }
      return { kind: "array", element }
    }

    if (symbolName === "Map" || symbolName === "ReadonlyMap") {
      const typeArgs = checker.getTypeArguments(
        objectType as ts.TypeReference,
      )
      const key = typeArgs[0]
        ? resolveType(typeArgs[0], checker)
        : { kind: "unknown" as const }
      const value = typeArgs[1]
        ? resolveType(typeArgs[1], checker)
        : { kind: "unknown" as const }
      return { kind: "map", key, value }
    }

    if (symbolName === "Set" || symbolName === "ReadonlySet") {
      const typeArgs = checker.getTypeArguments(
        objectType as ts.TypeReference,
      )
      const element = typeArgs[0]
        ? resolveType(typeArgs[0], checker)
        : { kind: "unknown" as const }
      return { kind: "set", element }
    }

    // Check for Record type (string index signature with no declared properties)
    const properties = type.getProperties()
    const stringIndexType = checker.getIndexTypeOfType(
      type,
      ts.IndexKind.String,
    )

    if (stringIndexType && properties.length === 0) {
      const valueType = resolveType(stringIndexType, checker)
      return { kind: "record", key: { kind: "string" }, value: valueType }
    }

    // Regular object type
    if (properties.length > 0) {
      const propertyInfos: PropertyInfo[] = properties.map((prop) => {
        const propType = checker.getTypeOfSymbolAtLocation(
          prop,
          prop.valueDeclaration ?? prop.declarations?.[0] ?? ({} as ts.Node),
        )
        const optional = !!(prop.flags & ts.SymbolFlags.Optional)

        // For optional properties, the type checker may include undefined in the union.
        // Strip it out since we already track optionality separately.
        let effectiveType = propType
        if (optional && propType.isUnion()) {
          const nonUndefined = propType.types.filter(
            (t) => !(t.flags & ts.TypeFlags.Undefined),
          )
          if (nonUndefined.length === 1) {
            effectiveType = nonUndefined[0]!
          } else if (nonUndefined.length > 1) {
            // Reconstruct union without undefined - resolve each member
            const members = nonUndefined.map((t) => resolveType(t, checker))
            return {
              name: prop.getName(),
              type:
                members.every((m) => m.kind === "object")
                  ? { kind: "object" as const, properties: members.flatMap((m) => (m as Extract<TypeInfo, { kind: "object" }>).properties) }
                  : { kind: "union" as const, members },
              optional,
            }
          }
        }

        const resolvedPropType = resolveType(effectiveType, checker)

        return {
          name: prop.getName(),
          type: resolvedPropType,
          optional,
        }
      })
      return { kind: "object", properties: propertyInfos }
    }
  }

  return { kind: "unknown" }
}
