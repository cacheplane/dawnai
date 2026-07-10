import type { RouteManifest } from "@dawn-ai/core"
import type { CommandIo } from "../../output.js"
import { langsmithTarget } from "./langsmith.js"
import { nodeTarget } from "./node.js"

/**
 * Everything a build target needs to emit its artifacts. These are the real
 * objects `build.ts` already computes after the shared typegen pre-step — the
 * discovered route manifest and the resolved build output directory — passed
 * through unreshaped.
 */
export interface BuildEmitContext {
  /** Absolute path to the Dawn app root. */
  readonly appRoot: string
  /** Absolute path to the build output directory (`<appRoot>/.dawn/build`). */
  readonly buildDir: string
  /** The discovered route manifest (routes + appRoot). */
  readonly manifest: RouteManifest
  /** Command IO for emitting warnings/notices during emit (optional). */
  readonly io?: CommandIo
}

/**
 * A pluggable `dawn build` output target. Each target emits one flavor of
 * deployment artifact (a Node/Docker bundle, a LangSmith config, …) and
 * returns the absolute paths it wrote.
 */
export interface BuildTarget {
  /** Unique target name, referenced from `config.build.targets`. */
  readonly name: string
  /** Emit this target's artifacts. Returns the absolute paths written. */
  emit(ctx: BuildEmitContext): Promise<{ readonly artifacts: string[] }>
}

/** Registry of known build targets, keyed by name. */
export const buildTargets: Readonly<Record<string, BuildTarget>> = {
  [nodeTarget.name]: nodeTarget,
  [langsmithTarget.name]: langsmithTarget,
}

/** Default targets emitted when `config.build.targets` is not set. */
export const DEFAULT_BUILD_TARGETS: readonly string[] = ["node", "langsmith"]

/** All known target names (for validation / error messages). */
export function knownTargetNames(): string[] {
  return Object.keys(buildTargets)
}
