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

interface DockerLifecycleState {
  generation: number
  recoverySignal: AbortSignal
}

const recoveryAttempt = Symbol("dockerRecoveryAttempt")

interface DockerRecoveryAttempt {
  readonly [recoveryAttempt]: true
  readonly state: DockerLifecycleState
  readonly generation: number
}

/**
 * Docker reference SandboxProvider. Per thread: a persistent container
 * `dawn-sbx-<threadId>` (sleep infinity) with a named volume mounted at
 * /workspace. acquire() is create-or-reattach (running → reuse; stopped →
 * start; absent → run). release() removes the container but KEEPS the volume;
 * destroy() removes both. Network: deny → --network none (exact); allow →
 * bridge (denylist is best-effort and NOT enforced here — see the spec's
 * honest-scope note). Host env is never inherited; only policy.env is passed.
 */
export function dockerSandbox(opts: DockerSandboxOptions): SandboxProvider {
  const docker = opts.docker ?? createDocker()
  const lifecycleStates = new Map<string, DockerLifecycleState>()
  const lifecycle = createThreadLifecycleCoordinator()

  const createLifecycleState = (): DockerLifecycleState => ({
    generation: 0,
    recoverySignal: new AbortController().signal,
  })

  const isRecoveryAttempt = (token: unknown): token is DockerRecoveryAttempt =>
    typeof token === "object" && token !== null && recoveryAttempt in token

  const ensureContainer = async (
    threadId: string,
    policy: SandboxPolicy,
    signal: AbortSignal,
  ): Promise<string> => {
    const name = containerName(threadId)
    const running = await docker.run(["ps", "-q", "--filter", `name=^${name}$`], { signal })
    if (running.stdout.trim()) return name
    const existing = await docker.run(["ps", "-aq", "--filter", `name=^${name}$`], { signal })
    if (existing.stdout.trim()) {
      await docker.run(["start", name], { signal })
      return name
    }
    const net = policy.network.mode === "deny" ? ["--network", "none"] : ["--network", "bridge"]
    const envArgs = Object.entries(policy.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`])
    const res = policy.resources
    const limits = [
      ...(res?.memoryMb ? ["--memory", `${res.memoryMb}m`] : []),
      ...(res?.cpus ? ["--cpus", String(res.cpus)] : []),
    ]

    // Hardened-by-default posture: an unset field means SECURE default, not
    // "off". Authors relax explicitly via policy.security. `user` is resolved
    // here (rather than inline in the argv) so a later create-path addition
    // (volume chown-init) can reuse the same resolved uid/gid.
    const sec = policy.security ?? {}
    const dropCaps = sec.dropAllCapabilities ?? true
    const noNewPriv = sec.noNewPrivileges ?? true
    const readOnly = sec.readOnlyRootFilesystem ?? true
    const pids = sec.pidsLimit ?? 512
    const user: { uid: number; gid: number } | undefined =
      sec.runAsNonRoot === false
        ? undefined
        : // `typeof null === "object"`, so guard against it explicitly — a raw-parsed
          // config could carry null (the TS type excludes it); fail SAFE to the
          // hardened non-root default rather than silently running as the image's root.
          typeof sec.runAsNonRoot === "object" && sec.runAsNonRoot !== null
          ? sec.runAsNonRoot
          : { uid: 1000, gid: 1000 }

    const hardening: string[] = [
      ...(dropCaps ? ["--cap-drop", "ALL"] : []),
      ...(noNewPriv ? ["--security-opt", "no-new-privileges"] : []),
      "--pids-limit",
      String(pids),
      ...(readOnly ? ["--read-only", "--tmpfs", "/tmp", "--tmpfs", "/run"] : []),
      ...(user ? ["--user", `${user.uid}:${user.gid}`, "-e", "HOME=/workspace"] : []),
    ]

    // Architecture B (no steady-state root): a fresh named volume mounts
    // root:root, so a non-root keeper cannot write /workspace. Fix it with a
    // CREATE-ONLY, VOLUME-ABSENCE-CHECKED, ephemeral (`--rm`) root chown — the
    // only root that ever runs, and it takes no agent input. On reattach (the
    // volume already exists) this is skipped so a populated volume is never
    // re-chowned. Skipped entirely when runAsNonRoot:false (`user` undefined).
    // The inspect→chown is not atomic, but chown is idempotent, so two racing
    // acquires for the same fresh thread both converge on the same ownership.
    if (user) {
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
    policy: SandboxPolicy,
    token: unknown,
    retry: () => Promise<SpawnResult>,
  ) =>
    lifecycle.run(threadId, async () => {
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
          const removed = await docker.run(["rm", "-f", containerName(threadId)], { signal })
          if (removed.exitCode !== 0) {
            throw sandboxUnavailable(
              `Sandbox unavailable: could not remove PID-exhausted container for thread "${threadId}": ${removed.stderr.trim() || "unknown error"}. Run \`dawn check\`.`,
            )
          }
          await ensureContainer(threadId, policy, signal)
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
      return lifecycle.run(threadId, async () => {
        const container = await ensureContainer(threadId, policy, signal)
        const state = lifecycleStates.get(threadId) ?? createLifecycleState()
        lifecycleStates.set(threadId, state)
        return {
          threadId,
          filesystem: dockerFilesystem(docker, container),
          exec: dockerExec(docker, container, {
            ...(policy.resources?.timeoutMs !== undefined
              ? { timeoutMs: policy.resources.timeoutMs }
              : {}),
            pidExhaustionRecovery: {
              captureToken: (): DockerRecoveryAttempt => ({
                [recoveryAttempt]: true,
                state,
                generation: state.generation,
              }),
              recoverAndRetry: (token, retry) => recoverAndRetry(threadId, policy, token, retry),
            },
          }),
          workspaceRoot: ROOT,
        }
      })
    },
    release(threadId) {
      return lifecycle.run(threadId, async () => {
        lifecycleStates.delete(threadId)
        await docker.run(["rm", "-f", containerName(threadId)]).catch(() => {})
      })
    },
    destroy(threadId) {
      return lifecycle.run(threadId, async () => {
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
