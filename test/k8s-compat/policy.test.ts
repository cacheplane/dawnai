import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  getTargetByMinor,
  loadCompatibilityPolicy,
  validateCompatibilityPolicy,
} from "../../scripts/kubernetes-compat/policy.ts"

const approvedPolicy = {
  schemaVersion: 1,
  toolchain: {
    node: "24.17.0",
    pnpm: "10.33.0",
    helm: "v4.2.3",
    kind: "v0.32.0",
    kubectl: "v1.35.6",
  },
  targets: [
    {
      role: "lower",
      minor: "1.34",
      version: "1.34.8",
      nodeImage:
        "kindest/node:v1.34.8@sha256:02722c2dedddcfc00febf5d27fbeb9b7b2c14294c82109ff4a85d89ac9ba3256",
    },
    {
      role: "canonical",
      minor: "1.35",
      version: "1.35.5",
      nodeImage:
        "kindest/node:v1.35.5@sha256:ce977ae6d65918d0b58a5f8b5e940429c2ce42fa3a5619ec2bbc60b949c0ac95",
    },
    {
      role: "upper",
      minor: "1.36",
      version: "1.36.1",
      nodeImage:
        "kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5",
    },
  ],
  calico: {
    manifestUrl:
      "https://raw.githubusercontent.com/projectcalico/calico/v3.32.1/manifests/calico.yaml",
    sha256: "a1df919d9721cf667accdc3e72848911b0cb25cfab7d2478ad0c996302c95744",
    images: [
      {
        source: "quay.io/calico/cni:v3.32.1",
        occurrences: 2,
        target:
          "quay.io/calico/cni:v3.32.1@sha256:bb1567e3ed81e2e8414e9a68f186e1f7ffd4067a4871a9ae90896793af0190dd",
      },
      {
        source: "quay.io/calico/kube-controllers:v3.32.1",
        occurrences: 1,
        target:
          "quay.io/calico/kube-controllers:v3.32.1@sha256:18008f781c869376dbbc4dfb1ffe3afb46f7897887d4f20e080c420ac44a6612",
      },
      {
        source: "quay.io/calico/node:v3.32.1",
        occurrences: 2,
        target:
          "quay.io/calico/node:v3.32.1@sha256:7f874b3f0b540c2b523aea9961ef5e2f43b0af9056a47874c916d6cf348168d3",
      },
    ],
  },
  images: {
    sandboxWorkload:
      "docker.io/library/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436",
    packagedAppBase:
      "docker.io/library/node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03",
    placeholderApp:
      "nginxinc/nginx-unprivileged:stable-alpine@sha256:44e36330f74d4f3a1d4e222acca9e23b401fb87811a7597024502bb759c4dd49",
    reachabilityProbe:
      "curlimages/curl:8.10.1@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b",
    admissionProbe:
      "registry.k8s.io/pause:3.10@sha256:ee6521f290b2168b6e0935a181d4cff9be1ac3f505666ef0e3c98fae8199917a",
    reaper:
      "docker.io/alpine/k8s:1.35.6@sha256:b7a12c5ddf261994c33d2eaaa06fd69a0803ff6b38683bfa3d30a76dcdf92807",
  },
} as const

function versionMinor(version: string): number {
  const match = /^v?\d+\.(\d+)\.\d+$/.exec(version)
  if (match?.[1] === undefined) {
    throw new Error(`Expected a semantic version, received ${version}`)
  }
  return Number(match[1])
}

