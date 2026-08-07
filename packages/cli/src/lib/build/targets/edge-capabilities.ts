import { existsSync, readdirSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import type { DawnConfig, RouteManifest } from "@dawn-ai/core"

import { CliError } from "../../output.js"

/** The target these rules describe. Named in every message. */
const EDGE_TARGET = "hono"

/**
 * One feature this app uses that an edge runtime cannot serve.
 *
 * `capability` and `source` are both required because a message that names only
 * one of them is unactionable: "sandbox is not supported" leaves a user hunting
 * for what turned it on, and a bare file path leaves them guessing why it
 * matters.
 */
export interface EdgeCapabilityViolation {
  /** The feature, in the words the docs use for it (`sandbox`, `skills`, …). */
  readonly capability: string
  /** The config key or file that introduced it — a `dawn.config.ts` key, or an app-relative path. */
  readonly source: string
  /** Why the edge cannot serve it. */
  readonly reason: string
  /** What to do about it, other than "use the node target" (which is said once, globally). */
  readonly remedy: string
}

/** Everything the gate inspects. All of it is available before any emit. */
export interface EdgeCapabilityInput {
  readonly appRoot: string
  readonly config: Pick<DawnConfig, "backends" | "sandbox">
  readonly manifest: RouteManifest
}

/**
 * Every feature this app uses that the `hono` target cannot serve, in a stable
 * order. Empty means the app is edge-deployable.
 *
 * Deliberately returns the whole list rather than throwing on the first find:
 * `dawn check` reports them all at once, and discovering four of these one
 * build at a time is four round trips.
 *
 * Every probe here reads the same source of truth the RUNTIME reads — the
 * `workspace/` directory the workspace marker detects, the
 * `skills/<name>/SKILL.md` layout `discoverSkillDirs` walks, the `memory.ts`
 * the manifest emitter probes — so the gate cannot drift into gating a feature
 * the app does not actually have, or missing one it does.
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
    const skillsDir = join(route.routeDir, "skills")
    if (discoverSkillDirs(skillsDir).length > 0) {
      violations.push({
        capability: "skills",
        source: appRelative(appRoot, skillsDir),
        reason:
          "skill bodies are read from disk when the route loads, and an edge runtime has no filesystem to read them from — the skills would vanish from the prompt with no error at all",
        remedy:
          "Inline the instructions into the route's `systemPrompt`, or serve them from a tool that fetches them",
      })
    }

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
 * Called BEFORE the `hono` target writes its first byte: a build that emits
 * three artifacts and then throws leaves a `.dawn/build` that looks deployable.
 */
export function assertEdgeCapabilities(input: EdgeCapabilityInput): void {
  const violations = collectEdgeCapabilityViolations(input)
  if (violations.length === 0) return
  throw new CliError(formatEdgeCapabilityViolations(violations), 1, { code: "DAWN_E1005" })
}

/** The user-facing report. Shared verbatim by `dawn build` and `dawn check`. */
export function formatEdgeCapabilityViolations(
  violations: readonly EdgeCapabilityViolation[],
): string {
  const lines = violations.map(
    (violation) =>
      `  • ${violation.capability}\n` +
      `      from: ${violation.source}\n` +
      `      why:  ${violation.reason}.\n` +
      `      fix:  ${violation.remedy}.`,
  )
  return (
    `The "${EDGE_TARGET}" build target cannot serve ${violations.length} feature(s) this app uses:\n\n` +
    `${lines.join("\n\n")}\n\n` +
    `The edge deliberately serves a SUBSET of Dawn — no filesystem, no processes, no containers. ` +
    `Fix the features above, or drop "${EDGE_TARGET}" from \`build.targets\` in dawn.config.ts and deploy with the "node" target instead.`
  )
}

// ---------------------------------------------------------------------------
// runtime dependencies
// ---------------------------------------------------------------------------

/** Bare specifiers the emitted `app.mjs` / `stores.mjs` import at runtime. */
const EDGE_RUNTIME_DEPENDENCIES: readonly string[] = [
  "@dawn-ai/cli",
  "@dawn-ai/postgres-storage",
  "@neondatabase/serverless",
  "hono",
]

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
export async function collectEdgeDependencyNotice(appRoot: string): Promise<string | undefined> {
  const packageJsonPath = resolve(appRoot, "package.json")
  if (!existsSync(packageJsonPath)) return undefined
  let dependencies: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, unknown>
    }
    if (parsed.dependencies && typeof parsed.dependencies === "object") {
      dependencies = parsed.dependencies
    }
  } catch {
    // Best-effort — an app whose package.json cannot be parsed has a louder
    // problem than this notice.
    return undefined
  }
  const missing = EDGE_RUNTIME_DEPENDENCIES.filter((name) => !Object.hasOwn(dependencies, name))
  if (missing.length === 0) return undefined
  return (
    `⚠ The "${EDGE_TARGET}" target's app.mjs/stores.mjs import ${missing.join(", ")} at runtime, ` +
    `but ${missing.length === 1 ? "it is" : "they are"} not in this app's "dependencies" — ` +
    `the deploy will fail to resolve ${missing.length === 1 ? "it" : "them"}. Add ${missing.length === 1 ? "it" : "them"} to "dependencies" in package.json.`
  )
}

// ---------------------------------------------------------------------------
// probes
// ---------------------------------------------------------------------------

/**
 * Skill directory names under `skillsDir`, by the SAME rule the skills
 * capability applies (`packages/core/src/capabilities/built-in/skills.ts`):
 * an identifier-shaped directory name containing a `SKILL.md`. Duplicated here
 * rather than imported because that walker takes a `MarkerFs`, which is the
 * runtime's seam, not the build's.
 */
const VALID_SKILL_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function discoverSkillDirs(skillsDir: string): readonly string[] {
  if (!existsSync(skillsDir)) return []
  let entries: string[]
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return []
  }
  return entries.filter(
    (name) =>
      VALID_SKILL_DIR_NAME.test(name) &&
      isDirectory(join(skillsDir, name)) &&
      existsSync(join(skillsDir, name, "SKILL.md")),
  )
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
