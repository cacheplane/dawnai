import {
  type Command,
  type CommandExecutionOptions,
  type CommandResult,
  executeCommand,
  kubectl,
} from "./command.js"

const lifecycle = ["create", "get", "list", "update", "patch", "delete"] as const

export const ADMIN_PERMISSION_GROUPS = [
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

type AdministrativePermissionGroup = (typeof ADMIN_PERMISSION_GROUPS)[number]
type AdministrativeVerb = AdministrativePermissionGroup["verbs"][number]

interface PermissionTuple {
  readonly apiGroup: string
  readonly resource: string
  readonly subresource?: string
  readonly verb: AdministrativeVerb
}

export type AdministrativePermission = PermissionTuple &
  (
    | { readonly scope: "cluster"; readonly namespace?: never }
    | { readonly scope: "namespace"; readonly namespace: string }
  )

export interface AdministrativePermissionNamespaces {
  readonly managementNamespace: string
  readonly sandboxNamespace: string
}

export interface AdministrativePermissionPreflightInput extends AdministrativePermissionNamespaces {
  readonly context: string
}

export type CommandRunner = (
  command: Command,
  options?: CommandExecutionOptions,
) => Promise<CommandResult>

interface ReviewResponse {
  readonly status?: {
    readonly allowed?: unknown
    readonly reason?: unknown
    readonly evaluationError?: unknown
  }
}

const REVIEW_PATH = "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews"

function expectNonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function namespaceScopes(
  scope: AdministrativePermissionGroup["scope"],
  names: AdministrativePermissionNamespaces,
): readonly (string | undefined)[] {
  switch (scope) {
    case "cluster":
      return [undefined]
    case "management":
      return [names.managementNamespace]
    case "sandbox":
      return [names.sandboxNamespace]
    case "both":
      return [names.managementNamespace, names.sandboxNamespace]
  }
}

export function permissionKey(permission: AdministrativePermission): string {
  const apiGroup = permission.apiGroup === "" ? "core" : permission.apiGroup
  const resource = `${permission.resource}${
    permission.subresource === undefined ? "" : `/${permission.subresource}`
  }`
  const scope = permission.scope === "cluster" ? "cluster" : `namespace/${permission.namespace}`
  return `${scope} ${permission.verb} ${apiGroup}/${resource}`
}

export function expandAdministrativePermissions(
  names: AdministrativePermissionNamespaces,
): readonly AdministrativePermission[] {
  const managementNamespace = expectNonEmpty(names.managementNamespace, "Management namespace")
  const sandboxNamespace = expectNonEmpty(names.sandboxNamespace, "Sandbox namespace")
  if (managementNamespace === sandboxNamespace) {
    throw new Error("Management and sandbox namespaces must be distinct")
  }
  const validatedNames = { managementNamespace, sandboxNamespace }
  const permissions = ADMIN_PERMISSION_GROUPS.flatMap((group) =>
    group.resources.flatMap((resource) =>
      group.verbs.flatMap((verb) =>
        namespaceScopes(group.scope, validatedNames).map(
          (namespace): AdministrativePermission => ({
            apiGroup: group.apiGroup,
            resource,
            ...("subresource" in group ? { subresource: group.subresource } : {}),
            verb,
            ...(namespace === undefined ? { scope: "cluster" } : { scope: "namespace", namespace }),
          }),
        ),
      ),
    ),
  )
  permissions.sort((left, right) => compareStrings(permissionKey(left), permissionKey(right)))
  const keys = permissions.map(permissionKey)
  if (new Set(keys).size !== keys.length) {
    throw new Error("Administrative permission declaration expands to duplicate tuples")
  }
  return Object.freeze(permissions.map((permission) => Object.freeze(permission)))
}

function reviewBody(permission: AdministrativePermission): string {
  return JSON.stringify({
    apiVersion: "authorization.k8s.io/v1",
    kind: "SelfSubjectAccessReview",
    spec: {
      resourceAttributes: {
        group: permission.apiGroup,
        resource: permission.resource,
        verb: permission.verb,
        ...(permission.subresource !== undefined ? { subresource: permission.subresource } : {}),
        ...(permission.scope === "namespace" ? { namespace: permission.namespace } : {}),
      },
    },
  })
}

function parseReview(result: CommandResult): ReviewResponse {
  let value: unknown
  try {
    value = JSON.parse(result.stdout.toString("utf8"))
  } catch (cause) {
    throw new Error("authorization review returned invalid JSON", { cause })
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("authorization review returned a non-object response")
  }
  return value as ReviewResponse
}

function failureSummary(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message.replaceAll(/\s+/g, " ")
  }
  return "unknown authorization review failure"
}

export class AdministrativePermissionError extends Error {
  readonly denied: readonly string[]
  readonly failed: readonly string[]

  constructor(denied: readonly string[], failed: readonly string[]) {
    const sortedDenied = Object.freeze([...denied].sort())
    const sortedFailed = Object.freeze([...failed].sort())
    const sections = [
      ...(sortedDenied.length > 0
        ? [`Denied permissions:\n${sortedDenied.map((item) => `- ${item}`).join("\n")}`]
        : []),
      ...(sortedFailed.length > 0
        ? [`Failed authorization reviews:\n${sortedFailed.map((item) => `- ${item}`).join("\n")}`]
        : []),
    ]
    super(`Kubernetes administrative preflight failed.\n${sections.join("\n")}`)
    this.name = "AdministrativePermissionError"
    this.denied = sortedDenied
    this.failed = sortedFailed
  }
}

export async function assertAdministrativePermissions(
  input: AdministrativePermissionPreflightInput,
  execute: CommandRunner = executeCommand,
): Promise<readonly AdministrativePermission[]> {
  const context = expectNonEmpty(input.context, "Kubernetes context")
  const permissions = expandAdministrativePermissions(input)
  const settled = await Promise.allSettled(
    permissions.map(async (permission) => {
      const result = await execute(
        kubectl.command(context, ["create", "--raw", REVIEW_PATH, "-f", "-"]),
        { stdin: reviewBody(permission) },
      )
      const response = parseReview(result)
      if (
        typeof response.status?.evaluationError === "string" &&
        response.status.evaluationError.trim().length > 0
      ) {
        throw new Error(response.status.evaluationError)
      }
      if (response.status?.allowed !== true && response.status?.allowed !== false) {
        const reason =
          typeof response.status?.evaluationError === "string"
            ? response.status.evaluationError
            : typeof response.status?.reason === "string"
              ? response.status.reason
              : "status.allowed was absent"
        throw new Error(reason)
      }
      return { permission, allowed: response.status.allowed }
    }),
  )

  const denied: string[] = []
  const failed: string[] = []
  for (const [index, outcome] of settled.entries()) {
    const permission = permissions[index]
    if (permission === undefined) continue
    const key = permissionKey(permission)
    if (outcome.status === "rejected") {
      failed.push(`${key}: ${failureSummary(outcome.reason)}`)
    } else if (!outcome.value.allowed) {
      denied.push(key)
    }
  }
  if (denied.length > 0 || failed.length > 0) {
    throw new AdministrativePermissionError(denied, failed)
  }
  return permissions
}
