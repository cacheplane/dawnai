import { createHash } from "node:crypto"
import type { SandboxHandle, SandboxPolicy, SandboxProvider } from "@dawn-ai/workspace"
import { sandboxUnavailable } from "../errors.js"
import { createDocker, type Docker, type SpawnResult } from "./docker-cli.js"
import { dockerExec } from "./docker-exec.js"
import { dockerFilesystem } from "./docker-filesystem.js"
import { createThreadLifecycleCoordinator } from "./thread-lifecycle.js"

const ROOT = "/workspace"
const sanitize = (s: string) => s.replaceAll(/[^a-zA-Z0-9_.-]/g, "_")
const containerName = (threadId: string) => `dawn-sbx-${sanitize(threadId)}`
const volumeName = (threadId: string) => `dawn-sbx-vol-${sanitize(threadId)}`

export interface DockerSandboxOptions {
  /** Container image for the sandbox (must include a POSIX shell). */
  readonly image: string
  /** Injected for tests; defaults to the real docker CLI. */
  readonly docker?: Docker
}

interface DockerLaunchConfig {
  readonly networkMode: "none" | "bridge"
  readonly env: readonly (readonly [string, string])[]
  readonly memoryMb: number | null
  readonly cpus: number | null
  readonly dropAllCapabilities: boolean
  readonly noNewPrivileges: boolean
  readonly readOnlyRootFilesystem: boolean
  readonly pidsLimit: number
  readonly user: { readonly uid: number; readonly gid: number } | null
}

interface DockerLifecycleState {
  generation: number
  readonly recoverySignal: AbortSignal
  readonly launchConfig: DockerLaunchConfig
  readonly launchConfigKey: string
  readonly keeperIdentity: string
}

const recoveryAttempt = Symbol("dockerRecoveryAttempt")

interface DockerRecoveryAttempt {
  readonly [recoveryAttempt]: true
  readonly state: DockerLifecycleState
  readonly generation: number
}

function resolveLaunchConfig(policy: SandboxPolicy): DockerLaunchConfig {
  const sec = policy.security ?? {}
  const user =
    sec.runAsNonRoot === false
      ? null
      : typeof sec.runAsNonRoot === "object" && sec.runAsNonRoot !== null
        ? Object.freeze({ uid: sec.runAsNonRoot.uid, gid: sec.runAsNonRoot.gid })
        : Object.freeze({ uid: 1000, gid: 1000 })
  const effectiveEnv = new Map(Object.entries(policy.env ?? {}))
  if (user !== null) effectiveEnv.set("HOME", ROOT)
  const env = Object.freeze(
    [...effectiveEnv.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => Object.freeze([key, value] as const)),
  )

  // timeoutMs is intentionally handle-local: it changes exec cancellation,
  // not the keeper container that is shared by every handle for a thread.
  return Object.freeze({
    networkMode: policy.network.mode === "deny" ? "none" : "bridge",
    env,
    memoryMb: policy.resources?.memoryMb ? policy.resources.memoryMb : null,
    cpus: policy.resources?.cpus ? policy.resources.cpus : null,
    dropAllCapabilities: sec.dropAllCapabilities ?? true,
    noNewPrivileges: sec.noNewPrivileges ?? true,
    readOnlyRootFilesystem: sec.readOnlyRootFilesystem ?? true,
    pidsLimit: sec.pidsLimit ?? 512,
    user,
  })
}

const launchConfigKey = (config: DockerLaunchConfig) => JSON.stringify(config)

const keeperIdentity = (image: string, config: DockerLaunchConfig) =>
  createHash("sha256")
    .update(JSON.stringify({ image, launchConfig: config }))
    .digest("hex")

const isDawnCodedError = (error: unknown): error is Error & { readonly code: string } =>
  error instanceof Error &&
  typeof (error as Error & { code?: unknown }).code === "string" &&
  /^DAWN_E\d{4}$/.test((error as Error & { code: string }).code)

/**
 * Docker reference SandboxProvider. Per thread: a persistent container
 * `dawn-sbx-<threadId>` (sleep infinity) with a named volume mounted at
 * /workspace. acquire() reuses only a keeper owned by this provider lifecycle
 * with a matching persisted identity; otherwise it replaces the keeper while
 * preserving the volume. release() removes the container but KEEPS the volume;
 * destroy() removes both. Network: deny → --network none (exact); allow →
 * bridge (denylist is best-effort and NOT enforced here — see the spec's
 * honest-scope note). Host env is never inherited; only policy.env is passed.
 */
