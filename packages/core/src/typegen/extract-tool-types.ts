import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

import type { ExtractedToolType } from "../types.js"

export interface ExtractToolTypesOptions {
  readonly routeDir: string
  readonly sharedToolsDir: string | undefined
}

export async function extractToolTypesForRoute(
  options: ExtractToolTypesOptions,
): Promise<readonly ExtractedToolType[]> {
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

  const results: ExtractedToolType[] = []

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
    const params = signature.getParameters()

    let inputType: string
    if (params.length === 0) {
      inputType = "void"
    } else {
      const firstParam = params[0]
      if (!firstParam) continue
      const paramType = checker.getTypeOfSymbolAtLocation(firstParam, sourceFile)
      inputType = checker.typeToString(paramType)
    }

    const returnType = checker.getReturnTypeOfSignature(signature)
    const outputType = unwrapPromise(returnType)

    results.push({
      name,
      inputType,
      outputType: checker.typeToString(outputType),
    })
  }

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

function unwrapPromise(type: ts.Type): ts.Type {
  const symbol = type.getSymbol()
  if (symbol && symbol.getName() === "Promise") {
    const typeArgs = (type as ts.TypeReference).typeArguments
    if (typeArgs && typeArgs.length > 0 && typeArgs[0]) {
      return typeArgs[0]
    }
  }
  return type
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
