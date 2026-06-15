import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

export interface Diagnostic {
  readonly summary: string
  readonly hint: string
}

const EXPORT_RE = /does not provide an export named ['"](.+?)['"]/
const MODULE_RE = /requested module ['"](.+?)['"]/

interface ExportFailure {
  readonly specifier: string
  readonly missingExport: string
}

function findExportFailure(error: unknown): ExportFailure | null {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    const exportMatch = EXPORT_RE.exec(current.message)
    if (exportMatch) {
      const moduleMatch = MODULE_RE.exec(current.message)
      return { specifier: moduleMatch?.[1] ?? "", missingExport: exportMatch[1] ?? "" }
    }
    current = (current as { cause?: unknown }).cause
  }
  return null
}

function packageNameOf(specifier: string): string | null {
  if (!specifier) return null
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
    return null
  }
  const parts = specifier.split("/")
  if (specifier.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  }
  return parts[0] ?? null
}

interface PackageManifest {
  readonly version?: string
  readonly type?: string
}

function readManifest(appRoot: string, pkg: string): PackageManifest | null {
  try {
    const raw = readFileSync(
      join(appRoot, "node_modules", ...pkg.split("/"), "package.json"),
      "utf8",
    )
    return JSON.parse(raw) as PackageManifest
  } catch {
    return null
  }
}

function requiredCoreRange(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const manifestPath = require.resolve("@dawn-ai/langchain/package.json")
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      peerDependencies?: Record<string, string>
    }
    return pkg.peerDependencies?.["@langchain/core"] ?? null
  } catch {
    return null
  }
}

export function diagnose(error: unknown, opts?: { readonly appRoot?: string }): Diagnostic | null {
  const failure = findExportFailure(error)
  if (!failure) return null

  const pkg = packageNameOf(failure.specifier)
  if (!pkg) return null

  const appRoot = opts?.appRoot ?? process.cwd()
  const manifest = readManifest(appRoot, pkg)

  if (pkg === "@langchain/core" || pkg.startsWith("@langchain/")) {
    const installed = manifest?.version ?? "an older version"
    const range = requiredCoreRange()
    const need = range ? `a version satisfying ${range}` : "a newer version"
    return {
      summary: `${pkg} does not provide the export "${failure.missingExport}" that Dawn's runtime imports.`,
      hint:
        `Your installed @langchain/core is ${installed}; Dawn needs ${need}. ` +
        "An older @langchain/core was likely hoisted into your install. " +
        'Run "npm ls @langchain/core" (or your package manager\'s equivalent) to find the stale copy, ' +
        "then upgrade or dedupe it.",
    }
  }

  if (manifest && manifest.type !== "module") {
    return {
      summary: `Cannot import "${failure.missingExport}" from "${pkg}".`,
      hint:
        `"${pkg}" is a CommonJS package, and Dawn loads route/tool/config modules through Node's ` +
        "ESM resolver, which can't always bind named exports from CommonJS. " +
        `Use a default import and destructure: import pkg from "${pkg}"; const { ${failure.missingExport} } = pkg. ` +
        'If the package ships an ESM build ("type": "module"), upgrade to it.',
    }
  }

  return {
    summary: `Module "${pkg}" does not provide an export named "${failure.missingExport}".`,
    hint:
      `This is usually a version mismatch (the installed "${pkg}" is older or newer than expected) ` +
      `or a module-format issue. Check the installed version with "npm ls ${pkg}".`,
  }
}
