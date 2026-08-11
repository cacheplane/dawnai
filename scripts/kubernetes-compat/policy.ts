import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

export interface CompatibilityPolicy {
  readonly schemaVersion: 1
  readonly toolchain: {
    readonly node: string
    readonly pnpm: string
    readonly helm: string
    readonly kind: string
    readonly kubectl: string
  }
  readonly targets: readonly {
    readonly role: "lower" | "canonical" | "upper"
    readonly minor: string
    readonly version: string
    readonly nodeImage: string
  }[]
  readonly calico: {
    readonly manifestUrl: string
    readonly sha256: string
    readonly images: readonly {
      readonly source: string
      readonly occurrences: number
      readonly target: string
    }[]
  }
  readonly images: {
    readonly sandboxWorkload: string
    readonly packagedAppBase: string
    readonly placeholderApp: string
    readonly reachabilityProbe: string
    readonly admissionProbe: string
    readonly reaper: string
  }
}

type JsonObject = Readonly<Record<string, unknown>>

interface VersionCoordinates {
  readonly major: number
  readonly minor: number
}

interface DigestPinnedImage {
  readonly name: string
  readonly value: string
}

const DEFAULT_POLICY_PATH = fileURLToPath(
  new URL("../../.github/kubernetes-compatibility.json", import.meta.url),
)
const TARGET_ROLES = ["lower", "canonical", "upper"] as const
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const DIGEST_PINNED_IMAGE_PATTERN = /^([^\s@]+)@sha256:[0-9a-f]{64}$/
const SEMANTIC_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const V_PREFIXED_SEMANTIC_VERSION_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MINOR_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function fail(path: string, message: string): never {
  throw new Error(`Invalid Kubernetes compatibility policy at ${path}: ${message}`)
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function expectObject(value: unknown, path: string): JsonObject {
  if (!isJsonObject(value)) {
    fail(path, "must be an object")
  }
  return value
}

function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "must be a non-empty string")
  }
  return value
}

function expectPattern(value: unknown, path: string, pattern: RegExp, description: string): string {
  const text = expectNonEmptyString(value, path)
  if (!pattern.test(text)) {
    fail(path, description)
  }
  return text
}

function parseSafeInteger(component: string, path: string): number {
  const parsed = Number(component)
  if (!Number.isSafeInteger(parsed)) {
    fail(path, "numeric components must be safe integers")
  }
  return parsed
}

function parseVersion(
  value: unknown,
  path: string,
  requiresVPrefix: boolean,
): { readonly value: string } & VersionCoordinates {
  const version = expectNonEmptyString(value, path)
  const pattern = requiresVPrefix ? V_PREFIXED_SEMANTIC_VERSION_PATTERN : SEMANTIC_VERSION_PATTERN
  const match = pattern.exec(version)
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    fail(
      path,
      requiresVPrefix
        ? "must be a canonical v-prefixed semantic version"
        : "must be a canonical semantic version",
    )
  }
  const major = parseSafeInteger(match[1], path)
  const minor = parseSafeInteger(match[2], path)
  parseSafeInteger(match[3], path)
  return {
    value: version,
    major,
    minor,
  }
}

function parseMinor(value: unknown, path: string): { readonly value: string } & VersionCoordinates {
  const minor = expectNonEmptyString(value, path)
  const match = MINOR_VERSION_PATTERN.exec(minor)
  if (match?.[1] === undefined || match[2] === undefined) {
    fail(path, "must use canonical major.minor format")
  }
  return {
    value: minor,
    major: parseSafeInteger(match[1], path),
    minor: parseSafeInteger(match[2], path),
  }
}

function parseDigestPinnedImage(value: unknown, path: string): DigestPinnedImage {
  const image = expectNonEmptyString(value, path)
  const match = DIGEST_PINNED_IMAGE_PATTERN.exec(image)
  if (match?.[1] === undefined) {
    fail(
      path,
      "must contain one non-whitespace image name and one @sha256: followed by exactly 64 lowercase hexadecimal characters",
    )
  }
  return { name: match[1], value: image }
}

