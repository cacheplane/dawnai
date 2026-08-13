import { findThreadAccessFile } from "../../dev/thread-access-node.js"
import { CliError } from "../../output.js"

/**
 * Fail a build for a target that cannot carry the app's thread access policy.
 *
 * Middleware failing open on these targets is a feature regression; an
 * authorization policy failing open is a breach, so the build refuses rather
 * than emitting artifacts that would deploy every thread endpoint ungated.
 *
 * `langsmith` is the only remaining caller, and permanently so: it materializes
 * per-route graphs and no app middleware, so there is nowhere for the hook to
 * run. The web targets used to share this refusal; they now carry the policy in
 * their static module manifest (`normalizeThreadAccessModule`), resolved
 * through the same `findThreadAccessFile` this uses.
 *
 * That shared resolution is the point: it is the dynamic loader's candidate
 * list AND its `lstat` hardening, so the build can never disagree with dev
 * about whether a policy exists — and a policy file that is present but
 * unprobeable raises rather than reading as "no policy" and letting this
 * refusal quietly not fire.
 */
export function assertNoThreadAccessPolicy(appRoot: string, target: string): void {
  const found = findThreadAccessFile(appRoot)
  if (!found) return
  throw new CliError(
    `The "${target}" build target cannot carry a thread access policy, and ${found} exists. ` +
      "Building it anyway would deploy every thread endpoint ungated. Remove the policy file, " +
      'or build for the "node" target, which probes it at boot.',
    1,
    { code: "DAWN_E1005" },
  )
}
