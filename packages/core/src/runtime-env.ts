/**
 * Portable environment-variable access for code that must link and RUN on both
 * Node and web-standard runtimes (workerd, Deno Deploy, a browser).
 *
 * ## Why this exists
 *
 * `@dawn-ai/cli/fetch` is bundled for Cloudflare workerd with ZERO `node:`
 * specifiers, which is precisely why the emitted `wrangler.toml` omits
 * `nodejs_compat`. Without that flag `process` is not defined at all, so a bare
 * `process.env.X` is a `ReferenceError` the moment the line evaluates — not a
 * quiet `undefined`. The failure is a hard crash on the first turn, and the
 * `node:`-import gate cannot see it: a bare global has no import edge.
 *
 * ## The two shapes of the problem
 *
 * Debug flags (`DAWN_DEBUG_*`) only need to be OFF where there is no `process`.
 * A configuration knob is different: `OPENAI_BASE_URL` points the model layer
 * at a proxy or a local aimock, so merely guarding it would trade a crash for
 * something worse — a runtime where the knob silently cannot be set. This
 * module serves both: it reads `process.env` when there is a `process`, and
 * otherwise falls back to values an edge entry point seeded at boot.
 *
 * ## Precedence
 *
 * `process.env` is consulted FIRST and wins whenever it holds a defined value
 * (including the empty string, exactly as a direct read would). The seeded map
 * is a fallback only. On Node with nothing seeded — every existing code path —
 * `readRuntimeEnv(name)` is therefore observationally identical to
 * `process.env[name]`.
 *
 * ## Why `globalThis.process` and never a bare `process`
 *
 * A bare `process` identifier throws on a runtime that lacks it; a property
 * read off `globalThis` (which every target defines) yields `undefined`
 * instead. It also lets `test/fetch-entry-purity.test.ts` enforce a
 * zero-tolerance rule on Dawn-owned code: NO bare Node-only global may survive
 * into the edge bundle, guarded or not. Route env reads through here rather
 * than hand-rolling a `typeof process` guard at the call site, or that gate
 * will fail.
 */

/** A read-only view of environment variables. */
export type RuntimeEnv = Readonly<Record<string, string | undefined>>

interface GlobalWithProcess {
  readonly process?: { readonly env?: RuntimeEnv }
}

let seededEnv: RuntimeEnv | undefined

/**
 * Install the process-wide fallback environment. Last call wins.
 *
 * Seeded, not injected, for the same reason `seedDawnConfig` and
 * `seedModelImporter` are: the readers sit far below route execution and
 * threading a value down to them would touch every layer in between. Called by
 * a build-emitted edge entry point, which is the only place that knows the
 * deployment's bindings; never called on a Node path.
 */
export function seedRuntimeEnv(env: RuntimeEnv): void {
  // Copied so a later mutation of the caller's object cannot change what the
  // runtime observes mid-flight.
  seededEnv = { ...env }
}

/** Drop the seeded fallback. Exported for tests; not part of the runtime flow. */
export function __clearSeededRuntimeEnvForTests(): void {
  seededEnv = undefined
}

/**
 * Read an environment variable, preferring the real `process.env` and falling
 * back to whatever `seedRuntimeEnv` installed. Returns `undefined` when neither
 * source has it — the same answer `process.env[name]` gives for an unset name.
 */
export function readRuntimeEnv(name: string): string | undefined {
  const fromProcess = (globalThis as GlobalWithProcess).process?.env?.[name]
  if (fromProcess !== undefined) return fromProcess
  return seededEnv?.[name]
}
