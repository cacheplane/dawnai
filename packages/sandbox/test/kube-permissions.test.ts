import { ApiException } from "@kubernetes/client-node"
import { beforeEach, describe, expect, test, vi } from "vitest"

import { KubeAuthorizationReviewError as PublicKubeAuthorizationReviewError } from "../src/index.ts"
import { createDefaultKubeClient } from "../src/kubernetes/default-kube-client.ts"
import {
  KubeAuthorizationReviewError,
  type KubePermission,
  REQUIRED_KUBE_PERMISSIONS,
} from "../src/kubernetes/kube-client.ts"
import { kubernetesSandbox } from "../src/kubernetes/kube-sandbox.ts"
import { fakeKubeClient } from "./support/fake-kube-client.ts"

const kubernetesMocks = vi.hoisted(() => ({
  createSelfSubjectAccessReview: vi.fn(),
}))

vi.mock("@kubernetes/client-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kubernetes/client-node")>()

  class KubeConfig {
    loadFromDefault(): void {}

    makeApiClient(api: unknown): unknown {
      return api === actual.AuthorizationV1Api
        ? { createSelfSubjectAccessReview: kubernetesMocks.createSelfSubjectAccessReview }
        : {}
    }
  }

  return { ...actual, KubeConfig }
})

const expected = [
  { apiGroup: "", resource: "pods", verb: "create" },
  { apiGroup: "", resource: "pods", verb: "get" },
  { apiGroup: "", resource: "pods", verb: "delete" },
  { apiGroup: "", resource: "persistentvolumeclaims", verb: "create" },
  { apiGroup: "", resource: "persistentvolumeclaims", verb: "get" },
  { apiGroup: "", resource: "persistentvolumeclaims", verb: "delete" },
  { apiGroup: "", resource: "pods", subresource: "exec", verb: "create" },
  { apiGroup: "", resource: "pods", subresource: "exec", verb: "get" },
  { apiGroup: "networking.k8s.io", resource: "networkpolicies", verb: "create" },
  { apiGroup: "networking.k8s.io", resource: "networkpolicies", verb: "get" },
  { apiGroup: "networking.k8s.io", resource: "networkpolicies", verb: "list" },
  { apiGroup: "networking.k8s.io", resource: "networkpolicies", verb: "update" },
  { apiGroup: "networking.k8s.io", resource: "networkpolicies", verb: "delete" },
] as const satisfies readonly KubePermission[]

const publicPermission: import("../src/index.ts").KubePermission = expected[0]

// @ts-expect-error - pods/exec cannot be deleted by this provider.
const cannotDeletePodExec: KubePermission = {
  apiGroup: "",
  resource: "pods",
  subresource: "exec",
  verb: "delete",
}

// @ts-expect-error - pods cannot be listed by this provider.
const cannotListPods: KubePermission = { apiGroup: "", resource: "pods", verb: "list" }

// @ts-expect-error - NetworkPolicy is not a core-group resource.
const cannotUseCoreNetworkPolicy: KubePermission = {
  apiGroup: "",
  resource: "networkpolicies",
  verb: "get",
}

void [publicPermission, cannotDeletePodExec, cannotListPods, cannotUseCoreNetworkPolicy]

