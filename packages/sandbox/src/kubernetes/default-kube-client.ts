/** Default KubeClient backed by the real @kubernetes/client-node (v1.x) API.
 * KubeConfig.loadFromDefault() auto-detects in-cluster ServiceAccount token vs
 * ~/.kube/config. Unit tests never construct this — they inject a fake KubeClient. */

import { Readable, Writable } from "node:stream"
import {
  ApiException,
  AuthorizationV1Api,
  CoreV1Api,
  Exec,
  KubeConfig,
  NetworkingV1Api,
  type V1NetworkPolicy,
  type V1PersistentVolumeClaim,
  type V1Pod,
  type V1PodSecurityContext,
  type V1SecurityContext,
  type V1Status,
} from "@kubernetes/client-node"
import type {
  KubeClient,
  KubeNetworkPolicySpec,
  KubePodSpec,
  KubePvcSpec,
  PodPhase,
} from "./kube-client.js"

const CONTAINER_NAME = "sandbox"

function statusCode(error: unknown): number | undefined {
  return error instanceof ApiException ? error.code : undefined
}

/** Writable sink that accumulates written chunks into a single string, for
 * capturing exec stdout/stderr without piping to a real stream destination. */
function collect(): { readonly stream: Writable; text(): string } {
  const chunks: Buffer[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      callback()
    },
  })
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") }
}

function toPodManifest(namespace: string, s: KubePodSpec): V1Pod {
  const mounts = [
    { name: "workspace", mountPath: "/workspace" },
    ...(s.readOnlyRootFilesystem
      ? [
          { name: "tmp", mountPath: "/tmp" },
          { name: "run", mountPath: "/run" },
        ]
      : []),
  ]
  const volumes = [
    { name: "workspace", persistentVolumeClaim: { claimName: s.pvcName } },
    ...(s.readOnlyRootFilesystem
      ? [
          { name: "tmp", emptyDir: {} },
          { name: "run", emptyDir: {} },
        ]
      : []),
  ]
  return {
    metadata: { name: s.name, namespace, labels: { ...s.labels } },
    spec: {
      restartPolicy: "Always",
      automountServiceAccountToken: s.automountServiceAccountToken,
      securityContext: s.podSecurityContext as V1PodSecurityContext,
      containers: [
        {
          name: CONTAINER_NAME,
          image: s.image,
          command: ["sleep", "infinity"],
          env: s.env.map((e) => ({ name: e.name, value: e.value })),
          securityContext: s.containerSecurityContext as V1SecurityContext,
          ...(Object.keys(s.limits).length > 0 ? { resources: { limits: { ...s.limits } } } : {}),
          volumeMounts: mounts,
        },
      ],
      volumes,
    },
  }
}

function toPvcManifest(s: KubePvcSpec): V1PersistentVolumeClaim {
  return {
    metadata: { name: s.name, labels: { ...s.labels } },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: `${s.storageGi}Gi` } },
      ...(s.storageClass ? { storageClassName: s.storageClass } : {}),
    },
  }
}

/** `mode` is always "deny" in this provider (allow-mode emits no policy). Deny =
 * block all egress except a DNS carve-out plus any allowlisted CIDRs. The manifest
 * below encodes ONLY deny semantics — guard against a future allow-mode caller. */
function toNetworkPolicyManifest(s: KubeNetworkPolicySpec): V1NetworkPolicy {
  if (s.mode !== "deny") {
    throw new Error(`toNetworkPolicyManifest only builds deny-mode policies; got mode "${s.mode}".`)
  }
  // Scope DNS egress to the cluster-DNS namespace (CoreDNS lives in kube-system).
  // Without a `to:` selector the rule would allow port-53 traffic to ANY host,
  // opening a DNS-tunneling exfiltration path out of the deny-mode sandbox.
  const dnsEgress = {
    to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }],
    ports: [
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 53 },
    ],
  }
  const cidrEgress = (s.allowlist ?? []).map((cidr) => ({ to: [{ ipBlock: { cidr } }] }))
  return {
    metadata: { name: s.name, labels: { ...s.labels } },
    spec: {
      podSelector: { matchLabels: { "dawn.sh/thread": s.threadLabelValue } },
      policyTypes: ["Egress"],
      egress: [dnsEgress, ...cidrEgress],
    },
  }
}

/** Parses the exec status callback's V1Status into an exit code. Success -> 0;
 * Failure with an ExitCode cause -> that code; anything else -> 1 (best-effort). */
function exitCodeFromStatus(status: V1Status | undefined): number {
  if (!status || status.status === "Success") return 0
  const cause = status.details?.causes?.find((c) => c.reason === "ExitCode")
  if (cause?.message !== undefined) {
    const n = Number.parseInt(cause.message, 10)
    if (!Number.isNaN(n)) return n
  }
  return 1
}

