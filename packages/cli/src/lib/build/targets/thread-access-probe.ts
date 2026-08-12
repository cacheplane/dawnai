import { existsSync } from "node:fs"

import { threadAccessCandidatePaths } from "../../dev/thread-access.js"
import { CliError } from "../../output.js"

/**
 * Fail a build for a target that cannot carry the app's thread access policy.
 *
 * Middleware failing open on these targets is a feature regression; an
 * authorization policy failing open is a breach, so the build refuses rather
 * than emitting artifacts that would deploy every thread endpoint ungated.
 *
 * Same candidate list as the dynamic probe, so the build can never disagree
 * with dev about whether a policy exists.
 */
export function assertNoThreadAccessPolicy(appRoot: string, target: string): void {
  const found = threadAccessCandidatePaths(appRoot).find((candidate) => existsSync(candidate))
  if (!found) return
  throw new CliError(
    `The "${target}" build target cannot carry a thread access policy, and ${found} exists. ` +
      "Building it anyway would deploy every thread endpoint ungated. Remove the policy file, " +
      'or build for the "node" target, which probes it at boot.',
    1,
    { code: "DAWN_E1005" },
  )
}