describe("Kubernetes permission contract", () => {
  test("exports the authorization-review error contract for custom clients", () => {
    const error = new PublicKubeAuthorizationReviewError("api", "review rejected")

    expect(error).toBeInstanceOf(KubeAuthorizationReviewError)
    expect(error).toMatchObject({ kind: "api", message: "review rejected" })
  })

  test("contains only the provider's exact valid operations", () => {
    expect(REQUIRED_KUBE_PERMISSIONS).toEqual(expected)
  })

  test("preflight probes every permission and reports all denials deterministically", async () => {
    const client = fakeKubeClient({
      deniedPermissions: [
        { verb: "get", resource: "networkpolicies", apiGroup: "networking.k8s.io" },
        { verb: "get", resource: "pods", apiGroup: "" },
      ],
    })
    const result = await kubernetesSandbox({
      image: "image",
      namespace: "ns",
      client,
    }).preflight?.()

    expect(client.permissionChecks).toEqual(expected)
    expect(result).toEqual({
      ok: false,
      detail:
        'Missing Kubernetes permissions in namespace "ns": get core/pods, get networking.k8s.io/networkpolicies.',
    })
  })

  test("runs every review and sorts API authorization-review failures", async () => {
    const client = fakeKubeClient({
      permissionErrors: new Map([
        [JSON.stringify(expected[8]), new Error("network policy review unavailable")],
        [JSON.stringify(expected[0]), new Error("pod review unavailable")],
      ]),
    })
    const result = await kubernetesSandbox({
      image: "image",
      namespace: "ns",
      client,
    }).preflight?.()

    expect(client.permissionChecks).toEqual(expected)
    expect(result).toEqual({
      ok: false,
      detail:
        'Kubernetes authorization review failed in namespace "ns": create core/pods, create networking.k8s.io/networkpolicies.',
    })
    expect(result?.detail).not.toMatch(/Missing Kubernetes permissions/i)
  })

  test("reports denials separately from authorization-review failures", async () => {
    const client = fakeKubeClient({
      deniedPermissions: [expected[9]],
      permissionErrors: new Map([
        [JSON.stringify(expected[0]), new Error("pod review unavailable")],
      ]),
    })
    const result = await kubernetesSandbox({
      image: "image",
      namespace: "ns",
      client,
    }).preflight?.()

    expect(result).toEqual({
      ok: false,
      detail:
        'Kubernetes authorization review failed in namespace "ns": create core/pods. Missing Kubernetes permissions in namespace "ns": get networking.k8s.io/networkpolicies.',
    })
  })

  test("reports transport review failures as an unreachable Kubernetes API", async () => {
    const client = fakeKubeClient({
      permissionErrors: new Map([
        [
          JSON.stringify(expected[7]),
          new KubeAuthorizationReviewError("transport", "connection refused"),
        ],
      ]),
    })
    const result = await kubernetesSandbox({
      image: "image",
      namespace: "ns",
      client,
    }).preflight?.()

    expect(client.permissionChecks).toEqual(expected)
    expect(result).toEqual({
      ok: false,
      detail:
        'Kubernetes API not reachable while reviewing permissions in namespace "ns": get core/pods/exec.',
    })
    expect(result?.detail).not.toMatch(
      /authorization review failed|Missing Kubernetes permissions/i,
    )
  })
})

describe("default Kubernetes authorization reviews", () => {
  beforeEach(() => {
    kubernetesMocks.createSelfSubjectAccessReview.mockReset()
  })

  test("maps permission fields and omits an absent subresource", async () => {
    kubernetesMocks.createSelfSubjectAccessReview.mockResolvedValue({ status: { allowed: true } })
    const client = createDefaultKubeClient()

    await expect(client.canI("ns", expected[1])).resolves.toBe(true)
    await expect(client.canI("ns", expected[6])).resolves.toBe(true)

    expect(kubernetesMocks.createSelfSubjectAccessReview).toHaveBeenNthCalledWith(1, {
      body: {
        spec: {
          resourceAttributes: {
            group: "",
            namespace: "ns",
            resource: "pods",
            verb: "get",
          },
        },
      },
    })
    expect(kubernetesMocks.createSelfSubjectAccessReview).toHaveBeenNthCalledWith(2, {
      body: {
        spec: {
          resourceAttributes: {
            group: "",
            namespace: "ns",
            resource: "pods",
            subresource: "exec",
            verb: "create",
          },
        },
      },
    })
  })

  test.each([
    ["api" as const, new ApiException(403, "forbidden", {}, {})],
    ["transport" as const, new Error("connection refused")],
  ])("classifies %s failures", async (kind, cause) => {
    kubernetesMocks.createSelfSubjectAccessReview.mockRejectedValue(cause)
    const client = createDefaultKubeClient()

    const error = await client.canI("ns", expected[0]).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(KubeAuthorizationReviewError)
    expect(error).toMatchObject({ kind, cause })
  })
})