function imageTagVersion(image: string): string {
  const match = /:(\d+\.\d+\.\d+)@sha256:/.exec(image)
  if (match?.[1] === undefined) {
    throw new Error(`Expected a semantic image tag, received ${image}`)
  }
  return match[1]
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

describe("Kubernetes compatibility policy", () => {
  it("loads the exact approved checked-in policy", async () => {
    await expect(loadCompatibilityPolicy()).resolves.toEqual(approvedPolicy)
  })

  it("loads the default policy relative to the repository from an alternate working directory", async () => {
    const originalCwd = process.cwd()
    const alternateCwd = await mkdtemp(join(tmpdir(), "dawn-k8s-policy-cwd-"))

    try {
      vi.resetModules()
      process.chdir(alternateCwd)
      const { loadCompatibilityPolicy: loadFromAlternateCwd } = await import(
        "../../scripts/kubernetes-compat/policy.ts"
      )

      await expect(loadFromAlternateCwd()).resolves.toEqual(approvedPolicy)
    } finally {
      process.chdir(originalCwd)
      vi.resetModules()
      await rm(alternateCwd, { recursive: true })
    }
  })

  it("wraps missing policy file errors with the explicit path and cause", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dawn-k8s-policy-missing-"))
    const policyPath = join(directory, "missing.json")

    try {
      const error = await rejectedError(loadCompatibilityPolicy(policyPath))

      expect(error.message).toBe(`Failed to read Kubernetes compatibility policy at ${policyPath}`)
      expect(error.cause).toBeInstanceOf(Error)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it("wraps invalid JSON errors with the explicit path and cause", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dawn-k8s-policy-json-"))
    const policyPath = join(directory, "invalid.json")

    try {
      await writeFile(policyPath, "{ invalid json", "utf8")
      const error = await rejectedError(loadCompatibilityPolicy(policyPath))

      expect(error.message).toBe(
        `Failed to parse Kubernetes compatibility policy JSON at ${policyPath}`,
      )
      expect(error.cause).toBeInstanceOf(SyntaxError)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it("keeps target roles in exact lower, canonical, upper order", () => {
    const policy = validateCompatibilityPolicy(approvedPolicy)

    expect(policy.targets.map(({ role }) => role)).toEqual(["lower", "canonical", "upper"])
  })

  it("keeps target versions consistent with unique target minors", () => {
    const policy = validateCompatibilityPolicy(approvedPolicy)

    for (const target of policy.targets) {
      expect(target.version.startsWith(`${target.minor}.`)).toBe(true)
    }
    expect(new Set(policy.targets.map(({ minor }) => minor)).size).toBe(policy.targets.length)
  })

  it("pins every node and workload image with an exact lowercase SHA-256 digest", () => {
    const policy = validateCompatibilityPolicy(approvedPolicy)
    const images = [
      ...policy.targets.map(({ nodeImage }) => nodeImage),
      ...policy.calico.images.map(({ target }) => target),
      ...Object.values(policy.images),
    ]

    expect(images).toHaveLength(12)
    for (const image of images) {
      expect(image).toMatch(/@sha256:[0-9a-f]{64}$/)
    }
  })

  it("uses a raw lowercase SHA-256 and positive Calico occurrence counts", () => {
    const policy = validateCompatibilityPolicy(approvedPolicy)

    expect(policy.calico.sha256).toMatch(/^[0-9a-f]{64}$/)
    for (const image of policy.calico.images) {
      expect(image.occurrences).toBeGreaterThan(0)
    }
  })

  it("keeps workflow and reaper kubectl minors within one minor of every target", () => {
    const policy = validateCompatibilityPolicy(approvedPolicy)
    const kubectlMinor = versionMinor(policy.toolchain.kubectl)
    const reaperMinor = versionMinor(imageTagVersion(policy.images.reaper))

    for (const target of policy.targets) {
      const targetMinor = versionMinor(`${target.minor}.0`)
      expect(Math.abs(kubectlMinor - targetMinor)).toBeLessThanOrEqual(1)
      expect(Math.abs(reaperMinor - targetMinor)).toBeLessThanOrEqual(1)
    }
  })

  it("looks up targets by Kubernetes minor", () => {
    const policy = validateCompatibilityPolicy(approvedPolicy)

    expect(getTargetByMinor(policy, "1.35")).toBe(policy.targets[1])
    expect(() => getTargetByMinor(policy, "1.37")).toThrow(/targets.*1\.37/)
  })

  it("reconstructs validated policies instead of returning raw JSON", () => {
    const raw = { ...approvedPolicy, unexpected: "discarded" }
    const policy = validateCompatibilityPolicy(raw)

    expect(policy).not.toBe(raw)
    expect(policy).not.toHaveProperty("unexpected")
  })

  it("freezes the reconstructed policy object graph", () => {
    const policy = validateCompatibilityPolicy(approvedPolicy)

    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.toolchain)).toBe(true)
    expect(Object.isFrozen(policy.targets)).toBe(true)
    expect(policy.targets.every((target) => Object.isFrozen(target))).toBe(true)
    expect(Object.isFrozen(policy.calico)).toBe(true)
    expect(Object.isFrozen(policy.calico.images)).toBe(true)
    expect(policy.calico.images.every((image) => Object.isFrozen(image))).toBe(true)
    expect(Object.isFrozen(policy.images)).toBe(true)
  })

  it("rejects runtime mutation of policy objects, arrays, and entries", () => {
    const policy = validateCompatibilityPolicy(approvedPolicy)
    const target = policy.targets[0]
    const calicoImage = policy.calico.images[0]
    if (target === undefined || calicoImage === undefined) {
      throw new Error("Approved policy must contain target and Calico entries")
    }

    expect(Reflect.set(policy.toolchain, "node", "0.0.0")).toBe(false)
    expect(Reflect.set(policy.images, "reaper", "replacement")).toBe(false)
    expect(Reflect.set(target, "version", "0.0.0")).toBe(false)
    expect(Reflect.set(policy.targets, "0", { ...target, version: "0.0.0" })).toBe(false)
    expect(Reflect.set(policy.calico, "sha256", "0".repeat(64))).toBe(false)
    expect(Reflect.set(calicoImage, "occurrences", 99)).toBe(false)
    expect(Reflect.set(policy.calico.images, "0", { ...calicoImage, occurrences: 99 })).toBe(false)

    expect(policy).toEqual(approvedPolicy)
  })

  const malformedPolicies: ReadonlyArray<readonly [string, unknown, string]> = [
    ["root", null, "$"],
    ["schema version", { ...approvedPolicy, schemaVersion: 2 }, "schemaVersion"],
    ["toolchain object", { ...approvedPolicy, toolchain: [] }, "toolchain"],
    [
      "toolchain version",
      { ...approvedPolicy, toolchain: { ...approvedPolicy.toolchain, node: "v24.17.0" } },
      "toolchain.node",
    ],
    [
      "toolchain version leading zero",
      { ...approvedPolicy, toolchain: { ...approvedPolicy.toolchain, node: "24.017.0" } },
      "toolchain.node",
    ],
    [
      "toolchain unsafe version component",
      {
        ...approvedPolicy,
        toolchain: { ...approvedPolicy.toolchain, node: "9007199254740992.17.0" },
      },
      "toolchain.node",
    ],
    ["targets array", { ...approvedPolicy, targets: {} }, "targets"],
    ["target count", { ...approvedPolicy, targets: approvedPolicy.targets.slice(0, 2) }, "targets"],
    [
      "target object",
      {
        ...approvedPolicy,
        targets: [null, approvedPolicy.targets[1], approvedPolicy.targets[2]],
      },
      "targets[0]",
    ],
    [
      "role order",
      {
        ...approvedPolicy,
        targets: [
          { ...approvedPolicy.targets[0], role: "canonical" },
          approvedPolicy.targets[1],
          approvedPolicy.targets[2],
        ],
      },
      "targets[0].role",
    ],
    [
      "target minor",
      {
        ...approvedPolicy,
        targets: [
          { ...approvedPolicy.targets[0], minor: "v1.34" },
          approvedPolicy.targets[1],
          approvedPolicy.targets[2],
        ],
      },
      "targets[0].minor",
    ],
    [
      "target minor leading zero",
      {
        ...approvedPolicy,
        targets: [
          { ...approvedPolicy.targets[0], minor: "1.034" },
          approvedPolicy.targets[1],
          approvedPolicy.targets[2],
        ],
      },
      "targets[0].minor",
    ],
    [
      "target version",
      {
        ...approvedPolicy,
        targets: [
          { ...approvedPolicy.targets[0], version: "1.34" },
          approvedPolicy.targets[1],
          approvedPolicy.targets[2],
        ],
      },
      "targets[0].version",
    ],
    [
      "version and minor consistency",
      {
        ...approvedPolicy,
        targets: [
          { ...approvedPolicy.targets[0], version: "1.33.8" },
          approvedPolicy.targets[1],
          approvedPolicy.targets[2],
        ],
      },
      "targets[0].version",
    ],
    [
      "target version leading zero",
      {
        ...approvedPolicy,
        targets: [
          {
            ...approvedPolicy.targets[0],
            version: "1.34.08",
            nodeImage:
              "kindest/node:v1.34.08@sha256:02722c2dedddcfc00febf5d27fbeb9b7b2c14294c82109ff4a85d89ac9ba3256",
          },
          approvedPolicy.targets[1],
          approvedPolicy.targets[2],
        ],
      },
      "targets[0].version",
    ],
    [
      "target unsafe version component",
      {
        ...approvedPolicy,
        targets: [
          {
            ...approvedPolicy.targets[0],
            version: "1.34.9007199254740992",
            nodeImage:
              "kindest/node:v1.34.9007199254740992@sha256:02722c2dedddcfc00febf5d27fbeb9b7b2c14294c82109ff4a85d89ac9ba3256",
          },
          approvedPolicy.targets[1],
          approvedPolicy.targets[2],
        ],
      },
      "targets[0].version",
    ],
    [
      "node image digest",
      {
        ...approvedPolicy,
        targets: [
          { ...approvedPolicy.targets[0], nodeImage: "kindest/node:v1.34.8@sha256:ABC" },
          approvedPolicy.targets[1],
          approvedPolicy.targets[2],
        ],
      },
      "targets[0].nodeImage",
    ],
    [
      "node image prefix confusion",
      {
        ...approvedPolicy,
        targets: [
          {
            ...approvedPolicy.targets[0],
            nodeImage: `${approvedPolicy.targets[0].nodeImage}@sha256:${"a".repeat(64)}`,
          },
          approvedPolicy.targets[1],
          approvedPolicy.targets[2],
        ],
      },
      "targets[0].nodeImage",
    ],
    [
      "unique target minors",
      {
        ...approvedPolicy,
        targets: [
          approvedPolicy.targets[0],
          approvedPolicy.targets[1],
          {
            ...approvedPolicy.targets[2],
            minor: "1.35",
            version: "1.35.1",
            nodeImage:
              "kindest/node:v1.35.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5",
          },
        ],
      },
      "targets[2].minor",
    ],
    ["calico object", { ...approvedPolicy, calico: [] }, "calico"],
    [
      "Calico manifest URL",
      { ...approvedPolicy, calico: { ...approvedPolicy.calico, manifestUrl: "" } },
      "calico.manifestUrl",
    ],
    [
      "Calico raw digest",
      { ...approvedPolicy, calico: { ...approvedPolicy.calico, sha256: "A".repeat(64) } },
      "calico.sha256",
    ],
    [
      "Calico images array",
      { ...approvedPolicy, calico: { ...approvedPolicy.calico, images: {} } },
      "calico.images",
    ],
    [
      "Calico image object",
      {
        ...approvedPolicy,
        calico: {
          ...approvedPolicy.calico,
          images: [null, approvedPolicy.calico.images[1], approvedPolicy.calico.images[2]],
        },
      },
      "calico.images[0]",
    ],
    [
      "Calico image source",
      {
        ...approvedPolicy,
        calico: {
          ...approvedPolicy.calico,
          images: [
            { ...approvedPolicy.calico.images[0], source: "" },
            approvedPolicy.calico.images[1],
            approvedPolicy.calico.images[2],
          ],
        },
      },
      "calico.images[0].source",
    ],
    [
      "Calico occurrence count",
      {
        ...approvedPolicy,
        calico: {
          ...approvedPolicy.calico,
          images: [
            { ...approvedPolicy.calico.images[0], occurrences: 0 },
            approvedPolicy.calico.images[1],
            approvedPolicy.calico.images[2],
          ],
        },
      },
      "calico.images[0].occurrences",
    ],
    [
      "Calico target digest",
      {
        ...approvedPolicy,
        calico: {
          ...approvedPolicy.calico,
          images: [
            { ...approvedPolicy.calico.images[0], target: "quay.io/calico/cni:v3.32.1" },
            approvedPolicy.calico.images[1],
            approvedPolicy.calico.images[2],
          ],
        },
      },
      "calico.images[0].target",
    ],
    [
      "Calico source prefix confusion",
      {
        ...approvedPolicy,
        calico: {
          ...approvedPolicy.calico,
          images: [
            {
              ...approvedPolicy.calico.images[0],
              target: `${approvedPolicy.calico.images[0].target}@sha256:${"a".repeat(64)}`,
            },
            approvedPolicy.calico.images[1],
            approvedPolicy.calico.images[2],
          ],
        },
      },
      "calico.images[0].target",
    ],
    ["images object", { ...approvedPolicy, images: [] }, "images"],
    [
      "workload image digest",
      {
        ...approvedPolicy,
        images: { ...approvedPolicy.images, sandboxWorkload: "docker.io/library/node:22-slim" },
      },
      "images.sandboxWorkload",
    ],
    [
      "multiple image digests",
      {
        ...approvedPolicy,
        images: {
          ...approvedPolicy.images,
          sandboxWorkload: `docker.io/library/node:22-slim@sha256:${"a".repeat(
            64,
          )}@sha256:${"b".repeat(64)}`,
        },
      },
      "images.sandboxWorkload",
    ],
    [
      "whitespace in an image name",
      {
        ...approvedPolicy,
        images: {
          ...approvedPolicy.images,
          sandboxWorkload: `docker.io/library/node:22 slim@sha256:${"a".repeat(64)}`,
        },
      },
      "images.sandboxWorkload",
    ],
    [
      "workflow kubectl skew",
      {
        ...approvedPolicy,
        toolchain: { ...approvedPolicy.toolchain, kubectl: "v1.40.0" },
      },
      "toolchain.kubectl",
    ],
    [
      "reaper kubectl skew",
      {
        ...approvedPolicy,
        images: {
          ...approvedPolicy.images,
          reaper:
            "docker.io/alpine/k8s:1.40.0@sha256:b7a12c5ddf261994c33d2eaaa06fd69a0803ff6b38683bfa3d30a76dcdf92807",
        },
      },
      "images.reaper",
    ],
    [
      "reaper tag leading zero",
      {
        ...approvedPolicy,
        images: {
          ...approvedPolicy.images,
          reaper:
            "docker.io/alpine/k8s:1.035.6@sha256:b7a12c5ddf261994c33d2eaaa06fd69a0803ff6b38683bfa3d30a76dcdf92807",
        },
      },
      "images.reaper",
    ],
    [
      "reaper unsafe tag component",
      {
        ...approvedPolicy,
        images: {
          ...approvedPolicy.images,
          reaper:
            "docker.io/alpine/k8s:1.35.9007199254740992@sha256:b7a12c5ddf261994c33d2eaaa06fd69a0803ff6b38683bfa3d30a76dcdf92807",
        },
      },
      "images.reaper",
    ],
  ]

  it.each(malformedPolicies)(
    "rejects malformed %s with a path-specific error",
    (_name, raw, path) => {
      expect(() => validateCompatibilityPolicy(raw)).toThrow(path)
    },
  )
})
