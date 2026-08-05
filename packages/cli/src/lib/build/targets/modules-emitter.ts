import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"

import type { RouteDefinition, RouteKind } from "@dawn-ai/core"

import { createRouteAssistantId } from "../../runtime/route-identity.js"
import { discoverStateDefinition } from "../../runtime/state-discovery.js"
import { discoverToolDefinitions, type ToolScope } from "../../runtime/tool-discovery.js"

/**
 * Build-time discovery results for one route — everything the emitter needs
 * to generate that route's entry in `.dawn/build/modules.mjs`. Collected by
 * {@link collectRouteStaticDiscovery} using the SAME discovery functions the
 * dynamic runtime path uses (`discoverToolDefinitions`,
 * `discoverStateDefinition`, the `tools.json` read, the `memory.ts` probe) —
 * never a parallel implementation.
 */
export interface RouteStaticDiscovery {
  /** Absolute route entry file path (build machine). */
  readonly entryFile: string
  readonly kind: RouteKind
  /** Absolute `memory.ts` path when the route has one (agent routes only). */
  readonly memoryFile: string | undefined
  /** Reducer-override files, keyed by state field (agent routes only). */
  readonly reducers: readonly { readonly field: string; readonly filePath: string }[] | undefined
  readonly routeId: string
  /**
   * `state.ts` defaults as entries; `undefined` when the route has no state
   * definition, `[]` when it has a defined-but-empty one (mirrors the
   * dynamic path's `discoverStateDefinition` null-vs-empty distinction).
   */
  readonly stateDefaults: readonly (readonly [string, unknown])[] | undefined
  /** Parsed `.dawn/routes/<slug>/tools.json` content, when present. */
  readonly toolSchemas: Record<string, unknown> | undefined
  /** Discovered tools in discovery order (shared first, then route-local). */
  readonly tools: readonly {
    readonly filePath: string
    readonly name: string
    readonly scope: ToolScope
  }[]
}

/**
 * Run the runtime's own discovery functions against one route at build time
 * and capture what the generator needs. Tool/state/memory semantics mirror
 * `loadPreparedRouteModules` in `execute-route.ts` exactly.
 */