export function createDefaultKubeClient(): KubeClient {
  const kc = new KubeConfig()
  kc.loadFromDefault()
  const core = kc.makeApiClient(CoreV1Api)
  const networking = kc.makeApiClient(NetworkingV1Api)
  const authorization = kc.makeApiClient(AuthorizationV1Api)
  const execClient = new Exec(kc)

  return {
    async readNamespacedPodPhase(ns, name): Promise<PodPhase | null> {
      try {
        const pod = await core.readNamespacedPod({ name, namespace: ns })
        return (pod.status?.phase as PodPhase | undefined) ?? "Unknown"
      } catch (error) {
        if (statusCode(error) === 404) return null
        throw error
      }
    },

    async createNamespacedPod(ns, spec): Promise<void> {
      await core.createNamespacedPod({ namespace: ns, body: toPodManifest(ns, spec) })
    },

    async deleteNamespacedPod(ns, name, opts): Promise<void> {
      try {
        await core.deleteNamespacedPod({
          name,
          namespace: ns,
          ...(opts?.gracePeriodSeconds !== undefined
            ? { gracePeriodSeconds: opts.gracePeriodSeconds }
            : {}),
        })
      } catch (error) {
        if (statusCode(error) === 404) return
        throw error
      }
    },

    async createNamespacedPvcIfAbsent(ns, spec): Promise<void> {
      try {
        await core.createNamespacedPersistentVolumeClaim({
          namespace: ns,
          body: toPvcManifest(spec),
        })
      } catch (error) {
        if (statusCode(error) === 409) return
        throw error
      }
    },

    async deleteNamespacedPvc(ns, name): Promise<void> {
      try {
        await core.deleteNamespacedPersistentVolumeClaim({ name, namespace: ns })
      } catch (error) {
        if (statusCode(error) === 404) return
        throw error
      }
    },

    async pvcExists(ns, name): Promise<boolean> {
      try {
        await core.readNamespacedPersistentVolumeClaim({ name, namespace: ns })
        return true
      } catch (error) {
        if (statusCode(error) === 404) return false
        throw error
      }
    },

    async upsertNamespacedNetworkPolicy(ns, spec): Promise<void> {
      const body = toNetworkPolicyManifest(spec)
      try {
        await networking.createNamespacedNetworkPolicy({ namespace: ns, body })
      } catch (error) {
        if (statusCode(error) === 409) {
          await networking.replaceNamespacedNetworkPolicy({ name: spec.name, namespace: ns, body })
          return
        }
        throw error
      }
    },

    async deleteNamespacedNetworkPolicy(ns, name): Promise<void> {
      try {
        await networking.deleteNamespacedNetworkPolicy({ name, namespace: ns })
      } catch (error) {
        if (statusCode(error) === 404) return
        throw error
      }
    },

    async exec(ns, pod, argv, opts = {}) {
      const stdout = collect()
      const stderr = collect()
      let settledStatus: V1Status | undefined
      // The library sends a close-stdin frame when the readable ends, giving the
      // in-pod process (e.g. `cat > file`) a clean EOF. null = no stdin.
      const stdin = opts.stdin !== undefined ? Readable.from(Buffer.from(opts.stdin, "utf8")) : null

      const signal = opts.signal
      // `ws` is untyped (the resolved WebSocket has no shipped types); track it so
      // an abort can close the socket and tear down the orphaned in-pod process.
      let socket: { close(): void } | undefined
      let settled = false

      await new Promise<void>((resolve, reject) => {
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          signal?.removeEventListener("abort", onAbort)
          fn()
        }
        const onAbort = (): void => {
          socket?.close()
          finish(() => reject(new Error("Kubernetes exec aborted.")))
        }

        if (signal?.aborted) {
          onAbort()
          return
        }
        signal?.addEventListener("abort", onAbort, { once: true })

        execClient
          .exec(
            ns,
            pod,
            CONTAINER_NAME,
            [...argv],
            stdout.stream,
            stderr.stream,
            stdin,
            false,
            (status) => {
              settledStatus = status
            },
          )
          .then((ws) => {
            socket = ws
            // Aborted between scheduling and connecting: close the fresh socket.
            if (signal?.aborted) {
              ws.close()
              return
            }
            ws.on("close", () => finish(() => resolve()))
            ws.on("error", (event: unknown) => {
              finish(() =>
                reject(event instanceof Error ? event : new Error("Kubernetes exec socket error.")),
              )
            })
          })
          .catch((error: unknown) => finish(() => reject(error)))
      })

      return {
        stdout: stdout.text(),
        stderr: stderr.text(),
        // The library fires the status callback before `close` on a normal exit,
        // so an undefined status at close means the socket died abnormally (pod
        // OOMKill mid-exec, network drop). Report that as a failure, not success.
        exitCode: settledStatus === undefined ? 1 : exitCodeFromStatus(settledStatus),
      }
    },

    async canI(ns, verb, resource): Promise<boolean> {
      const review = await authorization.createSelfSubjectAccessReview({
        body: {
          spec: {
            resourceAttributes: { namespace: ns, verb, resource },
          },
        },
      })
      return review.status?.allowed === true
    },

    async networkPolicyEnforced(ns): Promise<boolean | "unknown"> {
      // Listing NetworkPolicy objects only proves the API is present, not that a
      // CNI enforces them — we cannot portably introspect the CNI, so treat a
      // successful list as inconclusive rather than a confirmed "true".
      try {
        await networking.listNamespacedNetworkPolicy({ namespace: ns })
        return "unknown"
      } catch {
        return false
      }
    },
  }
}