export function dockerSandbox(opts: DockerSandboxOptions): SandboxProvider {
  const docker = opts.docker ?? createDocker()
  const lifecycleStates = new Map<string, DockerLifecycleState>()
  const lifecycle = createThreadLifecycleCoordinator()

  const createLifecycleState = (launchConfig: DockerLaunchConfig): DockerLifecycleState => ({
    generation: 0,
    recoverySignal: new AbortController().signal,
    launchConfig,
    launchConfigKey: launchConfigKey(launchConfig),
    keeperIdentity: keeperIdentity(opts.image, launchConfig),
  })

  const isRecoveryAttempt = (token: unknown): token is DockerRecoveryAttempt =>
    typeof token === "object" && token !== null && recoveryAttempt in token

  const recoveryError = (threadId: string, phase: "removal" | "recreation", error: unknown) => {
    if (isDawnCodedError(error)) return error
    const detail = error instanceof Error ? error.message : String(error)
    const wrapped = sandboxUnavailable(
      `Sandbox unavailable: Docker PID recovery ${phase} failed for thread "${threadId}": ${detail || "unknown error"}. Run \`dawn check\`.`,
    )
    Object.defineProperty(wrapped, "cause", { value: error, configurable: true })
    return wrapped
  }

  const ensureContainer = async (
    threadId: string,
    launchConfig: DockerLaunchConfig,
    expectedIdentity: string,
    signal: AbortSignal,
    reuseExisting: boolean,
  ): Promise<string> => {
    const name = containerName(threadId)
    const running = await docker.run(["ps", "-q", "--filter", `name=^${name}$`], { signal })
    const runningId = running.stdout.trim()
    const existing = runningId
      ? running
      : await docker.run(["ps", "-aq", "--filter", `name=^${name}$`], { signal })
    if (existing.stdout.trim()) {
      if (reuseExisting) {
        const inspected = await docker.run(
          ["inspect", "--format", '{{ index .Config.Labels "dawn.sandbox.identity" }}', name],
          { signal },
        )
        if (inspected.exitCode === 0 && inspected.stdout.trim() === expectedIdentity) {
          if (runningId) return name
          const started = await docker.run(["start", name], { signal })
          if (started.exitCode !== 0) {
            throw sandboxUnavailable(
              `Sandbox unavailable: could not start keeper for thread "${threadId}": ${started.stderr.trim() || "unknown error"}. Run \`dawn check\`.`,
            )
          }
          return name
        }
      }

      const removed = await docker.run(["rm", "-f", name], { signal })
      if (removed.exitCode !== 0) {
        throw sandboxUnavailable(
          `Sandbox unavailable: could not replace stale keeper for thread "${threadId}": ${removed.stderr.trim() || "unknown error"}. Run \`dawn check\`.`,
        )
      }
    }
    const net = ["--network", launchConfig.networkMode]
    const envArgs = launchConfig.env.flatMap(([key, value]) => ["-e", `${key}=${value}`])
    const limits = [
      ...(launchConfig.memoryMb !== null ? ["--memory", `${launchConfig.memoryMb}m`] : []),
      ...(launchConfig.cpus !== null ? ["--cpus", String(launchConfig.cpus)] : []),
    ]
    const user = launchConfig.user

    const hardening: string[] = [
      ...(launchConfig.dropAllCapabilities ? ["--cap-drop", "ALL"] : []),
      ...(launchConfig.noNewPrivileges ? ["--security-opt", "no-new-privileges"] : []),
      "--pids-limit",
      String(launchConfig.pidsLimit),
      ...(launchConfig.readOnlyRootFilesystem
        ? ["--read-only", "--tmpfs", "/tmp", "--tmpfs", "/run"]
        : []),
      ...(user !== null ? ["--user", `${user.uid}:${user.gid}`] : []),
    ]

    // Architecture B (no steady-state root): a fresh named volume mounts
    // root:root, so a non-root keeper cannot write /workspace. Fix it with a
    // CREATE-ONLY, VOLUME-ABSENCE-CHECKED, ephemeral (`--rm`) root chown — the
    // only root that ever runs, and it takes no agent input. On reattach (the
    // volume already exists) this is skipped so a populated volume is never
    // re-chowned. Skipped entirely when runAsNonRoot:false (`user` is null).
    // The inspect→chown is not atomic, but chown is idempotent, so two racing
    // acquires for the same fresh thread both converge on the same ownership.
    if (user !== null) {
      const volExists = await docker.run(["volume", "inspect", volumeName(threadId)], { signal })
      if (volExists.exitCode !== 0) {
        const init = await docker.run(
          [
            "run",
            "--rm",
            "--user",
            "0:0",
            "-v",
            `${volumeName(threadId)}:${ROOT}`,
            opts.image,
            "sh",
            "-c",
            `mkdir -p ${ROOT} && chown ${user.uid}:${user.gid} ${ROOT}`,
          ],
          { signal },
        )
        if (init.exitCode !== 0) {
          throw sandboxUnavailable(
            `Sandbox unavailable: could not initialize workspace ownership for thread "${threadId}": ${init.stderr.trim() || "unknown error"}. Run \`dawn check\`.`,
          )
        }
      }
    }

    const created = await docker.run(
      [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        `dawn.sandbox=${sanitize(threadId)}`,
        "--label",
        `dawn.sandbox.identity=${expectedIdentity}`,
        "-v",
        `${volumeName(threadId)}:${ROOT}`,
        ...net,
        ...envArgs,
        ...limits,
        ...hardening,
        opts.image,
        "sleep",
        "infinity",
      ],
      { signal },
    )
    if (created.exitCode !== 0) {
      throw sandboxUnavailable(
        `Sandbox unavailable: docker run failed for thread "${threadId}": ${created.stderr.trim() || "unknown error"}. Run \`dawn check\`.`,
      )
    }
    return name
  }

  const recoverAndRetry = async (
    threadId: string,
    token: unknown,
    retry: () => Promise<SpawnResult>,
  ) =>
    lifecycle.runExclusive(threadId, async () => {
      if (!isRecoveryAttempt(token)) return undefined
      const { state, generation } = token
      if (lifecycleStates.get(threadId) !== state || generation > state.generation) {
        return undefined
      }

      if (generation === state.generation) {
        // Removal and recreation are provider lifecycle work. They use a
        // provider-owned non-aborted signal so cancellation of one caller
        // cannot strand the shared thread without a keeper.
        const signal = state.recoverySignal
        try {
          const removed = await docker
            .run(["rm", "-f", containerName(threadId)], { signal })
            .catch((error: unknown) => {
              throw recoveryError(threadId, "removal", error)
            })
          if (removed.exitCode !== 0) {
            throw sandboxUnavailable(
              `Sandbox unavailable: could not remove PID-exhausted container for thread "${threadId}": ${removed.stderr.trim() || "unknown error"}. Run \`dawn check\`.`,
            )
          }
          await ensureContainer(
            threadId,
            state.launchConfig,
            state.keeperIdentity,
            signal,
            false,
          ).catch((error: unknown) => {
            throw recoveryError(threadId, "recreation", error)
          })
          state.generation = generation + 1
        } catch (error) {
          if (lifecycleStates.get(threadId) === state) lifecycleStates.delete(threadId)
          throw error
        }
      }

      return retry()
    })

  return {
    name: "docker",
    acquire({ threadId, policy, signal }): Promise<SandboxHandle> {
      return lifecycle.runExclusive(threadId, async () => {
        const requestedLaunchConfig = resolveLaunchConfig(policy)
        const requestedLaunchConfigKey = launchConfigKey(requestedLaunchConfig)
        const existingState = lifecycleStates.get(threadId)
        if (
          existingState !== undefined &&
          existingState.launchConfigKey !== requestedLaunchConfigKey
        ) {
          throw sandboxUnavailable(
            `Sandbox unavailable: thread "${threadId}" already has a different keeper configuration. Release the thread sandbox first, then acquire it with a different policy.`,
          )
        }

        const launchConfig = existingState?.launchConfig ?? requestedLaunchConfig
        const state = existingState ?? createLifecycleState(launchConfig)
        const container = await ensureContainer(
          threadId,
          launchConfig,
          state.keeperIdentity,
          signal,
          existingState !== undefined,
        )
        lifecycleStates.set(threadId, state)
        const pidExhaustionRecovery = {
          captureToken: (): DockerRecoveryAttempt => ({
            [recoveryAttempt]: true,
            state,
            generation: state.generation,
          }),
          recoverAndRetry: (token: unknown, retry: () => Promise<SpawnResult>) =>
            recoverAndRetry(threadId, token, retry),
        }
        return {
          threadId,
          filesystem: dockerFilesystem(docker, container, {
            runWithExecLease: (operation) => lifecycle.runShared(threadId, operation),
            pidExhaustionRecovery,
          }),
          exec: dockerExec(docker, container, {
            runWithExecLease: (operation) => lifecycle.runShared(threadId, operation),
            ...(policy.resources?.timeoutMs !== undefined
              ? { timeoutMs: policy.resources.timeoutMs }
              : {}),
            pidExhaustionRecovery,
          }),
          workspaceRoot: ROOT,
        }
      })
    },
    release(threadId) {
      return lifecycle.runExclusive(threadId, async () => {
        lifecycleStates.delete(threadId)
        await docker.run(["rm", "-f", containerName(threadId)]).catch(() => {})
      })
    },
    destroy(threadId) {
      return lifecycle.runExclusive(threadId, async () => {
        lifecycleStates.delete(threadId)
        await docker.run(["rm", "-f", containerName(threadId)]).catch(() => {})
        await docker.run(["volume", "rm", volumeName(threadId)]).catch(() => {})
      })
    },
    async preflight() {
      const v = await docker
        .run(["version", "--format", "{{.Server.Version}}"])
        .catch(() => undefined)
      if (!v || v.exitCode !== 0) {
        return { ok: false, detail: "Docker daemon not reachable (`docker version` failed)." }
      }
      return { ok: true, detail: `Docker ${v.stdout.trim()}` }
    },
  }
}
