import { ApiException, type V1NetworkPolicy } from "@kubernetes/client-node"
import { beforeEach, describe, expect, test, vi } from "vitest"

import {
  createDefaultKubeClient,
  prepareNetworkPolicyReplacement,
} from "../src/kubernetes/default-kube-client.ts"
import type { KubeNetworkPolicySpec } from "../src/kubernetes/kube-client.ts"

const kubernetesMocks = vi.hoisted(() => ({
  createNamespacedNetworkPolicy: vi.fn(),
  readNamespacedNetworkPolicy: vi.fn(),
  replaceNamespacedNetworkPolicy: vi.fn(),
  patchNamespacedNetworkPolicy: vi.fn(),
}))

vi.mock("@kubernetes/client-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kubernetes/client-node")>()

  class KubeConfig {
    loadFromDefault(): void {}

    makeApiClient(api: unknown): unknown {
      return api === actual.NetworkingV1Api ? kubernetesMocks : {}
    }
  }

  return { ...actual, KubeConfig }
})

const policyName = "dawn-sbx-net-thread"
const threadLabelValue = "thread"
const ownerLabels = {
  "app.kubernetes.io/managed-by": "dawn",
  "dawn.sh/thread": threadLabelValue,
}
const desired: V1NetworkPolicy = {
  apiVersion: "networking.k8s.io/v1",
  kind: "NetworkPolicy",
  metadata: {
    name: policyName,
    namespace: "sandboxes",
    labels: { ...ownerLabels, "desired-only": "preserved" },
    annotations: { desired: "preserved" },
  },
  spec: {
    podSelector: { matchLabels: { "dawn.sh/thread": threadLabelValue } },
    policyTypes: ["Egress"],
    egress: [],
  },
}
const networkPolicySpec = {
  name: policyName,
  labels: ownerLabels,
  threadLabelValue,
  mode: "deny",
} satisfies KubeNetworkPolicySpec
const generatedPolicyBody: V1NetworkPolicy = {
  metadata: { name: policyName, labels: ownerLabels },
  spec: {
    podSelector: { matchLabels: { "dawn.sh/thread": threadLabelValue } },
    policyTypes: ["Egress"],
    egress: [
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
            },
          },
        ],
        ports: [
          { protocol: "UDP", port: 53 },
          { protocol: "TCP", port: 53 },
        ],
      },
    ],
  },
}

function existingPolicy(metadata: NonNullable<V1NetworkPolicy["metadata"]>): V1NetworkPolicy {
  return { metadata }
}

describe("prepareNetworkPolicyReplacement", () => {
  test("carries only the live resourceVersion into the complete desired policy", () => {
    const existing: V1NetworkPolicy = {
      metadata: {
        name: policyName,
        resourceVersion: "42",
        labels: { ...ownerLabels, "live-only": "must-not-carry" },
        annotations: { "live-only": "must-not-carry" },
        uid: "live-uid",
      },
      spec: { podSelector: { matchLabels: { "live-only": "must-not-carry" } } },
    }

    const replacement = prepareNetworkPolicyReplacement(existing, desired, threadLabelValue)

    expect(replacement).toEqual({
      ...desired,
      metadata: { ...desired.metadata, resourceVersion: "42" },
    })
    expect(desired.metadata?.resourceVersion).toBeUndefined()
  })

  test("rejects an existing policy with the wrong name", () => {
    const existing = existingPolicy({
      name: "other",
      resourceVersion: "42",
      labels: ownerLabels,
    })

    expect(() => prepareNetworkPolicyReplacement(existing, desired, threadLabelValue)).toThrow(
      /name/i,
    )
  })

  test.each([
    ["missing", { "dawn.sh/thread": threadLabelValue }],
    ["wrong", { ...ownerLabels, "app.kubernetes.io/managed-by": "other" }],
  ])("rejects a %s managed-by label", (_case, labels) => {
    const existing = existingPolicy({ name: policyName, resourceVersion: "42", labels })

    expect(() => prepareNetworkPolicyReplacement(existing, desired, threadLabelValue)).toThrow(
      /owned/i,
    )
  })

  test.each([
    ["missing", { "app.kubernetes.io/managed-by": "dawn" }],
    ["wrong", { ...ownerLabels, "dawn.sh/thread": "other" }],
  ])("rejects a %s thread label", (_case, labels) => {
    const existing = existingPolicy({ name: policyName, resourceVersion: "42", labels })

    expect(() => prepareNetworkPolicyReplacement(existing, desired, threadLabelValue)).toThrow(
      /thread/i,
    )
  })

  test.each([undefined, ""])("rejects an invalid resourceVersion: %s", (resourceVersion) => {
    const existing = existingPolicy({
      name: policyName,
      labels: ownerLabels,
      ...(resourceVersion !== undefined ? { resourceVersion } : {}),
    })

    expect(() => prepareNetworkPolicyReplacement(existing, desired, threadLabelValue)).toThrow(
      /resourceVersion/i,
    )
  })
})

