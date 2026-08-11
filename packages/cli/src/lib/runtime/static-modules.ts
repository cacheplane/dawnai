/**
 * The node half of the static-module manifest: booting from a generated
 * `.dawn/build/modules.mjs`, which must be linked through the tsx loader.
 * Re-exports the pure half so this stays the one import site callers know.
 */

import { validateThreadAccessPolicy } from "../dev/thread-access.js"
import { registerTsxLoader } from "./register-tsx-loader.js"
import type { DawnStaticModules, StaticRouteModule } from "./static-modules-core.js"

export * from "./static-modules-core.js"

/**
 * Boot-time loader for a generated `modules.mjs` — what the node target's
 * `server.mjs` calls. The manifest statically imports the app's TypeScript
 * sources, so the TS loader must be registered BEFORE the manifest is linked;
 * a bare static `import` in server.mjs would fail to resolve them under plain
 * Node. Registers the loader, imports the manifest, and validates its shape.
 */
export async function loadStaticModules(manifestUrl: URL | string): Promise<DawnStaticModules> {
  await registerTsxLoader()
  const href = typeof manifestUrl === "string" ? manifestUrl : manifestUrl.href
  const mod = (await import(href)) as { readonly default?: unknown }
  const manifest = mod.default
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !Array.isArray((manifest as { readonly routes?: unknown }).routes)
  ) {
    throw new Error(
      `Static module manifest at ${href} must default-export { routes: [...] } — re-run \`dawn build\`.`,
    )
  }
  // Middleware is optional, and `undefined` is legitimate (the emitted
  // `normalizeMiddlewareModule(...)` returns undefined for a middleware file
  // with no usable export) — but any other non-function value is corruption.
  const middleware = (manifest as { readonly middleware?: unknown }).middleware
  if (middleware !== undefined && typeof middleware !== "function") {
    throw new Error(
      `Static module manifest at ${href} has a non-function middleware entry — re-run \`dawn build\`.`,
    )
  }
  // Thread access is optional, and `undefined` is legitimate (an app with no
  // policy file emits no entry) — but anything present must be a well-formed
  // policy. Validated with the same function the dynamic loader uses, because
  // types are erased across the manifest import.
  const threadAccess = (manifest as { readonly threadAccess?: unknown }).threadAccess
  if (threadAccess !== undefined) {
    const reason = validateThreadAccessPolicy(threadAccess)
    if (reason) {
      throw new Error(
        `Static module manifest at ${href} has an invalid threadAccess entry (${reason}) — re-run \`dawn build\`.`,
      )
    }
  }
  const routes = (manifest as { readonly routes: readonly unknown[] }).routes
  for (const entry of routes) {
    if (!isStaticRouteModuleLike(entry)) {
      throw new Error(
        `Static module manifest at ${href} contains a malformed route entry — ` +
          `each entry needs assistantId/routeId/routeFile/module/tools. Re-run \`dawn build\`.`,
      )
    }
  }
  return manifest as DawnStaticModules
}

/**
 * Per-entry structural check: the manifest file is generated, but this loader
 * is a public export — a near-miss object (or an entry-level corruption the
 * `{ routes: [] }` shape check can't see) should fail here with the re-run
 * message, not degrade into 404s and undefined cache keys at serve time.
 */
function isStaticRouteModuleLike(entry: unknown): entry is StaticRouteModule {
  if (!entry || typeof entry !== "object") return false
  const candidate = entry as {
    readonly assistantId?: unknown
    readonly module?: unknown
    readonly routeFile?: unknown
    readonly routeId?: unknown
    readonly tools?: unknown
  }
  return (
    typeof candidate.assistantId === "string" &&
    typeof candidate.routeId === "string" &&
    typeof candidate.routeFile === "string" &&
    typeof candidate.module === "object" &&
    candidate.module !== null &&
    Array.isArray(candidate.tools)
  )
}
