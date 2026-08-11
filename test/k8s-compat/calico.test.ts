import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import { parseAllDocuments } from "yaml"

import {
  downloadAndPrepareCalico,
  verifyAndRewriteCalico,
} from "../../scripts/kubernetes-compat/calico.ts"
import type { CompatibilityPolicy } from "../../scripts/kubernetes-compat/policy.ts"

const CNI_SOURCE = "quay.io/calico/cni:v3.32.1"
const CONTROLLER_SOURCE = "quay.io/calico/kube-controllers:v3.32.1"
const NODE_SOURCE = "quay.io/calico/node:v3.32.1"
const UNKNOWN_SOURCE = "quay.io/calico/typha:v3.32.1"

const CNI_TARGET = `${CNI_SOURCE}@sha256:${"a".repeat(64)}`
const CONTROLLER_TARGET = `${CONTROLLER_SOURCE}@sha256:${"b".repeat(64)}`
const NODE_TARGET = `${NODE_SOURCE}@sha256:${"c".repeat(64)}`
const UNRELATED_SOURCE_TEXT = `leave this source tag unchanged: ${CNI_SOURCE}`

const EXPECTED_IMAGES = [
  { source: CNI_SOURCE, occurrences: 2, target: CNI_TARGET },
  { source: CONTROLLER_SOURCE, occurrences: 1, target: CONTROLLER_TARGET },
  { source: NODE_SOURCE, occurrences: 2, target: NODE_TARGET },
] as const

interface ManifestImages {
  readonly cni?: readonly string[]
  readonly controllers?: readonly string[]
  readonly node?: readonly string[]
  readonly extra?: readonly string[]
}

function containerList(name: string, images: readonly string[], indentation: string): string {
  if (images.length === 0) {
    return " []"
  }
  return `\n${images
    .map(
      (image, index) =>
        `${indentation}- name: ${name}-${index + 1}\n${indentation}  image: ${image}`,
    )
    .join("\n")}`
}

function syntheticManifest({
  cni = [CNI_SOURCE, CNI_SOURCE],
  controllers = [CONTROLLER_SOURCE],
  node = [NODE_SOURCE, NODE_SOURCE],
  extra = [],
}: ManifestImages = {}): string {
  return `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: calico-node
  annotations:
    image: "${CNI_SOURCE}"
    source-note: "${UNRELATED_SOURCE_TEXT}"
spec:
  template:
    spec:
      initContainers:${containerList("install-cni", cni, "        ")}
      containers:${containerList("calico-node", [node[0] ?? NODE_TARGET], "        ")}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: calico-kube-controllers
spec:
  template:
    spec:
      containers:${containerList("controller", controllers, "        ")}
---
apiVersion: v1
kind: Pod
metadata:
  name: calico-node-bootstrap
spec:
  initContainers:${containerList("node-bootstrap", node.slice(1), "    ")}
  containers:${containerList("extra", extra, "    ")}
`
}

function encode(source: string, withByteOrderMark = false): Uint8Array {
  const encoded = new TextEncoder().encode(source)
  if (!withByteOrderMark) {
    return encoded
  }
  const raw = new Uint8Array(encoded.length + 3)
  raw.set([0xef, 0xbb, 0xbf])
  raw.set(encoded, 3)
  return raw
}

function sha256(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex")
}

function calicoPolicy(
  raw: Uint8Array,
  images: CompatibilityPolicy["calico"]["images"] = EXPECTED_IMAGES,
): CompatibilityPolicy["calico"] {
  return {
    manifestUrl: "https://example.test/calico.yaml",
    sha256: sha256(raw),
    images,
  }
}

function responseWithBytes(raw: Uint8Array): Response {
  return new Response(raw)
}

function parsedValues(source: string): unknown[] {
  const documents = parseAllDocuments(source)
  const errors = documents.flatMap((document) => document.errors)
  expect(errors).toEqual([])
  return documents.map((document) => document.toJS())
}

function asObject(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object")
  expect(value).not.toBeNull()
  expect(Array.isArray(value)).toBe(false)
  return value as Record<string, unknown>
}

function atPath(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value
  for (const segment of path) {
    if (typeof segment === "number") {
      expect(Array.isArray(current)).toBe(true)
      current = (current as unknown[])[segment]
    } else {
      current = asObject(current)[segment]
    }
  }
  return current
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) {
      return error
    }
    throw new Error("Expected rejection to contain an Error")
  }
  throw new Error("Expected promise to reject")
}

afterEach(() => {
  vi.useRealTimers()
})

