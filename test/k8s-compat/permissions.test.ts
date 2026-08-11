import { describe, expect, test, vi } from "vitest"

import type {
  Command,
  CommandExecutionOptions,
  CommandResult,
} from "../../scripts/kubernetes-compat/command.ts"
import {
  ADMIN_PERMISSION_GROUPS,
  AdministrativePermissionError,
  assertAdministrativePermissions,
  expandAdministrativePermissions,
  permissionKey,
} from "../../scripts/kubernetes-compat/permissions.ts"

const lifecycle = ["create", "get", "list", "update", "patch", "delete"] as const

const EXPECTED_GROUPS = [
  { scope: "cluster", apiGroup: "", resources: ["namespaces"], verbs: lifecycle },
  {
    scope: "cluster",
    apiGroup: "storage.k8s.io",
    resources: ["storageclasses"],
    verbs: ["get", "list"],
  },
  {
    scope: "cluster",
    apiGroup: "authorization.k8s.io",
    resources: ["selfsubjectaccessreviews"],
    verbs: ["create"],
  },
  { scope: "management", apiGroup: "", resources: ["secrets"], verbs: lifecycle },
  { scope: "both", apiGroup: "", resources: ["serviceaccounts"], verbs: lifecycle },
  {
    scope: "sandbox",
    apiGroup: "",
    resources: ["serviceaccounts"],
    subresource: "token",
    verbs: ["create"],
  },
  {
    scope: "sandbox",
    apiGroup: "rbac.authorization.k8s.io",
    resources: ["roles", "rolebindings"],
    verbs: lifecycle,
  },
  {
    scope: "sandbox",
    apiGroup: "",
    resources: ["configmaps", "resourcequotas", "limitranges", "persistentvolumeclaims"],
    verbs: lifecycle,
  },
  { scope: "both", apiGroup: "", resources: ["services"], verbs: lifecycle },
  {
    scope: "both",
    apiGroup: "",
    resources: ["pods"],
    verbs: ["create", "get", "list", "watch", "delete"],
  },
  {
    scope: "management",
    apiGroup: "apps",
    resources: ["deployments"],
    verbs: ["create", "get", "list", "watch", "update", "patch", "delete"],
  },
  {
    scope: "sandbox",
    apiGroup: "batch",
    resources: ["cronjobs", "jobs"],
    verbs: ["create", "get", "list", "watch", "update", "patch", "delete"],
  },
  {
    scope: "sandbox",
    apiGroup: "networking.k8s.io",
    resources: ["networkpolicies"],
    verbs: ["create", "get", "list", "watch", "update", "patch", "delete"],
  },
  {
    scope: "sandbox",
    apiGroup: "",
    resources: ["pods"],
    subresource: "exec",
    verbs: ["create", "get"],
  },
  {
    scope: "both",
    apiGroup: "",
    resources: ["pods"],
    subresource: "log",
    verbs: ["get"],
  },
  { scope: "both", apiGroup: "", resources: ["events"], verbs: ["get", "list", "watch"] },
] as const

function result(command: Command, value: unknown): CommandResult {
  return {
    command,
    stdout: Buffer.from(JSON.stringify(value)),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
    toJSON: () => ({ command, outcome: { kind: "exit", exitCode: 0 } }),
  }
}

describe("administrative permission declaration", () => {
  test("matches the approved groups exactly", () => {
    expect(ADMIN_PERMISSION_GROUPS).toEqual(EXPECTED_GROUPS)
  })

  test("locks every expanded tuple and namespace scope", () => {
    const expanded = expandAdministrativePermissions({
      managementNamespace: "dawn-management-a",
      sandboxNamespace: "dawn-sandbox-a",
    })
    const expected = EXPECTED_GROUPS.flatMap((group) => {
      const namespaces =
        group.scope === "cluster"
          ? [undefined]
          : group.scope === "management"
            ? ["dawn-management-a"]
            : group.scope === "sandbox"
              ? ["dawn-sandbox-a"]
              : ["dawn-management-a", "dawn-sandbox-a"]
      return group.resources.flatMap((resource) =>
        group.verbs.flatMap((verb) =>
          namespaces.map((namespace) => ({
            apiGroup: group.apiGroup,
            resource,
            ...("subresource" in group ? { subresource: group.subresource } : {}),
            verb,
            ...(namespace !== undefined
              ? { scope: "namespace" as const, namespace }
              : { scope: "cluster" as const }),
          })),
        ),
      )
    })

    expect(expanded).toEqual(
      expected.sort((a, b) => {
        const left = permissionKey(a)
        const right = permissionKey(b)
        return left < right ? -1 : left > right ? 1 : 0
      }),
    )
    expect(new Set(expanded.map(permissionKey)).size).toBe(expanded.length)
  })
})

