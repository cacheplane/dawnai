/**
 * Thread metadata is one flat, client-writable namespace, echoed verbatim by
 * `GET /threads/:thread_id` and shallow-merged with no compare-and-set — and it
 * already carries an access-control input (`route`). A "hook metadata merged
 * last, hook wins" scheme would be forgery-proof only by ordering luck. The
 * mechanism instead is a reserved sub-namespace, stripped on the way in.
 *
 * Pure: no `node:` imports.
 */

import { THREAD_ACCESS_METADATA_KEY } from "@dawn-ai/sdk"

/**
 * Remove the key Dawn owns from anything a client supplied. Applied on EVERY
 * create path, hook or no hook: the key contains a colon, cannot be written as
 * a JS property identifier, and is namespaced to Dawn, so stripping it always
 * is safe — and it means an app that adopts a policy later cannot inherit
 * forged stamps written before it did.
 *
 * Returns the input object unchanged when there is nothing to strip, so the
 * common path allocates nothing. That path is safe for the same reason the
 * copy below has to work for it: metadata always arrives from `JSON.parse`,
 * which makes `__proto__` an own data property and leaves the prototype alone,
 * so a key the caller did not own is never readable off one of these objects.
 */
export function stripReservedThreadMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined
  if (!Object.hasOwn(metadata, THREAD_ACCESS_METADATA_KEY)) return metadata
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (key === THREAD_ACCESS_METADATA_KEY) continue
    // `defineProperty`, never `rest[key] = value`: an assignment to `__proto__`
    // runs the inherited setter and swaps the prototype instead of adding a
    // property, so a body carrying both the reserved key and a `__proto__`
    // entry would leave `rest[THREAD_ACCESS_METADATA_KEY]` readable through the
    // chain while `Object.hasOwn` reported it stripped. Defining the property
    // reproduces what `JSON.parse` did with that same key.
    Object.defineProperty(rest, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  }
  return rest
}

/**
 * Guard for every `updateMetadata` patch the runtime builds, so a future
 * refactor cannot clobber the stamp through the store's shallow merge. Throws —
 * reaching it is a Dawn bug, not a caller error.
 *
 * Deliberately NOT placed on `ThreadsStore.updateMetadata` itself: that is the
 * store contract, shared with operator tooling that legitimately needs to write
 * the key (the documented backfill script).
 */
export function assertNoReservedKey(patch: Record<string, unknown>): void {
  if (Object.hasOwn(patch, THREAD_ACCESS_METADATA_KEY)) {
    throw new Error(
      `Dawn bug: a runtime thread-metadata patch carried the reserved key "${THREAD_ACCESS_METADATA_KEY}". ` +
        "That key is the server-issued access stamp and may only be written by the create path or by an operator backfill.",
    )
  }
}