function expectDigestPinnedImage(value: unknown, path: string): string {
  return parseDigestPinnedImage(value, path).value
}

function validateToolchain(value: unknown): CompatibilityPolicy["toolchain"] {
  const toolchain = expectObject(value, "toolchain")
  const node = parseVersion(toolchain.node, "toolchain.node", false).value
  const pnpm = parseVersion(toolchain.pnpm, "toolchain.pnpm", false).value
  const helm = parseVersion(toolchain.helm, "toolchain.helm", true).value
  const kind = parseVersion(toolchain.kind, "toolchain.kind", true).value
  const kubectl = parseVersion(toolchain.kubectl, "toolchain.kubectl", true).value

  return { node, pnpm, helm, kind, kubectl }
}

function validateTarget(
  value: unknown,
  index: number,
  expectedRole: (typeof TARGET_ROLES)[number],
): CompatibilityPolicy["targets"][number] {
  const path = `targets[${index}]`
  const target = expectObject(value, path)
  const role = expectNonEmptyString(target.role, `${path}.role`)
  if (role !== expectedRole) {
    fail(`${path}.role`, `must equal "${expectedRole}"`)
  }

  const minor = parseMinor(target.minor, `${path}.minor`)
  const version = parseVersion(target.version, `${path}.version`, false)
  if (minor.major !== version.major || minor.minor !== version.minor) {
    fail(`${path}.version`, `must belong to target minor ${minor.value}`)
  }

  const nodeImage = parseDigestPinnedImage(target.nodeImage, `${path}.nodeImage`)
  if (nodeImage.name !== `kindest/node:v${version.value}`) {
    fail(`${path}.nodeImage`, `must pin kindest/node:v${version.value}`)
  }

  return {
    role: expectedRole,
    minor: minor.value,
    version: version.value,
    nodeImage: nodeImage.value,
  }
}

function validateTargets(value: unknown): CompatibilityPolicy["targets"] {
  if (!Array.isArray(value)) {
    fail("targets", "must be an array")
  }
  if (value.length !== TARGET_ROLES.length) {
    fail("targets", `must contain exactly ${TARGET_ROLES.length} entries`)
  }

  const targets = value.map((target, index) => {
    const expectedRole = TARGET_ROLES[index]
    if (expectedRole === undefined) {
      fail(`targets[${index}]`, "has no supported role")
    }
    return validateTarget(target, index, expectedRole)
  })

  const observedMinors = new Set<string>()
  for (const [index, target] of targets.entries()) {
    if (observedMinors.has(target.minor)) {
      fail(`targets[${index}].minor`, `duplicates target minor ${target.minor}`)
    }
    observedMinors.add(target.minor)
  }

  return targets
}

function validateCalico(value: unknown): CompatibilityPolicy["calico"] {
  const calico = expectObject(value, "calico")
  const manifestUrl = expectPattern(
    calico.manifestUrl,
    "calico.manifestUrl",
    /^https:\/\/\S+$/,
    "must be an HTTPS URL",
  )
  const sha256 = expectPattern(
    calico.sha256,
    "calico.sha256",
    SHA256_PATTERN,
    "must contain exactly 64 lowercase hexadecimal characters",
  )

  if (!Array.isArray(calico.images)) {
    fail("calico.images", "must be an array")
  }
  if (calico.images.length === 0) {
    fail("calico.images", "must contain at least one image")
  }

  const images = calico.images.map((value, index) => {
    const path = `calico.images[${index}]`
    const image = expectObject(value, path)
    const source = expectNonEmptyString(image.source, `${path}.source`)
    const occurrences = image.occurrences
    if (!Number.isInteger(occurrences) || typeof occurrences !== "number" || occurrences <= 0) {
      fail(`${path}.occurrences`, "must be a positive integer")
    }
    const target = parseDigestPinnedImage(image.target, `${path}.target`)
    if (target.name !== source) {
      fail(`${path}.target`, "must pin the corresponding source image")
    }
    return { source, occurrences, target: target.value }
  })

  return { manifestUrl, sha256, images }
}

