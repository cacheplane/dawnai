/**
 * The `node:`-free half of the edge capability gate: the violation shape, the
 * two report voices, and the RUNTIME probe that decides which gated features
 * this process cannot actually serve.
 *
 * Split out of `build/targets/edge-capabilities.ts` (which reads the filesystem,
 * so it can never enter the `@dawn-ai/cli/fetch` graph) because the gate has two
 * halves that must agree word for word:
 *
 *  • BUILD time — `assertEdgeCapabilities` walks the app's directories and fails
 *    `dawn build` / `dawn check` before the `hono` target writes a byte;
 *  • REQUEST time — {@link collectRuntimeCapabilityGaps} runs inside
 *    `createRuntimeFetchHandler` and raises the SAME `DAWN_E1005` for anything
 *    that got past the build gate.
 *
 * The second half is not redundant. The build gate only runs when the `hono`
 * target does, and composing an entry by hand over `@dawn-ai/cli/fetch` is a
 * documented, supported way to deploy — such an app never runs the target, so
 * without this probe a `sandbox` block (or `toolOutput`, or a route's skills)
 * would be read and then quietly do nothing. Silent no-ops are exactly what the
 * gate exists to prevent.
 */

import type { DawnConfig } from "@dawn-ai/core"

/** The target these rules describe. Named in the build-time message. */
export const EDGE_TARGET = "hono"

/**
 * One feature this app uses that the runtime in question cannot serve.
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
  /** Why it cannot be served. */
  readonly reason: string
  /** What to do about it, other than "use the node target" (which is said once, globally). */
  readonly remedy: string
}

/** The per-violation block both reports share verbatim. */
function formatViolationList(violations: readonly EdgeCapabilityViolation[]): string {
  return violations
    .map(
      (violation) =>
        `  • ${violation.capability}\n` +
        `      from: ${violation.source}\n` +
        `      why:  ${violation.reason}.\n` +
        `      fix:  ${violation.remedy}.`,
    )
    .join("\n\n")
}

/**
 * The BUILD-time report. Shared verbatim by `dawn build` and `dawn check`.
 *
 * Its wording is deliberately about the TARGET ("the hono build target cannot
 * serve…") because at build time nothing is running yet — the user is choosing
 * a deployment shape, and the actionable advice is to change `build.targets`.
 */
export function formatEdgeCapabilityViolations(
  violations: readonly EdgeCapabilityViolation[],
): string {
  return (
    `The "${EDGE_TARGET}" build target cannot serve ${violations.length} feature(s) this app uses:\n\n` +
    `${formatViolationList(violations)}\n\n` +
    `The edge deliberately serves a SUBSET of Dawn — no filesystem, no processes, no containers. ` +
    `Fix the features above, or drop "${EDGE_TARGET}" from \`build.targets\` in dawn.config.ts and deploy with the "node" target instead.`
  )
}

/**
 * The REQUEST-time report.
 *
 * Same violations, different voice: by the time this fires the app is deployed
 * and serving, so "drop hono from build.targets" is not the whole story — the
 * app may never have run the target at all (a hand-composed entry over
 * `@dawn-ai/cli/fetch`). It therefore names the RUNTIME, and the fix is to
 * remove the dead config or inject the missing instance.
 */
export function formatRuntimeCapabilityViolations(
  violations: readonly EdgeCapabilityViolation[],
): string {
  return (
    `This runtime cannot serve ${violations.length} feature(s) this app is configured for:\n\n` +
    `${formatViolationList(violations)}\n\n` +
    `This runtime supplied no filesystem fallbacks — the shape an edge deployment has (no ` +
    `filesystem, no processes, no containers). Every feature above would otherwise be read from ` +
    `your config and then silently do nothing, so it is raised instead. Fix them, or run this app ` +
    `on Node with the "node" build target.`
  )
}

// ---------------------------------------------------------------------------
// request-time probe
// ---------------------------------------------------------------------------

/**
 * Everything the runtime probe inspects. All of it is known at handler
 * construction, so the check is one pass at boot rather than per request.
 */
export interface RuntimeCapabilityInput {
  /**
   * The config this handler was given, if any. On the `hono` target this is the
   * JSON-serializable half inlined into `app.mjs`; for a hand-composed entry it
   * is whatever the author passed.
   */
  readonly config: Pick<DawnConfig, "sandbox" | "toolOutput"> | undefined
  /**
   * Whether this runtime supplied `bootFallbacks` — i.e. whether it has a
   * filesystem, processes and a container daemon to fall back on.
   *
   * THE load-bearing condition. Every node caller reaches the runtime through
   * `runtime-fetch-handler.ts` or `execute-route.ts`, both of which apply
   * `nodeBootFallbacks` unconditionally, so this is `true` on every node path
   * that exists — which is what makes it impossible for any violation below to
   * fire on an ordinary Node app. It is `false` only for a caller that opted
   * out of the node bag entirely, which today means an edge runtime.
   */
  readonly hasFilesystemFallback: boolean
  /**
   * Whether a `SandboxManager` was resolved (injected, or built from the node
   * fallbacks). A caller that injects its own is serving `sandbox` fine.
   */
  readonly hasSandboxManager: boolean
  /** The static module manifest's routes, when the handler booted from one. */
  readonly routes: readonly {
    readonly routeId: string
    /** Skill directory names this route had at BUILD time (see StaticRouteModule). */
    readonly skills?: readonly string[]
  }[]
}

