import { readFile, realpath } from "node:fs/promises"
import { isBuiltin } from "node:module"
import { dirname, join, relative } from "node:path"

import type { Plugin } from "esbuild"

const BUILTIN_NAMESPACE = "dawn-vercel-literal-node-builtin"
const PG_NATIVE_NAMESPACE = "dawn-vercel-optional-pg-native"
const PG_NATIVE_CLIENT_PATH = join("lib", "native", "client.js")

interface PackageManifest {
  readonly name?: unknown
  readonly peerDependencies?: unknown
  readonly peerDependenciesMeta?: unknown
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function literalBuiltinSpecifier(specifier: string): string | undefined {
  if (!isBuiltin(specifier)) return undefined
  const bareSpecifier = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier
  if (bareSpecifier === "module") return undefined
  return `node:${bareSpecifier}`
}

async function isOptionalPgNativeImporter(importer: string): Promise<boolean> {
  let realImporter: string
  try {
    realImporter = await realpath(importer)
  } catch {
    return false
  }

  const packageRoot = dirname(dirname(dirname(realImporter)))
  if (relative(packageRoot, realImporter) !== PG_NATIVE_CLIENT_PATH) return false

  let manifest: PackageManifest
  try {
    manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  } catch {
    return false
  }

  const peers = record(manifest.peerDependencies)
  const peerMetadata = record(manifest.peerDependenciesMeta)
  const pgNativeMetadata = record(peerMetadata?.["pg-native"])
  return (
    manifest.name === "pg" &&
    typeof peers?.["pg-native"] === "string" &&
    pgNativeMetadata?.optional === true
  )
}

/** @internal Build-only compatibility for self-contained Node Vercel bundles. */
export function createVercelNodeCompatibilityPlugin(): Plugin {
  return {
    name: "dawn-vercel-node-compatibility",
    setup(build) {
      build.onResolve({ filter: /^pg-native$/ }, async (args) => {
        if (args.kind !== "require-call" || !(await isOptionalPgNativeImporter(args.importer))) {
          return undefined
        }
        return { namespace: PG_NATIVE_NAMESPACE, path: args.path }
      })

      build.onLoad({ filter: /.*/, namespace: PG_NATIVE_NAMESPACE }, () => ({
        contents: `const error = new Error("Cannot find module 'pg-native'")
error.code = "MODULE_NOT_FOUND"
throw error
`,
        loader: "js",
      }))

      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind !== "require-call") return undefined
        const specifier = literalBuiltinSpecifier(args.path)
        if (!specifier) return undefined
        return { namespace: BUILTIN_NAMESPACE, path: specifier }
      })

      build.onLoad({ filter: /.*/, namespace: BUILTIN_NAMESPACE }, (args) => ({
        contents: `import builtin from ${JSON.stringify(args.path)}
module.exports = builtin
`,
        loader: "js",
      }))
    },
  }
}
