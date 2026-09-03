import { existsSync, readdirSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import type { DawnConfig, RouteManifest } from "@dawn-ai/core"

import { CliError } from "../../output.js"
import {
  EDGE_TARGET,
  type EdgeCapabilityViolation,
  formatEdgeCapabilityViolations,
} from "../../runtime/edge-capability-report.js"

// The violation shape and the report text live in `edge-capability-report.ts`
// — a `node:`-free module — because the REQUEST-time half of this gate
// (`collectRuntimeCapabilityGaps`, reached from `@dawn-ai/cli/fetch`) must
// raise the same DAWN_E1005 in the same words, and cannot import a module that
// touches `node:fs`. Deliberately NOT re-exported from here: this file reads
// the filesystem, so re-exporting would let a runtime consumer reach the whole
// build-side gate through it and quietly pull `node:fs` back into that graph.
// Import them from `edge-capability-report.js` directly.

/** Everything the gate inspects. All of it is available before any emit. */
export interface EdgeCapabilityInput {
  readonly appRoot: string
  readonly config: Pick<
    DawnConfig,
    | "backends"
    | "checkpointer"
    | "memory"
    | "permissions"
    | "sandbox"
    | "threadsStore"
    | "toolOutput"
  >
  readonly manifest: RouteManifest
}

/**
 * Store handles the emitted `stores.mjs` supplies itself, per request.
 *
 * A config that sets one of these is not merely unsupported — it is SILENTLY
 * overridden: the handle is a live object, so `toSerializableConfig` strips it
 * out of the inlined config and the generated Postgres store takes its place
 * with nothing said. Naming the key at build time is the whole point.
 */
const EDGE_OVERRIDDEN_STORES: readonly {
  readonly key: string
  readonly capability: string
  /** What actually happens to it at runtime today, said plainly. */
  readonly outcome: string
  readonly read: (config: EdgeCapabilityInput["config"]) => unknown
}[] = [
  {
    key: "checkpointer",
    capability: "a custom checkpointer",
    outcome: "replaced by the Postgres checkpointer the emitted stores.mjs builds per request",
    read: (c) => c.checkpointer,
  },
  {
    key: "threadsStore",
    capability: "a custom threads store",
    outcome: "replaced by the Postgres threads store the emitted stores.mjs builds per request",
    read: (c) => c.threadsStore,
  },
  {
    key: "permissions.store",
    capability: "a custom permissions store",
    outcome: "replaced by the Postgres permissions store the emitted stores.mjs builds per request",
    read: (c) => c.permissions?.store,
  },
  {
    key: "memory.store",
    capability: "a custom memory store",
    outcome:
      "dropped outright — the emitted stores.mjs supplies no memory store, so the first `recall`/`remember` would fail with DAWN_E5301",
    read: (c) => c.memory?.store,
  },
]

/**
 * Every feature this app uses that an edge-subset target cannot serve, in a
 * stable order. Empty means the app is edge-deployable.
 *
 * Deliberately returns the whole list rather than throwing on the first find:
 * `dawn check` reports them all at once, and discovering four of these one
 * build at a time is four round trips.
 *
 * Every probe here reads the same source of truth the RUNTIME reads — the
 * `workspace/` directory the workspace marker detects and the `memory.ts` the
 * manifest emitter probes — so the gate cannot drift into gating a feature the
 * app does not actually have, or missing one it does.
 *
 * Skills are deliberately NOT here. Their bodies (and `plan.md` / `memory.md`)
 * are bundled into `modules.edge.mjs` and served through `staticMarkerFs`, so
 * an edge route ships them intact; a marker file too large to bundle fails the
 * build in `collectRouteMarkerFiles` instead, during discovery.
 */
export function collectEdgeCapabilityViolations(
  input: EdgeCapabilityInput,
): readonly EdgeCapabilityViolation[] {
  const { appRoot, config, manifest } = input
  const violations: EdgeCapabilityViolation[] = []

  if (config.sandbox) {
    violations.push({
      capability: "sandbox",
      source: "`sandbox` in dawn.config.ts",
      reason:
        "a sandbox isolates tool execution in a container or pod, and an edge runtime can neither start one nor talk to a container daemon",
      remedy: "Remove the `sandbox` block",
    })
  }

  // Offloading is the one gated feature with a config key that survives the
  // build boundary intact, so without this the build went green and the
  // REQUEST-time guard rejected the deployed worker instead — a green build and
  // a dead deploy is worse than either check alone. Both halves now agree.
  // An empty object expresses no intent (and `toSerializableConfig` drops it).
  if (config.toolOutput && Object.keys(config.toolOutput).length > 0) {
    violations.push({
      capability: "tool-output offloading",
      source: "`toolOutput` in dawn.config.ts",
      reason:
        "offloading spills oversized tool output to a file under workspace/ and hands the model a pointer to it, and an edge runtime has no filesystem to spill to — every one of these settings would be inlined into the bundle and then ignored",
      remedy: "Remove `toolOutput`",
    })
  }

  for (const kind of ["filesystem", "exec"] as const) {
    if (config.backends?.[kind]) {
      violations.push({
        capability: `${kind} backend`,
        source: `\`backends.${kind}\` in dawn.config.ts`,
        reason:
          "a backend is a live object, and nothing can carry an object across a build boundary into a deployed bundle — the emitted app.mjs inlines only the JSON-serializable half of your config",
        remedy: `Remove \`backends.${kind}\``,
      })
    }
  }

  // A configured store handle is the quietest failure of the lot: nothing
  // errors, the build succeeds, and the deployed app just uses a different
  // database than the config says. Named by key, at build time.
  for (const store of EDGE_OVERRIDDEN_STORES) {
    if (store.read(config) === undefined) continue
    violations.push({
      capability: store.capability,
      source: `\`${store.key}\` in dawn.config.ts`,
      reason:
        `a store handle is a live object, and nothing can carry an object across a build boundary ` +
        `into a deployed bundle — only the JSON-serializable half of your config is inlined, so at ` +
        `runtime yours is ${store.outcome}`,
      remedy: `Remove \`${store.key}\``,
    })
  }

  // The workspace marker activates on this directory alone (workspace.ts), and
  // it is also what gates tool-output offloading (execute-route-core.ts's
  // `hasWorkspaceDir`) and where AGENTS.md is read from. On the edge every one
  // of those degrades SILENTLY: the tools are contributed and then throw at
  // invocation time, offloading just stops, AGENTS.md never reaches the prompt.
  const workspaceDir = resolve(appRoot, "workspace")
  if (isDirectory(workspaceDir)) {
    violations.push({
      capability:
        "workspace tooling (readFile / writeFile / listDir / runBash, tool-output offloading, workspace/AGENTS.md)",
      source: `the ${appRelative(appRoot, workspaceDir)} directory`,
      reason:
        "these tools read and write real files and spawn real processes, and an edge runtime has neither a filesystem nor a shell — the tools would be offered to the model and then fail at the first call",
      remedy: `Move ${appRelative(appRoot, workspaceDir)} out of the app root and replace those tools with route-local tools that call an API`,
    })
  }

  for (const route of manifest.routes) {
    // Agent-route `memory.ts` is exactly what the manifest emitter probes for,
    // and what makes the runtime demand a memoryStore.
    const memoryFile = join(route.routeDir, "memory.ts")
    if (route.kind === "agent" && existsSync(memoryFile)) {
      violations.push({
        capability: "long-term memory",
        source: appRelative(appRoot, memoryFile),
        reason:
          "the emitted stores.mjs supplies a checkpointer, a threads store and a permissions store, but no memory store — the first `recall`/`remember` call would fail with DAWN_E5301 at request time. `memory.store` cannot fill the gap either: it is a live object, and only the JSON-serializable half of your config crosses the build boundary",
        remedy: `Delete ${appRelative(appRoot, memoryFile)}`,
      })
    }
  }

  return violations
}

/**
 * Fail the build, by name, on anything the edge cannot serve.
 *
 * Called BEFORE either Hono or Vercel writes deployable artifacts: a build that
 * emits three artifacts and then throws leaves output that looks deployable.
 */
export function assertEdgeCapabilities(
  input: EdgeCapabilityInput,
  targetName: "hono" | "vercel" = "hono",
): void {
  const violations = collectEdgeCapabilityViolations(input)
  if (violations.length === 0) return
  throw new CliError(formatEdgeCapabilityViolationsForTarget(violations, targetName), 1, {
    code: "DAWN_E1005",
  })
}

/**
 * Preserve the shared build/runtime wording while naming the target that is
 * actually being built. The shared report deliberately owns the canonical
 * Hono text; Vercel changes only the two quoted target references.
 */
function formatEdgeCapabilityViolationsForTarget(
  violations: readonly EdgeCapabilityViolation[],
  targetName: "hono" | "vercel",
): string {
  return formatEdgeCapabilityViolations(violations).replaceAll(
    `"${EDGE_TARGET}"`,
    `"${targetName}"`,
  )
}

// ---------------------------------------------------------------------------
// runtime dependencies
// ---------------------------------------------------------------------------

/**
 * Bare specifiers the emitted `app.mjs` / `stores.mjs` import at runtime.
 *
 * None of these is a dependency of `@dawn-ai/cli`, and that is deliberate: the
 * CLI does not import any of them — the app it GENERATES does. Vendoring them
 * into the CLI would resolve them only under a hoisting layout, and silently
 * not under pnpm's strict one. The app declares what the app imports.
 */
const EDGE_RUNTIME_DEPENDENCIES: readonly string[] = [
  "@dawn-ai/cli",
  "@dawn-ai/postgres-storage",
  "@neondatabase/serverless",
  "hono",
]

/**
 * Every `package.json` field that can make a bare specifier resolve for a
 * bundler at deploy time.
 *
 * Wider than the node target's `dependencies`-only check on purpose, and for a
 * different reason: the node image runs `npm ci --omit=dev`, so a devDependency
 * genuinely IS missing at runtime there. `wrangler deploy` bundles from the
 * source tree instead, where a devDependency resolves fine — reporting one as
 * missing would be a false alarm. `dependencies` is still the right advice for
 * something the deployed app needs, which is what the notice says.
 */
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const

/**
 * Advisory notice naming the packages the emitted entry imports but the app's
 * `package.json` does not declare as runtime dependencies — `undefined` when
 * there is nothing to say.
 *
 * A NOTICE and not a build failure, matching the node target's
 * `warnIfCliNotRuntimeDependency`: `package.json` is strong evidence but not
 * proof (workspace hoisting, a bundler alias, and a vendored dependency all
 * resolve fine while leaving `dependencies` untouched), so failing on it would
 * block builds that are correct. Unreadable or malformed `package.json` is
 * skipped rather than guessed at.
 *
 * It exists because the alternative is worse: `stores.mjs` imports these by
 * bare specifier, so a missing one surfaces as an unresolved import during
 * `wrangler deploy` — minutes later and a process away from the cause.
 */
export async function collectEdgeDependencyNotice(
  appRoot: string,
  targetName: "hono" | "vercel" = "hono",
): Promise<string | undefined> {
  const packageJsonPath = resolve(appRoot, "package.json")
  if (!existsSync(packageJsonPath)) return undefined
  const declared = new Set<string>()
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>
    for (const field of DEPENDENCY_FIELDS) {
      const map = parsed[field]
      if (map && typeof map === "object") for (const name of Object.keys(map)) declared.add(name)
    }
  } catch {
    // Best-effort — an app whose package.json cannot be parsed has a louder
    // problem than this notice.
    return undefined
  }
  const missing = EDGE_RUNTIME_DEPENDENCIES.filter((name) => !declared.has(name))
  if (missing.length === 0) return undefined
  return (
    `⚠ The "${targetName}" target's app.mjs/stores.mjs import ${missing.join(", ")} at runtime, ` +
    `but ${missing.length === 1 ? "it is" : "they are"} not in this app's "dependencies" — ` +
    `the deploy will fail to resolve ${missing.length === 1 ? "it" : "them"}. Add ${missing.length === 1 ? "it" : "them"} to "dependencies" in package.json.`
  )
}