describe("Calico manifest verification", () => {
  it("hashes untouched bytes and rewrites only exact eligible image fields", () => {
    const raw = encode(syntheticManifest(), true)

    const rewritten = verifyAndRewriteCalico(raw, calicoPolicy(raw))
    const documents = parsedValues(rewritten)

    expect(documents).toHaveLength(3)
    expect(atPath(documents[0], ["spec", "template", "spec", "initContainers"])).toMatchObject([
      { image: CNI_TARGET },
      { image: CNI_TARGET },
    ])
    expect(atPath(documents[0], ["spec", "template", "spec", "containers"])).toMatchObject([
      { image: NODE_TARGET },
    ])
    expect(atPath(documents[1], ["spec", "template", "spec", "containers"])).toMatchObject([
      { image: CONTROLLER_TARGET },
    ])
    expect(atPath(documents[2], ["spec", "initContainers"])).toMatchObject([{ image: NODE_TARGET }])
    expect(atPath(documents[0], ["metadata", "annotations", "image"])).toBe(CNI_SOURCE)
    expect(atPath(documents[0], ["metadata", "annotations", "source-note"])).toBe(
      UNRELATED_SOURCE_TEXT,
    )
  })

  it("checks the raw checksum before attempting to parse YAML", () => {
    const malformed = encode("kind: [unterminated")
    const policy = { ...calicoPolicy(malformed), sha256: "0".repeat(64) }

    expect(() => verifyAndRewriteCalico(malformed, policy)).toThrow(/checksum mismatch/i)
    expect(() => verifyAndRewriteCalico(malformed, policy)).not.toThrow(/YAML document/i)
  })

  it.each([
    ["CNI", CNI_SOURCE, { cni: [CNI_SOURCE] }],
    ["controller", CONTROLLER_SOURCE, { controllers: [] }],
    ["node", NODE_SOURCE, { node: [NODE_SOURCE] }],
  ] as const)("rejects too few %s source occurrences", (_name, source, manifestImages) => {
    const raw = encode(syntheticManifest(manifestImages))

    expect(() => verifyAndRewriteCalico(raw, calicoPolicy(raw))).toThrow(
      new RegExp(`${source.replaceAll("/", "\\/")}.*expected.*observed`, "i"),
    )
  })

  it.each([
    ["CNI", CNI_SOURCE],
    ["controller", CONTROLLER_SOURCE],
    ["node", NODE_SOURCE],
  ] as const)("rejects too many %s source occurrences", (_name, source) => {
    const raw = encode(syntheticManifest({ extra: [source] }))

    expect(() => verifyAndRewriteCalico(raw, calicoPolicy(raw))).toThrow(
      new RegExp(`${source.replaceAll("/", "\\/")}.*expected.*observed`, "i"),
    )
  })

  it("reports every malformed YAML document with document context", () => {
    const raw = encode(`apiVersion: v1
kind: ConfigMap
---
kind:
  bad: [unterminated
---
metadata:
  labels: [also-bad
`)

    expect(() => verifyAndRewriteCalico(raw, calicoPolicy(raw))).toThrow(
      /document 2[\s\S]*document 3/i,
    )
  })

  it("rejects an unknown eligible image left after configured rewrites", () => {
    const raw = encode(syntheticManifest({ extra: [UNKNOWN_SOURCE] }))

    expect(() => verifyAndRewriteCalico(raw, calicoPolicy(raw))).toThrow(
      new RegExp(`unknown.*${UNKNOWN_SOURCE.replaceAll("/", "\\/")}`, "i"),
    )
  })

  it("rejects a configured source image that remains after rewrite", () => {
    const raw = encode(syntheticManifest())
    const images = [
      { ...EXPECTED_IMAGES[0], target: CNI_SOURCE },
      EXPECTED_IMAGES[1],
      EXPECTED_IMAGES[2],
    ]

    expect(() => verifyAndRewriteCalico(raw, calicoPolicy(raw, images))).toThrow(
      new RegExp(`${CNI_SOURCE.replaceAll("/", "\\/")}.*remains.*after rewrite`, "i"),
    )
  })

  it("rejects duplicate source mappings instead of choosing one", () => {
    const raw = encode(syntheticManifest())
    const images = [
      ...EXPECTED_IMAGES,
      { ...EXPECTED_IMAGES[0], target: `${CNI_SOURCE}@sha256:${"d".repeat(64)}` },
    ]

    expect(() => verifyAndRewriteCalico(raw, calicoPolicy(raw, images))).toThrow(
      new RegExp(`duplicate.*${CNI_SOURCE.replaceAll("/", "\\/")}`, "i"),
    )
  })

  it("rejects an eligible source whose expected mapping is missing", () => {
    const raw = encode(syntheticManifest())
    const images = [EXPECTED_IMAGES[0], EXPECTED_IMAGES[2]]

    expect(() => verifyAndRewriteCalico(raw, calicoPolicy(raw, images))).toThrow(
      new RegExp(`unknown.*${CONTROLLER_SOURCE.replaceAll("/", "\\/")}`, "i"),
    )
  })
})