/**
 * Every gated feature this app is configured for that this runtime cannot
 * actually serve, in a stable order. Empty means there is nothing to say.
 *
 * The rule for every entry is the same, and it is narrow on purpose:
 * **configured AND unservable AND not otherwise supplied**. "Unservable" is
 * always `!hasFilesystemFallback`, never a guess — so a normal Node app, which
 * always has the fallback bag, can never reach a single `push` below no matter
 * what it configures. That asymmetry is deliberate: `sandbox` absent means "no
 * sandbox" on Node and that is a documented degrade path (see `requireFallbacks`
 * in `execute-route-core.ts`), so a guard that fired there would break working
 * apps to report a non-problem.
 *
 * Returns the whole list rather than throwing on the first find, matching the
 * build gate: an operator should learn about all of it in one deploy.
 */
export function collectRuntimeCapabilityGaps(
  input: RuntimeCapabilityInput,
): readonly EdgeCapabilityViolation[] {
  const violations: EdgeCapabilityViolation[] = []
  // Nothing below can be a problem on a runtime that has the node bag: every
  // one of these features resolves through it. Returning early also keeps the
  // node path free of even the config reads.
  if (input.hasFilesystemFallback) return violations

  // sandbox — the build gate rejects `sandbox` for the hono target outright, so
  // this fires for an entry composed by hand over `@dawn-ai/cli/fetch`. An
  // injected sandboxManager means the caller took over: not a gap.
  if (input.config?.sandbox && !input.hasSandboxManager) {
    violations.push({
      capability: "sandbox",
      source: "`sandbox` in dawn.config.ts",
      reason:
        "a sandbox isolates tool execution in a container or pod, and this runtime can neither " +
        "start one nor talk to a container daemon — no sandbox provider was resolved, so every " +
        "tool would run unsandboxed instead of failing",
      remedy:
        "Remove the `sandbox` block, or pass your own `sandboxManager` to createRuntimeFetchHandler",
    })
  }

  // tool-output offloading — `toolOutput` exists only to configure it. On node
  // it is gated on a `workspace/` directory, so an app without one already gets
  // nothing; here there is no filesystem at all, so the whole key is dead.
  // An EMPTY object is not "configured" — the hono target's `toolOutput`
  // stripping drops empty objects for the same reason.
  if (input.config?.toolOutput && Object.keys(input.config.toolOutput).length > 0) {
    violations.push({
      capability: "tool-output offloading",
      source: "`toolOutput` in dawn.config.ts",
      reason:
        "offloading spills oversized tool output to a file under workspace/ and hands the model a " +
        "pointer to it, and this runtime has no filesystem to spill to — every one of these " +
        "settings would be read and then ignored, and large tool results would go to the model whole",
      remedy: "Remove `toolOutput`",
    })
  }

  // skills — the one feature with no config key and no runtime trace of its
  // own: bodies are read from `<routeDir>/skills/<name>/SKILL.md` when the
  // route loads, and without a MarkerFs the skills capability's `detect` simply
  // returns false. Nothing at request time can tell "this route had skills"
  // from "this route had none", which is why the BUILD records the names into
  // the static manifest and this reads them back.
  for (const route of input.routes) {
    const skills = route.skills
    if (!skills || skills.length === 0) continue
    violations.push({
      // Re-sorted even though `discoverSkillDirs` already sorts: `route.skills`
      // here can come from a hand-composed manifest fed straight to this
      // function, which carries no guarantee of that order. This does not
      // contradict discoverSkillDirs's "every consumer sees the same order"
      // comment — it is a defensive re-sort for inputs that never went through
      // that function at all.
      capability: `skills (${[...skills].sort().join(", ")})`,
      source: `the skills/ directory of route "${route.routeId}", recorded in the static module manifest at build time`,
      reason:
        "skill bodies are read from disk when the route loads, and this runtime has no filesystem " +
        "to read them from — the skills would vanish from the prompt with no error at all",
      remedy:
        "Inline the instructions into the route's `systemPrompt`, or serve them from a tool that fetches them",
    })
  }

  return violations
}