function validateImages(value: unknown): CompatibilityPolicy["images"] {
  const images = expectObject(value, "images")
  return {
    sandboxWorkload: expectDigestPinnedImage(images.sandboxWorkload, "images.sandboxWorkload"),
    packagedAppBase: expectDigestPinnedImage(images.packagedAppBase, "images.packagedAppBase"),
    placeholderApp: expectDigestPinnedImage(images.placeholderApp, "images.placeholderApp"),
    reachabilityProbe: expectDigestPinnedImage(
      images.reachabilityProbe,
      "images.reachabilityProbe",
    ),
    admissionProbe: expectDigestPinnedImage(images.admissionProbe, "images.admissionProbe"),
    reaper: expectDigestPinnedImage(images.reaper, "images.reaper"),
  }
}

function parseReaperVersion(image: string): VersionCoordinates {
  const imageName = parseDigestPinnedImage(image, "images.reaper").name
  const tagSeparator = imageName.lastIndexOf(":")
  if (tagSeparator === -1) {
    fail("images.reaper", "must use a semantic kubectl image tag")
  }
  return parseVersion(imageName.slice(tagSeparator + 1), "images.reaper", false)
}

function assertWithinOneMinor(
  version: VersionCoordinates,
  targets: CompatibilityPolicy["targets"],
  path: string,
): void {
  for (const target of targets) {
    const targetMinor = parseMinor(target.minor, `${path}.target`)
    if (version.major !== targetMinor.major || Math.abs(version.minor - targetMinor.minor) > 1) {
      fail(path, `must be within one minor of target ${target.minor}`)
    }
  }
}

function freezeCompatibilityPolicy(policy: CompatibilityPolicy): CompatibilityPolicy {
  Object.freeze(policy.toolchain)
  for (const target of policy.targets) {
    Object.freeze(target)
  }
  Object.freeze(policy.targets)
  for (const image of policy.calico.images) {
    Object.freeze(image)
  }
  Object.freeze(policy.calico.images)
  Object.freeze(policy.calico)
  Object.freeze(policy.images)
  return Object.freeze(policy)
}

export function validateCompatibilityPolicy(raw: unknown): CompatibilityPolicy {
  const policy = expectObject(raw, "$")
  if (policy.schemaVersion !== 1) {
    fail("schemaVersion", "must equal 1")
  }

  const toolchain = validateToolchain(policy.toolchain)
  const targets = validateTargets(policy.targets)
  const calico = validateCalico(policy.calico)
  const images = validateImages(policy.images)

  assertWithinOneMinor(
    parseVersion(toolchain.kubectl, "toolchain.kubectl", true),
    targets,
    "toolchain.kubectl",
  )
  assertWithinOneMinor(parseReaperVersion(images.reaper), targets, "images.reaper")

  return freezeCompatibilityPolicy({ schemaVersion: 1, toolchain, targets, calico, images })
}

export async function loadCompatibilityPolicy(
  policyPath: string = DEFAULT_POLICY_PATH,
): Promise<CompatibilityPolicy> {
  let contents: string
  try {
    contents = await readFile(policyPath, "utf8")
  } catch (cause) {
    throw new Error(`Failed to read Kubernetes compatibility policy at ${policyPath}`, { cause })
  }

  let raw: unknown
  try {
    raw = JSON.parse(contents)
  } catch (cause) {
    throw new Error(`Failed to parse Kubernetes compatibility policy JSON at ${policyPath}`, {
      cause,
    })
  }
  return validateCompatibilityPolicy(raw)
}

export function getTargetByMinor(
  policy: CompatibilityPolicy,
  minor: string,
): CompatibilityPolicy["targets"][number] {
  const target = policy.targets.find((candidate) => candidate.minor === minor)
  if (target === undefined) {
    throw new Error(`Kubernetes compatibility policy targets do not include minor "${minor}"`)
  }
  return target
}