describe("default Kubernetes NetworkPolicy replacement", () => {
  beforeEach(() => {
    kubernetesMocks.createNamespacedNetworkPolicy.mockReset()
    kubernetesMocks.readNamespacedNetworkPolicy.mockReset()
    kubernetesMocks.replaceNamespacedNetworkPolicy.mockReset()
    kubernetesMocks.patchNamespacedNetworkPolicy.mockReset()
  })

  test("creates first and replaces a matching owned conflict with its live resourceVersion", async () => {
    const calls: string[] = []
    const conflict = new ApiException(409, "already exists", {}, {})
    kubernetesMocks.createNamespacedNetworkPolicy.mockImplementation(async () => {
      calls.push("create")
      throw conflict
    })
    kubernetesMocks.readNamespacedNetworkPolicy.mockImplementation(async () => {
      calls.push("read")
      return existingPolicy({
        name: policyName,
        resourceVersion: "42",
        labels: ownerLabels,
      })
    })
    kubernetesMocks.replaceNamespacedNetworkPolicy.mockImplementation(async () => {
      calls.push("replace")
    })
    const client = createDefaultKubeClient()

    await client.upsertNamespacedNetworkPolicy("sandboxes", networkPolicySpec)

    expect(calls).toEqual(["create", "read", "replace"])
    expect(kubernetesMocks.createNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: "sandboxes",
      body: generatedPolicyBody,
    })
    expect(kubernetesMocks.readNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: policyName,
      namespace: "sandboxes",
    })
    expect(kubernetesMocks.replaceNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: policyName,
      namespace: "sandboxes",
      body: {
        ...generatedPolicyBody,
        metadata: { ...generatedPolicyBody.metadata, resourceVersion: "42" },
      },
    })
    expect(kubernetesMocks.patchNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  test("does not read or replace after a successful create", async () => {
    kubernetesMocks.createNamespacedNetworkPolicy.mockResolvedValue(undefined)
    const client = createDefaultKubeClient()

    await client.upsertNamespacedNetworkPolicy("sandboxes", networkPolicySpec)

    expect(kubernetesMocks.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    expect(kubernetesMocks.readNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(kubernetesMocks.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(kubernetesMocks.patchNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  test("surfaces a non-conflict create error without reading or replacing", async () => {
    const createError = new Error("create failed")
    kubernetesMocks.createNamespacedNetworkPolicy.mockRejectedValue(createError)
    const client = createDefaultKubeClient()

    await expect(client.upsertNamespacedNetworkPolicy("sandboxes", networkPolicySpec)).rejects.toBe(
      createError,
    )
    expect(kubernetesMocks.readNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(kubernetesMocks.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(kubernetesMocks.patchNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  test("surfaces a read error without replacing", async () => {
    const readError = new Error("read failed")
    kubernetesMocks.createNamespacedNetworkPolicy.mockRejectedValue(
      new ApiException(409, "already exists", {}, {}),
    )
    kubernetesMocks.readNamespacedNetworkPolicy.mockRejectedValue(readError)
    const client = createDefaultKubeClient()

    await expect(client.upsertNamespacedNetworkPolicy("sandboxes", networkPolicySpec)).rejects.toBe(
      readError,
    )
    expect(kubernetesMocks.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(kubernetesMocks.patchNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  test("surfaces ownership refusal without replacing an unowned conflict", async () => {
    kubernetesMocks.createNamespacedNetworkPolicy.mockRejectedValue(
      new ApiException(409, "already exists", {}, {}),
    )
    kubernetesMocks.readNamespacedNetworkPolicy.mockResolvedValue(
      existingPolicy({
        name: policyName,
        resourceVersion: "42",
        labels: {
          "app.kubernetes.io/managed-by": "other",
          "dawn.sh/thread": threadLabelValue,
        },
      }),
    )
    const client = createDefaultKubeClient()

    await expect(
      client.upsertNamespacedNetworkPolicy("sandboxes", networkPolicySpec),
    ).rejects.toThrow(/owned/i)
    expect(kubernetesMocks.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(kubernetesMocks.patchNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  test("surfaces a replacement conflict without retrying or patching", async () => {
    const replacementConflict = new ApiException(409, "replace conflict", {}, {})
    kubernetesMocks.createNamespacedNetworkPolicy.mockRejectedValue(
      new ApiException(409, "already exists", {}, {}),
    )
    kubernetesMocks.readNamespacedNetworkPolicy.mockResolvedValue(
      existingPolicy({
        name: policyName,
        resourceVersion: "42",
        labels: ownerLabels,
      }),
    )
    kubernetesMocks.replaceNamespacedNetworkPolicy.mockRejectedValue(replacementConflict)
    const client = createDefaultKubeClient()

    await expect(client.upsertNamespacedNetworkPolicy("sandboxes", networkPolicySpec)).rejects.toBe(
      replacementConflict,
    )
    expect(kubernetesMocks.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    expect(kubernetesMocks.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    expect(kubernetesMocks.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    expect(kubernetesMocks.patchNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })
})