describe("Calico manifest download", () => {
  it("downloads, verifies, and atomically replaces the destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dawn-calico-success-"))
    const outputPath = join(directory, "calico.yaml")
    const raw = encode(syntheticManifest())
    const policy = calicoPolicy(raw)
    const fetchImpl = vi.fn<typeof fetch>(async () => responseWithBytes(raw))

    try {
      await writeFile(outputPath, "existing destination", "utf8")

      await downloadAndPrepareCalico(outputPath, policy, fetchImpl)

      const output = await readFile(outputPath, "utf8")
      expect(parsedValues(output)).toHaveLength(3)
      expect(output).toContain(CNI_TARGET)
      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(fetchImpl).toHaveBeenCalledWith(policy.manifestUrl, {
        signal: expect.any(AbortSignal),
      })
      expect(await readdir(directory)).toEqual(["calico.yaml"])
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it("passes a live abort signal to the injected fetch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dawn-calico-signal-"))
    const outputPath = join(directory, "calico.yaml")
    const raw = encode(syntheticManifest())
    let receivedSignal: AbortSignal | null | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      receivedSignal = init?.signal
      expect(receivedSignal).toBeInstanceOf(AbortSignal)
      expect(receivedSignal?.aborted).toBe(false)
      return responseWithBytes(raw)
    }

    try {
      await downloadAndPrepareCalico(outputPath, calicoPolicy(raw), fetchImpl)

      expect(receivedSignal).toBeInstanceOf(AbortSignal)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it("aborts a stalled download after 30 seconds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dawn-calico-timeout-"))
    const outputPath = join(directory, "calico.yaml")
    const raw = encode(syntheticManifest())
    let receivedSignal: AbortSignal | null | undefined
    const fetchImpl: typeof fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        receivedSignal = init?.signal
        receivedSignal?.addEventListener("abort", () => reject(receivedSignal?.reason), {
          once: true,
        })
      })

    try {
      vi.useFakeTimers()
      const download = downloadAndPrepareCalico(outputPath, calicoPolicy(raw), fetchImpl)
      const rejection = expect(download).rejects.toThrow(/timed out.*30 seconds/i)

      await vi.advanceTimersByTimeAsync(29_999)
      expect(receivedSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(receivedSignal?.aborted).toBe(true)
      await rejection
    } finally {
      vi.useRealTimers()
      await rm(directory, { recursive: true })
    }
  })

  it("rejects non-ok responses with the HTTP status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dawn-calico-status-"))
    const outputPath = join(directory, "calico.yaml")
    const raw = encode(syntheticManifest())
    const fetchImpl: typeof fetch = async () =>
      new Response("unavailable", { status: 503, statusText: "Service Unavailable" })

    try {
      await writeFile(outputPath, "existing destination", "utf8")

      const error = await rejectedError(
        downloadAndPrepareCalico(outputPath, calicoPolicy(raw), fetchImpl),
      )

      expect(error.message).toMatch(/503/)
      await expect(readFile(outputPath, "utf8")).resolves.toBe("existing destination")
      expect(await readdir(directory)).toEqual(["calico.yaml"])
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it("preserves an existing destination when verification fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dawn-calico-verification-"))
    const outputPath = join(directory, "calico.yaml")
    const raw = encode(syntheticManifest())
    const policy = { ...calicoPolicy(raw), sha256: "0".repeat(64) }
    const fetchImpl: typeof fetch = async () => responseWithBytes(raw)

    try {
      await writeFile(outputPath, "existing destination", "utf8")

      await expect(downloadAndPrepareCalico(outputPath, policy, fetchImpl)).rejects.toThrow(
        /checksum mismatch/i,
      )

      await expect(readFile(outputPath, "utf8")).resolves.toBe("existing destination")
      expect(await readdir(directory)).toEqual(["calico.yaml"])
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it("removes its sibling temporary file when the atomic rename fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dawn-calico-cleanup-"))
    const outputPath = join(directory, "calico.yaml")
    const raw = encode(syntheticManifest())
    const fetchImpl: typeof fetch = async () => responseWithBytes(raw)

    try {
      await mkdir(outputPath)

      await expect(
        downloadAndPrepareCalico(outputPath, calicoPolicy(raw), fetchImpl),
      ).rejects.toBeInstanceOf(Error)

      expect((await stat(outputPath)).isDirectory()).toBe(true)
      expect(await readdir(directory)).toEqual(["calico.yaml"])
    } finally {
      await rm(directory, { recursive: true })
    }
  })
})
