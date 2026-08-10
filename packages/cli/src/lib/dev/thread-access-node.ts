import { existsSync } from "node:fs"
import type { ThreadAccessPolicy } from "@dawn-ai/sdk"

import { diagnose } from "../diagnostics.js"
import { CliError } from "../output.js"
import {
  selectThreadAccessExport,
  threadAccessCandidatePaths,
  validateThreadAccessPolicy,
} from "./thread-access.js"

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
 * Existence is decided by `existsSync`, BEFORE the import, so an import failure
 * can only ever mean "the policy is broken":
 *
 *   • no candidate on disk                     -> undefined (no gate; today's behavior)
 *   • first existing candidate fails to import -> THROW (DAWN_E3003)
 *   • it imports but binds no valid policy     -> THROW (DAWN_E3003)
 *
 * The "binds nothing" case also diverges from middleware, which ignores such a
 * file. A `thread-access.ts` on disk is an unambiguous statement of intent;
 * binding nothing is never what the author meant.
 */
export async function loadThreadAccess(appRoot: string): Promise<ThreadAccessPolicy | undefined> {
  const path = threadAccessCandidatePaths(appRoot).find((candidate) => existsSync(candidate))
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
