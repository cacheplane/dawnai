// Private to one controller call. Only verified payload strings are retained;
// every caller still observes metadata and reruns its own byte/proof validation.
import { createHash } from "node:crypto"
import { types } from "node:util"
import { RECOVERY_RETRY, recoveryMethods } from "./policy.mjs"

const MAX_ENTRIES = 128
// Account for two bytes per base64 character, not only decoded payload length.
const MAX_RETAINED_BYTES = 64 * 1024 * 1024
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024
const hash = (bytes, algorithm) => createHash(algorithm).update(bytes).digest("hex")
function copy(source) {
  if (
    !source ||
    typeof source !== "object" ||
    types.isProxy(source) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(source))
  )
    throw new TypeError("Safe payload dependency container required")
  const result = {}
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
    if (!Object.hasOwn(descriptor, "value"))
      throw new TypeError("Safe payload dependency data required")
    result[name] = descriptor.value
  }
  return result
}
export async function withRecoveryPayloadReuse(dependencies, operation) {
  dependencies = copy(dependencies)
  const observation = copy(dependencies.observation)
  const { now } = recoveryMethods(dependencies.authority, ["now"])
  let previous = now()
  const deadline = previous + RECOVERY_RETRY.phaseDeadlineMs
  if (!Number.isSafeInteger(previous) || previous < 0 || !Number.isSafeInteger(deadline))
    throw new TypeError("Bounded recovery payload clock required")
  const entries = new Map()
  let retainedBytes = 0,
    closed = false
  const active = () => {
    const at = now()
    if (closed || !Number.isSafeInteger(at) || at < 0 || at < previous || at >= deadline) {
      closed = true
      entries.clear()
      retainedBytes = 0
      throw new Error("Recovery payload invocation closed or deadline expired")
    }
    previous = at
    return at
  }
  const download = async (source, method, args, options) => {
    const at = active()
    const actions = method === "downloadActionsArtifact"
    const npm = method === "downloadRegistryTarball"
    const unexpired = (at) => {
      if (
        actions &&
        (args.expired === true ||
          (args.expiresAt != null &&
            (!Number.isFinite(Date.parse(args.expiresAt)) || Date.parse(args.expiresAt) <= at)))
      )
        throw new Error("Recovery Actions payload expired")
    }
    unexpired(at)
    const identity = npm ? args.tarballUrl : actions ? args.artifactId : args.assetId
    const bound =
      typeof identity === "string" &&
      identity.length <= 2048 &&
      Number.isSafeInteger(args.maximumBytes) &&
      args.maximumBytes > 0 &&
      args.maximumBytes <= MAX_PAYLOAD_BYTES &&
      /^[a-f0-9]{64}$/u.test(args.sha256 ?? "") &&
      (!actions || args.expired === false) &&
      (!npm ||
        (/^[a-f0-9]{128}$/u.test(args.sha512 ?? "") &&
          /^[a-f0-9]{40}$/u.test(args.shasum ?? "") &&
          typeof args.integrity === "string" &&
          args.integrity.length <= 256))
    const key = bound
      ? JSON.stringify([
          method,
          identity,
          args.maximumBytes,
          args.sha256,
          ...(actions ? [args.expired, args.expiresAt ?? null] : []),
          ...(npm ? [args.sha512, args.shasum, args.integrity] : []),
        ])
      : null
    const validate = (encoded) => {
      if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_PAYLOAD_BYTES / 3) * 4)
        return null
      const bytes = Buffer.from(encoded, "base64")
      if (
        bytes.toString("base64") !== encoded ||
        bytes.length !== args.maximumBytes ||
        hash(bytes, "sha256") !== args.sha256
      )
        return null
      if (
        npm &&
        (hash(bytes, "sha512") !== args.sha512 ||
          hash(bytes, "sha1") !== args.shasum ||
          `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== args.integrity)
      )
        return null
      return bytes
    }
    const cached = key === null ? undefined : entries.get(key)
    if (cached !== undefined) {
      const bytes = validate(cached)
      if (bytes) {
        entries.delete(key)
        entries.set(key, cached)
        const response = npm
          ? {
              status: "PRESENT",
              tarball: {
                url: identity,
                size: bytes.length,
                contentBase64: cached,
                sha1: hash(bytes, "sha1"),
                sha256: hash(bytes, "sha256"),
                sha512: hash(bytes, "sha512"),
              },
            }
          : { status: "PRESENT", contentBase64: cached }
        unexpired(active())
        return response
      }
      retainedBytes -= cached.length * 2
      entries.delete(key)
    }
    const result = await recoveryMethods(source, [method])[method](args, options)
    unexpired(active())
    const encoded = npm ? result.tarball?.contentBase64 : result.contentBase64
    const payload = npm ? result.tarball : null
    const verified =
      key !== null &&
      result.status === "PRESENT" &&
      validate(encoded) &&
      (!npm ||
        (payload.url === identity &&
          payload.size === args.maximumBytes &&
          payload.sha256 === args.sha256 &&
          payload.sha512 === args.sha512 &&
          payload.sha1 === args.shasum))
    unexpired(active())
    if (verified) {
      // Replace concurrent successful completion without double-counting. No
      // promises, response envelopes, metadata, or verifier decisions are cached.
      const previous = entries.get(key)
      if (previous !== undefined) {
        entries.delete(key)
        retainedBytes -= previous.length * 2
      }
      while (
        entries.size >= MAX_ENTRIES ||
        retainedBytes + encoded.length * 2 > MAX_RETAINED_BYTES
      ) {
        const oldest = entries.keys().next().value
        retainedBytes -= entries.get(oldest).length * 2
        entries.delete(oldest)
      }
      entries.set(key, encoded)
      retainedBytes += encoded.length * 2
    }
    return result
  }
  const wrap = (source, methods) => {
    const wrapped = copy(source)
    for (const method of methods)
      wrapped[method] = (args, options) => download(source, method, args, options)
    return wrapped
  }
  observation.github = wrap(observation.github, ["downloadReleaseAsset", "downloadActionsArtifact"])
  observation.npm = wrap(observation.npm, ["downloadRegistryTarball"])
  try {
    // fetchImpl remains the exact original function: the writer's cross-instance
    // unsettled-work WeakMap must retain its stable transport identity.
    return await operation({ ...dependencies, observation })
  } finally {
    closed = true
    entries.clear()
    retainedBytes = 0
  }
}