describe("administrative authorization preflight", () => {
  test("submits every review through explicit context and returns sorted results", async () => {
    const execute = vi.fn(
      async (command: Command, _options?: CommandExecutionOptions): Promise<CommandResult> =>
        result(command, { status: { allowed: true } }),
    )

    const reviewed = await assertAdministrativePermissions(
      {
        context: "kind-dawn",
        managementNamespace: "dawn-management-a",
        sandboxNamespace: "dawn-sandbox-a",
      },
      execute,
    )

    expect(reviewed.map(permissionKey)).toEqual([...reviewed.map(permissionKey)].sort())
    expect(execute).toHaveBeenCalledTimes(reviewed.length)
    for (const [index, call] of execute.mock.calls.entries()) {
      const [command, options] = call
      expect(command).toEqual({
        file: "kubectl",
        args: [
          "--context",
          "kind-dawn",
          "create",
          "--raw",
          "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
          "-f",
          "-",
        ],
      })
      const body = JSON.parse(String(options?.stdin))
      expect(body).toEqual({
        apiVersion: "authorization.k8s.io/v1",
        kind: "SelfSubjectAccessReview",
        spec: {
          resourceAttributes: {
            group: reviewed[index]?.apiGroup,
            resource: reviewed[index]?.resource,
            verb: reviewed[index]?.verb,
            ...(reviewed[index]?.subresource !== undefined
              ? { subresource: reviewed[index].subresource }
              : {}),
            ...(reviewed[index]?.scope === "namespace"
              ? { namespace: reviewed[index].namespace }
              : {}),
          },
        },
      })
    }
  })

  test("settles all reviews and distinguishes sorted denials from review failures", async () => {
    let call = 0
    const execute = vi.fn(async (command: Command): Promise<CommandResult> => {
      call += 1
      if (call === 1) {
        return result(command, { status: { allowed: false, reason: "denied" } })
      }
      if (call === 2) {
        throw new Error("API unavailable")
      }
      if (call === 3) {
        return result(command, { status: { reason: "malformed" } })
      }
      if (call === 4) {
        return result(command, {
          status: { allowed: false, evaluationError: "authorizer could not evaluate" },
        })
      }
      return result(command, { status: { allowed: true } })
    })

    const error = await assertAdministrativePermissions(
      {
        context: "kind-dawn",
        managementNamespace: "dawn-management-a",
        sandboxNamespace: "dawn-sandbox-a",
      },
      execute,
    ).catch((cause: unknown) => cause)

    expect(execute).toHaveBeenCalledTimes(
      expandAdministrativePermissions({
        managementNamespace: "dawn-management-a",
        sandboxNamespace: "dawn-sandbox-a",
      }).length,
    )
    expect(error).toBeInstanceOf(AdministrativePermissionError)
    if (!(error instanceof AdministrativePermissionError)) {
      throw new Error("Expected AdministrativePermissionError")
    }
    expect(error).toMatchObject({
      denied: expect.arrayContaining([expect.any(String)]),
      failed: expect.arrayContaining([expect.any(String)]),
    })
    expect(error.denied).toEqual([...error.denied].sort())
    expect(error.failed).toEqual([...error.failed].sort())
    expect(error.denied).toHaveLength(1)
    expect(error.failed).toHaveLength(3)
    expect(error.failed.join("\n")).toContain("authorizer could not evaluate")
    expect(error.message).toContain("Denied permissions:")
    expect(error.message).toContain("Failed authorization reviews:")
  })
})