// ---------------------------------------------------------------------------
// probes
// ---------------------------------------------------------------------------

/**
 * Skill directory names under `skillsDir`, sorted, by the SAME rule the skills
 * capability applies (`packages/core/src/capabilities/built-in/skills.ts`):
 * an identifier-shaped directory name containing a `SKILL.md`. Duplicated here
 * rather than imported because that walker takes a `MarkerFs`, which is the
 * runtime's seam, not the build's. Sorted rather than left in `readdirSync`
 * order so every consumer — the gate, the recorded manifest names, and the
 * marker-file reader — sees the same deterministic order.
 *
 * Exported because the static-module emitter records the same names into the
 * manifest (see `RouteStaticDiscovery.skills`), the marker-file reader walks
 * the same names to bundle each skill's body (see `collectRouteMarkerFiles`),
 * and the request-time guard reads them back. A second copy of this rule is how
 * the emitter, the bundler and the runtime guard would start disagreeing about
 * what counts as a skill.
 */
const VALID_SKILL_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function discoverSkillDirs(skillsDir: string): readonly string[] {
  if (!existsSync(skillsDir)) return []
  let entries: string[]
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return []
  }
  return entries
    .filter(
      (name) =>
        VALID_SKILL_DIR_NAME.test(name) &&
        isDirectory(join(skillsDir, name)) &&
        existsSync(join(skillsDir, name, "SKILL.md")),
    )
    .sort()
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * A path as the user would type it, with a trailing separator on directories so
 * `workspace/` reads as a directory rather than a file. Falls back to the
 * absolute path if the target somehow sits outside the app root — a message is
 * never worth throwing over.
 */
function appRelative(appRoot: string, path: string): string {
  const rel = relative(appRoot, path)
  if (!rel || rel.startsWith("..")) return path
  return isDirectory(path) ? `${rel}${sep}` : rel
}
