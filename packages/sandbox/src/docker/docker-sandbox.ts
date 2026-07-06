import type { SandboxHandle, SandboxPolicy, SandboxProvider } from "@dawn-ai/workspace"
import { createDocker, type Docker } from "./docker-cli.js"
import { dockerExec } from "./docker-exec.js"
import { dockerFilesystem } from "./docker-filesystem.js"

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
        "-w",
        ROOT,
        ...net,
        ...envArgs,
        ...limits,
        opts.image,
        "sleep",
        "infinity",
      ],
      { signal },
    )
    if (created.exitCode !== 0) {
      throw new Error(
        `Sandbox unavailable: docker run failed for thread "${threadId}": ${created.stderr.trim() || "unknown error"}. Run \`dawn check\`.`,
      )
    }
    return name
  }

  return {
    name: "docker",
    async acquire({ threadId, policy, signal }): Promise<SandboxHandle> {
      const container = await ensureContainer(threadId, policy, signal)
      return {
        threadId,
        filesystem: dockerFilesystem(docker, container),
        exec: dockerExec(
          docker,
          container,
          policy.resources?.timeoutMs !== undefined
            ? { timeoutMs: policy.resources.timeoutMs }
            : {},
        ),
        workspaceRoot: ROOT,
      }
    },
    async release(threadId) {
      await docker.run(["rm", "-f", containerName(threadId)]).catch(() => {})
    },
    async destroy(threadId) {
      await docker.run(["rm", "-f", containerName(threadId)]).catch(() => {})
      await docker.run(["volume", "rm", volumeName(threadId)]).catch(() => {})
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
