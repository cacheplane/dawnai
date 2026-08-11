/**
 * The node-only half of middleware loading: the disk probe and the dynamic
 * import.
 *
 * It lives here rather than in `middleware.ts` because that module is on the
 * fetch/edge graph — `runtime-fetch-core.ts` imports `runMiddleware` and
 * `headersToRecord` from it — and `test/fetch-entry-purity.test.ts` links that
 * graph for `platform: "browser"` with `node:*` NOT external. A runtime
 * `node:fs`/`node:url` import there is an unresolvable specifier and the
 * bundle fails. Same pure/node split as `thread-access.ts` /
 * `thread-access-node.ts`.
 */

import { lstatSync } from "node:fs"
import { pathToFileURL } from "node:url"
import type { DawnMiddleware } from "@dawn-ai/sdk"

import { diagnose } from "../diagnostics.js"
import { CliError } from "../output.js"
import { middlewareCandidatePaths, selectMiddlewareExport } from "./middleware.js"

/** The syscall the existence probe is built on. A seam so tests can force an errno. */
type StatPath = (path: string) => void

export interface LoadMiddlewareOptions {
  /**
   * Override the `lstat` the probe uses. Test seam only: `chmod` is a no-op on
   * Windows and root ignores the mode bits, so the errno branches below cannot
   * be covered portably by a real filesystem.
   */
  readonly statPath?: StatPath
  /**
   * Override the dynamic import. Test seam only, so a test can assert WHAT
   * specifier the loader builds: the Windows defect this guards against is a
   * raw path reaching `import()`, and no POSIX test can observe that from the
   * outcome alone.
   */
  readonly importModule?: (href: string) => Promise<unknown>
}

function errnoOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined
}

/**
 * Does a directory entry exist at this path?
 *
 * NOT `existsSync`, which answers `false` for EVERY error — an unreadable
 * parent directory, an EACCES, an EPERM, an EIO or an ELOOP all read as "no
 * file", which is the same fail-open this module exists to close, one layer up
 * from the import.
 *
 * Only the two errnos that genuinely mean "nothing is there" are absence:
 * ENOENT (no such entry) and ENOTDIR (a path component is a file). Anything
 * else means the filesystem could not answer, which is not the same as "no".
 *
 * `lstat`, not `stat`, so a DANGLING SYMLINK counts as present: the entry is
 * there and is an unambiguous statement of intent, so it must reach the import
 * and fail loudly rather than vanish into ENOENT.
 */
function candidateExists(path: string, statPath: StatPath): boolean {
  try {
    statPath(path)
    return true
  } catch (error) {
    const errno = errnoOf(error)
    if (errno === "ENOENT" || errno === "ENOTDIR") return false
    throw new CliError(
      `Middleware at ${path} could not be probed (${errno ?? "unknown error"}), so Dawn cannot ` +
        "tell whether this app has middleware and will not start ungated. " +
        `Fix the path's permissions, or delete it if this app has no middleware.\n\n${String(error)}`,
      1,
      { cause: error, code: "DAWN_E3004" },
    )
  }
}

/**
 * The first candidate that EXISTS, or undefined when every one of them is
 * definitively absent.
 *
 * Shared with the build targets (`nodeTarget.emit`, `emitWebRuntimeArtifacts`)
 * so the static build resolves the same file, by the same rule, that the
 * dynamic probe does. Those two used `existsSync`; had they kept it, an
 * app whose middleware file is present but unprobeable would fail `dawn dev`
 * and still build an artifact with no middleware in it — the fail-open moved
 * rather than fixed.
 */
export function findMiddlewareFile(
  appRoot: string,
  statPath: StatPath = lstatSync,
): string | undefined {
  return middlewareCandidatePaths(appRoot).find((candidate) => candidateExists(candidate, statPath))
}

/**
 * Load middleware from the app's `middleware.ts`.
 *
 * Existence is decided BEFORE the import, so an import failure can only ever
 * mean "the middleware is broken":
 *
 *   • every candidate definitively absent      -> undefined (no gate; unchanged)
 *   • a candidate cannot be probed at all      -> THROW (DAWN_E3004)
 *   • the first existing candidate won't import-> THROW (DAWN_E3004)
 *   • it imports but binds no function         -> undefined, with a warning
 *
 * The bare `catch {}` this replaces conflated the first two lines with the
 * third. A `src/middleware.ts` that throws at module init — a missing env var,
 * an ESM/CJS interop break, a typo in a deploy — was indistinguishable from an
 * app with no middleware at all: the server started, reported healthy, and
 * served every gated Agent Protocol endpoint ungated with no log line
 * anywhere.
 *
 * It also swallowed the Windows defect below, and it FELL THROUGH: a broken
 * `src/middleware.ts` with a working root `middleware.ts` beside it silently
 * bound the wrong file. The first existing candidate is now the only candidate.
 *
 * "Imports but binds nothing" stays non-fatal on purpose. `selectMiddlewareExport`
 * is the ONE selection rule, shared with the static manifest's
 * `normalizeMiddlewareModule`, and the built app has no way to fail there — the
 * manifest just carries `middleware: undefined`. Throwing only on the dynamic
 * side would make dev and the built artifact bind differently, which is the
 * exact divergence that rule exists to prevent. The warning is what keeps it
 * from being silent.
 */
export async function loadMiddleware(
  appRoot: string,
  options?: LoadMiddlewareOptions,
): Promise<DawnMiddleware | undefined> {
  const path = findMiddlewareFile(appRoot, options?.statPath ?? lstatSync)
  if (!path) return undefined

  let mod: unknown
  try {
    // `pathToFileURL`, never the raw path — a filesystem path is not a module
    // specifier. On Windows the candidate is `C:\app/src/middleware.ts` and
    // Node refuses it with ERR_UNSUPPORTED_ESM_URL_SCHEME ("Received protocol
    // 'c:'"), which the old `catch {}` swallowed, so middleware never ran on
    // Windows at all. Every other dynamic import in this package already
    // builds a `file://` href; this was the lone exception.
    const href = pathToFileURL(path).href
    mod = options?.importModule ? await options.importModule(href) : await import(href)
  } catch (error) {
    const diag = diagnose(error, { appRoot })
    const detail = diag ? `${diag.summary}\n\n${diag.hint}` : String(error)
    throw new CliError(
      `Middleware at ${path} failed to import, so every endpoint it gates would run ungated. ` +
        `Fix the file, or delete it if this app has no middleware.\n\n${detail}`,
      1,
      { cause: error, code: "DAWN_E3004" },
    )
  }

  const selected = selectMiddlewareExport(mod)
  if (!selected) {
    console.warn(
      `Dawn: ${path} exists but exports no middleware function, so it is being ignored and every ` +
        "endpoint it would gate runs ungated. Export it with " +
        "`export default defineMiddleware(async (req) => { … })`.",
    )
    return undefined
  }
  return selected
}