export async function collectRouteStaticDiscovery(options: {
  readonly appRoot: string
  readonly route: RouteDefinition
}): Promise<RouteStaticDiscovery> {
  const { appRoot, route } = options

  const discoveredTools = await discoverToolDefinitions({ appRoot, routeDir: route.routeDir })
  const tools = discoveredTools.map((tool) => ({
    filePath: tool.filePath,
    name: tool.name,
    scope: tool.scope,
  }))

  // Same slug math + best-effort read as the runtime's tools.json injection.
  const routeSlug =
    route.id.replace(/^\//, "").replace(/\//g, "-").replace(/\[/g, "").replace(/\]/g, "") || "index"
  const schemaManifestPath = join(appRoot, ".dawn", "routes", routeSlug, "tools.json")
  let toolSchemas: Record<string, unknown> | undefined
  if (existsSync(schemaManifestPath)) {
    try {
      toolSchemas = JSON.parse(await readFile(schemaManifestPath, "utf8")) as Record<
        string,
        unknown
      >
    } catch {
      // Generated schema is best-effort — fall through on parse errors.
    }
  }

  let stateDefaults: RouteStaticDiscovery["stateDefaults"]
  let reducers: RouteStaticDiscovery["reducers"]
  if (route.kind === "agent") {
    const stateDefinition = await discoverStateDefinition({ routeDir: route.routeDir })
    if (stateDefinition) {
      stateDefaults = [...stateDefinition.defaults.entries()]
      // `discoverStateDefinition` already filtered overrides to files whose
      // default export is a function; the file path follows its
      // `reducers/<field>.ts` naming rule.
      reducers = [...stateDefinition.reducerOverrides.keys()].map((field) => ({
        field,
        filePath: join(route.routeDir, "reducers", `${field}.ts`),
      }))
    }
  }

  const memoryFilePath = join(route.routeDir, "memory.ts")
  const memoryFile =
    route.kind === "agent" && existsSync(memoryFilePath) ? memoryFilePath : undefined

  return {
    entryFile: route.entryFile,
    kind: route.kind,
    memoryFile,
    reducers,
    routeId: route.id,
    stateDefaults,
    toolSchemas,
    tools,
  }
}

/**
 * Generate the text of `.dawn/build/modules.mjs`: static imports of every
 * route/tool/memory/reducer module, inlined build-time literals, and one
 * `buildStaticRouteModule(...)` call per route, default-exporting a
 * `DawnStaticModules`.
 *
 * Deliberately NOT the langsmith emitter's shape — no graphs are
 * materialized; the payload is `prepareRouteExecution`'s full input set,
 * normalized at runtime by `buildStaticRouteModule`.
 *
 * Determinism: routes are sorted by assistantId; tools keep their (already
 * deterministic, sorted-readdir) discovery order so the static tool order
 * matches exactly what the dynamic path derives.
 *
 * Portability: `routeFile`/tool paths are resolved from `import.meta.url` at
 * RUNTIME — images built at one path and run at another still get correct
 * absolute paths (`.dawn/build` sits two directories below the app root, the
 * same math server.mjs uses).
 */
export function emitModulesFile(options: {
  readonly appRoot: string
  readonly buildDir: string
  readonly discoveries: readonly RouteStaticDiscovery[]
}): string {
  const { appRoot, buildDir } = options
  const sorted = [...options.discoveries].sort((left, right) =>
    createRouteAssistantId(left.routeId, left.kind).localeCompare(
      createRouteAssistantId(right.routeId, right.kind),
    ),
  )

  const moduleImports: string[] = []
  const routeCalls: string[] = []

  sorted.forEach((discovery, routeIndex) => {
    const routeVar = `route${routeIndex}`
    // Specifiers go through JSON.stringify like every other interpolated
    // value: a quote, backslash, or newline in a path component must not be
    // able to break out of the generated string literal.
    moduleImports.push(
      `import * as ${routeVar} from ${JSON.stringify(importSpecifier(buildDir, discovery.entryFile))}`,
    )

    const toolEntries = discovery.tools.map((tool, toolIndex) => {
      const toolVar = `${routeVar}_tool${toolIndex}`
      moduleImports.push(
        `import * as ${toolVar} from ${JSON.stringify(importSpecifier(buildDir, tool.filePath))}`,
      )
      return `        { filePath: resolve(appRoot, ${JSON.stringify(appRootRelative(appRoot, tool.filePath))}), module: ${toolVar}, name: ${JSON.stringify(tool.name)}, scope: ${JSON.stringify(tool.scope)} },`
    })

    const reducerEntries = (discovery.reducers ?? []).map((reducer, reducerIndex) => {
      const reducerVar = `${routeVar}_reducer${reducerIndex}`
      // Default import: the dynamic path binds `mod.default` as the override.
      moduleImports.push(
        `import ${reducerVar} from ${JSON.stringify(importSpecifier(buildDir, reducer.filePath))}`,
      )
      return `[${JSON.stringify(reducer.field)}, ${reducerVar}]`
    })

    let memoryVar: string | undefined
    if (discovery.memoryFile) {
      memoryVar = `${routeVar}_memory`
      moduleImports.push(
        `import * as ${memoryVar} from ${JSON.stringify(importSpecifier(buildDir, discovery.memoryFile))}`,
      )
    }

    const lines: string[] = []
    lines.push(`    buildStaticRouteModule({`)
    lines.push(`      kind: ${JSON.stringify(discovery.kind)},`)
    if (memoryVar) {
      lines.push(`      memoryModule: ${memoryVar},`)
    }
    lines.push(
      `      routeFile: resolve(appRoot, ${JSON.stringify(appRootRelative(appRoot, discovery.entryFile))}),`,
    )
    lines.push(`      routeId: ${JSON.stringify(discovery.routeId)},`)
    lines.push(`      routeModule: ${routeVar},`)
    lines.push(`      routePath: ${JSON.stringify(appRootRelative(appRoot, discovery.entryFile))},`)
    if (discovery.stateDefaults) {
      // Defaults come from arbitrary user schema code; the dynamic path hands
      // the live values to resolveStateFields while this path inlines them.
      // Fail the build on anything that would not survive JSON serialization
      // intact (Date, Map/Set, NaN, undefined, BigInt, class instances, …) —
      // silently shipping a mutated default would fork prod behavior from dev.
      for (const [name, value] of discovery.stateDefaults) {
        const badPath = findNonJsonPath(value, name)
        if (badPath !== null) {
          throw new Error(
            `Route "${discovery.routeId}" state field "${name}" has a default that cannot be ` +
              `inlined as JSON (at ${badPath}). Static builds serialize state defaults into ` +
              `.dawn/build/modules.mjs — use JSON-compatible defaults (plain objects, arrays, ` +
              `strings, finite numbers, booleans, null).`,
          )
        }
      }
      // JSON.parse of a string literal, not a bare object/array literal: in a
      // JS literal a quoted "__proto__" key performs prototype assignment,
      // silently diverging from the dynamic path's JSON.parse semantics.
      lines.push(
        `      stateDefaults: JSON.parse(${JSON.stringify(JSON.stringify(discovery.stateDefaults))}),`,
      )
    }
    if (reducerEntries.length > 0) {
      lines.push(`      stateReducers: [${reducerEntries.join(", ")}],`)
    }
    if (discovery.toolSchemas) {
      // Same JSON.parse encoding as stateDefaults (see comment above).
      lines.push(
        `      toolSchemas: JSON.parse(${JSON.stringify(JSON.stringify(discovery.toolSchemas))}),`,
      )
    }
    if (toolEntries.length === 0) {
      lines.push(`      tools: [],`)
    } else {
      lines.push(`      tools: [`)
      lines.push(...toolEntries)
      lines.push(`      ],`)
    }
    lines.push(`    }),`)
    routeCalls.push(lines.join("\n"))
  })

  return [
    `// Generated by dawn build (node target). Regenerated on every build — do not edit.`,
    `// Static module manifest: every route/tool/memory/reducer module below is a`,
    `// static import, so the whole app module graph is known without filesystem`,
    `// discovery at boot. Loaded by server.mjs via loadStaticModules().`,
    `import { dirname, resolve } from "node:path"`,
    `import { fileURLToPath } from "node:url"`,
    ``,
    `import { buildStaticRouteModule } from "@dawn-ai/cli/runtime"`,
    ``,
    ...moduleImports,
    ``,
    `// modules.mjs lives at <appRoot>/.dawn/build/modules.mjs → appRoot is two dirs`,
    `// up. Absolute paths are computed here at RUNTIME so a manifest built at one`,
    `// path stays correct when the app runs at another (e.g. inside a container).`,
    `const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")`,
    ``,
    `export default {`,
    `  routes: [`,
    ...routeCalls,
    `  ],`,
    `}`,
    ``,
  ].join("\n")
}

/**
 * Relative import specifier from the build dir, forward-slashed. Kept `.ts`:
 * the manifest is only ever linked through the tsx loader (loadStaticModules
 * registers it first), which resolves `.ts` specifiers directly — whereas a
 * rewritten `.js` specifier would bind a stale in-place-compiled `foo.js`
 * sibling first when one exists, a file the dynamic path never imports.
 */
function importSpecifier(buildDir: string, absoluteFile: string): string {
  const rel = relative(buildDir, absoluteFile).split(sep).join("/")
  return rel.startsWith(".") ? rel : `./${rel}`
}

/** appRoot-relative path literal, forward-slashed (kept `.ts` — a source path). */
function appRootRelative(appRoot: string, absoluteFile: string): string {
  return relative(appRoot, absoluteFile).split(sep).join("/")
}

/**
 * Locate the first value under `value` that would not survive
 * `JSON.parse(JSON.stringify(...))` structurally intact, returning its path
 * (for the build error) or null when the whole value is JSON-representable.
 * Rejects non-finite numbers, undefined/functions/symbols/bigints, any object
 * with a non-plain prototype (Date, Map, Set, class instances — stringify
 * mutates or drops them all), and cycles (stringify throws on those).
 */
function findNonJsonPath(value: unknown, path: string, seen = new Set<object>()): string | null {
  if (value === null) return null
  const kind = typeof value
  if (kind === "string" || kind === "boolean") return null
  if (kind === "number") return Number.isFinite(value as number) ? null : path
  if (kind !== "object") return path
  const obj = value as object
  // `seen` tracks only the CURRENT ancestor chain (delete on unwind): a value
  // referenced from two sibling positions is legal JSON, only a true cycle
  // along one path is not.
  if (seen.has(obj)) return `${path} (circular reference)`
  seen.add(obj)
  try {
    if (Array.isArray(obj)) {
      for (let index = 0; index < obj.length; index++) {
        const hit = findNonJsonPath(obj[index], `${path}[${index}]`, seen)
        if (hit !== null) return hit
      }
      return null
    }
    const proto = Object.getPrototypeOf(obj)
    if (proto !== Object.prototype && proto !== null) return path
    for (const [key, entry] of Object.entries(obj)) {
      const hit = findNonJsonPath(entry, `${path}.${key}`, seen)
      if (hit !== null) return hit
    }
    return null
  } finally {
    seen.delete(obj)
  }
}
