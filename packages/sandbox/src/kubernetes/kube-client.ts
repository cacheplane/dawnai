/** Narrow Kubernetes API seam the provider needs. Default impl (later task) wraps
 * @kubernetes/client-node; unit tests inject a fake. Pod/PVC/NetworkPolicy specs
 * are the minimal shapes this provider sets — NOT the full k8s object types. */

export interface KubePodSpec {
  readonly name: string
  readonly image: string
  readonly labels: Readonly<Record<string, string>>
  readonly pvcName: string
  readonly env: readonly { readonly name: string; readonly value: string }[]
  readonly limits: Readonly<Record<string, string>> // e.g. { memory: "512Mi", cpu: "1" }
  readonly podSecurityContext: Readonly<Record<string, unknown>>
  readonly containerSecurityContext: Readonly<Record<string, unknown>>
  readonly readOnlyRootFilesystem: boolean // gates the /tmp,/run emptyDir mounts
  readonly automountServiceAccountToken: boolean
}

export interface KubePvcSpec {
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  readonly storageGi: number
  readonly storageClass?: string
}

export interface KubeNetworkPolicySpec {
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  readonly threadLabelValue: string // podSelector matches dawn.sh/thread=<value>
  readonly mode: "deny" | "allow"
  readonly allowlist?: readonly string[] // CIDRs, allow mode only
}

export type KubePermission =
  | {
      readonly apiGroup: ""
      readonly resource: "pods"
      readonly subresource?: never
      readonly verb: "create" | "get" | "delete"
    }
  | {
      readonly apiGroup: ""
      readonly resource: "pods"
      readonly subresource: "exec"
      readonly verb: "create" | "get"
    }
  | {
      readonly apiGroup: ""
      readonly resource: "persistentvolumeclaims"
      readonly subresource?: never
      readonly verb: "create" | "get" | "delete"
    }
  | {
      readonly apiGroup: "networking.k8s.io"
      readonly resource: "networkpolicies"
      readonly subresource?: never
      readonly verb: "create" | "get" | "list" | "update" | "delete"
    }

export const REQUIRED_KUBE_PERMISSIONS = [
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

export class KubeAuthorizationReviewError extends Error {
  readonly kind: "api" | "transport"

  constructor(kind: "api" | "transport", message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "KubeAuthorizationReviewError"
    this.kind = kind
  }
}

export type PodPhase = "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown"

export interface KubeClient {
  readNamespacedPodPhase(ns: string, name: string): Promise<PodPhase | null> // null = 404
  createNamespacedPod(ns: string, spec: KubePodSpec): Promise<void>
  deleteNamespacedPod(
    ns: string,
    name: string,
    opts?: { readonly gracePeriodSeconds?: number },
  ): Promise<void>
  createNamespacedPvcIfAbsent(ns: string, spec: KubePvcSpec): Promise<void>
  deleteNamespacedPvc(ns: string, name: string): Promise<void>
  /** Existence probe: true if the PVC is still present (including Terminating). */
  pvcExists(ns: string, name: string): Promise<boolean>
  upsertNamespacedNetworkPolicy(ns: string, spec: KubeNetworkPolicySpec): Promise<void>
  deleteNamespacedNetworkPolicy(ns: string, name: string): Promise<void>
  exec(
    ns: string,
    pod: string,
    argv: readonly string[],
    opts?: { readonly stdin?: string; readonly signal?: AbortSignal },
  ): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>
  /** SelfSubjectAccessReview probe for preflight. */
  canI(namespace: string, permission: KubePermission): Promise<boolean>
  /** Whether a NetworkPolicy-enforcing CNI is present; "unknown" if undetectable. */
  networkPolicyEnforced(ns: string): Promise<boolean | "unknown">
}
