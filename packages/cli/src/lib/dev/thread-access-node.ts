import { lstatSync } from "node:fs"
import type { ThreadAccessPolicy } from "@dawn-ai/sdk"

import { diagnose } from "../diagnostics.js"
import { CliError } from "../output.js"
import {
  selectThreadAccessExport,
  threadAccessCandidatePaths,
  validateThreadAccessPolicy,
} from "./thread-access.js"

/** The syscall the existence probe is built on. A seam so tests can force an errno. */
type StatPath = (path: string) => void

export interface LoadThreadAccessOptions {
  /**
   * Override the `lstat` the probe uses. Test seam only: `chmod` is a no-op on
   * Windows and root ignores the mode bits, so the errno branches below cannot
   * be covered portably by a real filesystem.
   */
  readonly statPath?: StatPath
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
 * file". For middleware that is a shrug; for an authorization policy it is the
 * silent total bypass this loader exists to prevent, one layer up from the
 * `catch {}`: the app boots with every thread endpoint open and logs that it
 * found no policy.
 *
 * Only the two errnos that genuinely mean "nothing is there" are absence:
 * ENOENT (no such entry) and ENOTDIR (a path component is a file). Anything
 * else means the filesystem could not answer, which is not the same as "no",
 * and fails the boot.
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
      `Thread access policy at ${path} could not be probed (${errno ?? "unknown error"}), so Dawn ` +
        "cannot tell whether this app has a policy and will not boot ungated. " +
        `Fix the path's permissions, or delete it if this app has no policy.\n\n${String(error)}`,
      1,
      { cause: error, code: "DAWN_E3003" },
    )
  }
}

/**
 * Load the app's thread-access policy.
 *
 * This deliberately does NOT copy `loadMiddleware` (`./middleware.ts`), which
 * wraps every dynamic import in a bare `catch {}` and therefore cannot tell "no
 * file" from "file that threw". For middleware that is merely sloppy; for an
 * authorization policy it is a silent, total bypass — a syntax error, a missing
 * dependency, or a thrown env assertion in production would boot the app with
 * every thread world-writable and no log line.
 *
 * Existence is decided BEFORE the import (see `candidateExists`), so an import
 * failure can only ever mean "the policy is broken":
 *
 *   • every candidate definitively absent      -> undefined (no gate; today's behavior)
 *   • a candidate cannot be probed at all      -> THROW (DAWN_E3003)
 *   • first existing candidate fails to import -> THROW (DAWN_E3003)
 *   • it imports but binds no valid policy     -> THROW (DAWN_E3003)
 *
 * The "binds nothing" case also diverges from middleware, which ignores such a
 * file. A `thread-access.ts` on disk is an unambiguous statement of intent;
 * binding nothing is never what the author meant.
 */
export async function loadThreadAccess(
  appRoot: string,
  options?: LoadThreadAccessOptions,
): Promise<ThreadAccessPolicy | undefined> {
  const statPath = options?.statPath ?? lstatSync
  const path = threadAccessCandidatePaths(appRoot).find((candidate) =>
    candidateExists(candidate, statPath),
  )
  if (!path) return undefined

  let mod: unknown
  try {
    mod = await import(path)
  } catch (error) {
    const diag = diagnose(error, { appRoot })
    const detail = diag ? `${diag.summary}\n\n${diag.hint}` : String(error)
    throw new CliError(
      `Thread access policy at ${path} failed to import, so every thread endpoint would be ungated. ` +
        `Fix the file or delete it.\n\n${detail}`,
      1,
      { cause: error, code: "DAWN_E3003" },
    )
  }

  const selected = selectThreadAccessExport(mod)
  if (selected === undefined || selected === null) {
    throw new CliError(
      `Thread access policy at ${path} has no \`default\` or \`threadAccess\` export. ` +
        "Export the policy with `export default defineThreadAccess({ … })`.",
      1,
      { code: "DAWN_E3003" },
    )
  }

  const reason = validateThreadAccessPolicy(selected)
  if (reason) {
    throw new CliError(`Thread access policy at ${path} is not a valid policy: ${reason}.`, 1, {
      code: "DAWN_E3003",
    })
  }

  return selected as ThreadAccessPolicy
}
