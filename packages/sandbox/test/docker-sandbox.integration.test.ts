import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { createDocker, type Docker, type SpawnResult } from "../src/docker/docker-cli.ts"
import { dockerSandbox } from "../src/index.ts"
import { runProviderConformance } from "../src/testing/index.ts"

// Real-Docker lane. Runs ONLY when DAWN_TEST_DOCKER=1 (the dedicated CI job
// sets it; the default validate lane never does). Locally: DAWN_TEST_DOCKER=1
// with a running Docker daemon.
const enabled = process.env.DAWN_TEST_DOCKER === "1"
const IMAGE = "node:22-slim"
const ctx = (workspaceRoot: string) => ({ signal: new AbortController().signal, workspaceRoot })
const policyDeny = { network: { mode: "deny" } } as const
const pollIntervalMs = 100

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function pollCommand(
  command: () => Promise<SpawnResult>,
  accept: (result: SpawnResult) => boolean,
  deadlineMs: number,
): Promise<SpawnResult> {
  const deadline = Date.now() + deadlineMs
  let lastResult: SpawnResult | undefined
  do {
    lastResult = await command()
    if (accept(lastResult)) return lastResult
    await wait(pollIntervalMs)
  } while (Date.now() < deadline)

  throw new Error(
    `Docker command did not reach the expected state within ${deadlineMs}ms; last result: ${JSON.stringify(lastResult)}`,
  )
}

async function waitForContainerFile(
  docker: Docker,
  container: string,
  containerPath: string,
  deadlineMs: number,
): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "dawn-pids-ready-"))
  const destination = join(temporaryDirectory, "ready")
  const deadline = Date.now() + deadlineMs
  let lastCopy: SpawnResult | undefined

  try {
    do {
      await rm(destination, { force: true })
      lastCopy = await docker.run(["cp", `${container}:${containerPath}`, destination])
      if (lastCopy.exitCode === 0) return await readFile(destination, "utf8")
      await wait(pollIntervalMs)
    } while (Date.now() < deadline)

    const [state, pids] = await Promise.all([
      docker.run(["inspect", "--format", "{{json .State}}", container]),
      docker.run(["stats", "--no-stream", "--format", "{{.PIDs}}", container]),
    ])
    throw new Error(
      `PID saturation was not ready within ${deadlineMs}ms; last copy: ${JSON.stringify(lastCopy)}; container state: ${state.stdout.trim() || state.stderr.trim()}; observed PIDs: ${pids.stdout.trim() || pids.stderr.trim()}`,
    )
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function keeperId(docker: Docker, container: string): Promise<string> {
  const result = await docker.run(["inspect", "--format", "{{.Id}}", container])
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not inspect keeper ${container}: ${JSON.stringify(result)}`)
  }
  return result.stdout.trim()
}

describe.skipIf(!enabled)("dockerSandbox (real Docker)", { timeout: 120_000 }, () => {
  runProviderConformance({
    name: "dockerSandbox",
    makeProvider: () => dockerSandbox({ image: IMAGE }),
    describe,
  })

  test("network deny blocks egress (curl/wget fails inside)", { timeout: 120_000 }, async () => {
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `net-${randomUUID()}`
    try {
      const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      // node:22-slim has node; use node's fetch with a short timeout — no curl dependency.
      const r = await h.exec.runCommand(
        {
          command: `node -e "fetch('https://registry.npmjs.org/', {signal: AbortSignal.timeout(5000)}).then(()=>{console.log('REACHED');process.exit(0)}).catch(()=>{console.log('BLOCKED');process.exit(7)})"`,
        },
        ctx(h.workspaceRoot),
      )
      expect(r.exitCode).toBe(7)
      expect(r.stdout).toContain("BLOCKED")
    } finally {
      await p.destroy(threadId)
    }
  })

  test("host filesystem is untouched by sandbox writes", { timeout: 120_000 }, async () => {
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `host-${randomUUID()}`
    try {
      const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      await h.filesystem.writeFile(
        `${h.workspaceRoot}/host-check.txt`,
        "sandboxed",
        ctx(h.workspaceRoot),
      )
      expect(
        await h.filesystem.readFile(`${h.workspaceRoot}/host-check.txt`, ctx(h.workspaceRoot)),
      ).toBe("sandboxed")
      expect(existsSync("/workspace/host-check.txt")).toBe(false)
      expect(existsSync(`${process.cwd()}/workspace/host-check.txt`)).toBe(false)
    } finally {
      await p.destroy(threadId)
    }
  })

  test("restart durability: release then reacquire reattaches the volume", {
    timeout: 180_000,
  }, async () => {
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `dur-${randomUUID()}`
    try {
      const h1 = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      await h1.filesystem.writeFile(`${h1.workspaceRoot}/persist.txt`, "v1", ctx(h1.workspaceRoot))
      await p.release(threadId) // container gone, volume kept
      const h2 = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      expect(
        await h2.filesystem.readFile(`${h2.workspaceRoot}/persist.txt`, ctx(h2.workspaceRoot)),
      ).toBe("v1")
    } finally {
      await p.destroy(threadId)
    }
  })

  // Adversarial hardening conformance: these tests actually attempt the abuse
  // (fork bomb, /etc write, non-root escalation, timeout overrun) and assert
  // containment. fakeSandbox can't enforce kernel controls (caps/pids/
  // read-only/non-root), so these properties are Docker-lane-only.

  test("hardened defaults contain a fork bomb (pids-limit)", { timeout: 180_000 }, async () => {
    const pidsLimit = 32
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `fork-${randomUUID()}`
    try {
      const h = await p.acquire({
        threadId,
        policy: { ...policyDeny, security: { pidsLimit } },
        signal: ctx("/").signal,
      })
      const successMarker = "SPAWN_STORM_COMPLETED"
      const storm = `
        const { spawn } = require("node:child_process")
        const attempts = Array.from({ length: ${pidsLimit * 4} }, () => new Promise((resolve) => {
          const child = spawn("sleep", ["2"], { stdio: "ignore" })
          child.once("spawn", () => resolve(true))
          child.once("error", () => resolve(false))
        }))
        Promise.all(attempts).then((started) => {
          const rejected = started.filter((value) => !value).length
          if (rejected === 0) {
            console.log("${successMarker}")
          } else {
            console.error("SPAWN_STORM_BLOCKED:" + rejected)
            process.exitCode = 42
          }
        })
      `
      const r = await h.exec.runCommand(
        { command: `node -e ${shellQuote(storm)}` },
        ctx(h.workspaceRoot),
      )
      expect(r.exitCode).not.toBe(0)
      expect(r.stdout).not.toContain(successMarker)
      expect(r.stderr).toContain("SPAWN_STORM_BLOCKED:")

      const alive = await pollCommand(
        () => h.exec.runCommand({ command: "echo alive" }, ctx(h.workspaceRoot)),
        (result) => result.exitCode === 0 && result.stdout.trim() === "alive",
        10_000,
      )
      expect(alive).toMatchObject({ exitCode: 0, stdout: "alive\n" })
    } finally {
      await p.destroy(threadId)
    }
  })

  test("recycles a PID-exhausted keeper and preserves its workspace", {
    timeout: 180_000,
  }, async () => {
    const pidsLimit = 32
    const recoveryCommands = 24
    const docker = createDocker()
    const p = dockerSandbox({ image: IMAGE, docker })
    const threadId = `pid-recovery-${randomUUID()}`
    const container = `dawn-sbx-${threadId}`
    const readinessPath = "/workspace/.pids-ready.json"
    const sentinelPath = "/workspace/pid-recovery-sentinel.txt"
    const sentinel = `sentinel-${randomUUID()}`

    try {
      const h = await p.acquire({
        threadId,
        policy: { ...policyDeny, security: { pidsLimit } },
        signal: ctx("/").signal,
      })
      await h.filesystem.writeFile(sentinelPath, sentinel, ctx(h.workspaceRoot))
      const originalKeeperId = await keeperId(docker, container)
      const saturator = `
        const { writeFileSync } = require("node:fs")
        const { Worker } = require("node:worker_threads")
        let started = 0
        let settled = false
        const workers = []
        const keepAlive = setInterval(() => {}, 1000)
        const deadline = setTimeout(() => {
          writeFileSync("${readinessPath}", JSON.stringify({ status: "failed", reason: "deadline", started }))
          clearInterval(keepAlive)
          process.exit(88)
        }, 5000)

        function fail(reason, error) {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          writeFileSync("${readinessPath}", JSON.stringify({ status: "failed", reason, code: error && error.code, started }))
          clearInterval(keepAlive)
          process.exit(89)
        }

        function launch() {
          if (settled) return
          if (started >= ${pidsLimit * 4}) {
            fail("attempt-limit")
            return
          }
          let worker
          try {
            worker = new Worker("setInterval(() => {}, 1000)", { eval: true })
          } catch (error) {
            const message = String(error && error.message)
            if (error.code !== "ERR_WORKER_INIT_FAILED" || !message.includes("EAGAIN")) {
              fail("unexpected-worker-error", error)
              return
            }
            settled = true
            clearTimeout(deadline)
            writeFileSync("${readinessPath}", JSON.stringify({ status: "ready", code: error.code, message, started }))
            return
          }
          worker.once("online", () => {
            workers.push(worker)
            started += 1
            launch()
          })
          worker.once("error", (error) => fail("worker-runtime-error", error))
        }

        launch()
      `
      const detached = await docker.run(["exec", "-d", container, "node", "-e", saturator])
      expect(detached).toMatchObject({ exitCode: 0 })

      const readiness = JSON.parse(
        await waitForContainerFile(docker, container, readinessPath, 10_000),
      ) as { code?: unknown; message?: unknown; started?: unknown; status?: unknown }
      expect(readiness).toMatchObject({ status: "ready", code: "ERR_WORKER_INIT_FAILED" })
      expect(readiness.message).toEqual(expect.stringContaining("EAGAIN"))
      expect(readiness.started).toEqual(expect.any(Number))
      const saturatedPids = await docker.run([
        "stats",
        "--no-stream",
        "--format",
        "{{.PIDs}}",
        container,
      ])
      expect(saturatedPids).toMatchObject({ exitCode: 0, stdout: `${pidsLimit}\n` })

      // Docker Desktop may admit a single exec task into a full cgroup. A bounded
      // concurrent wave makes OCI startup contend at the limit; the keeper-ID
      // assertion proves that at least one command actually triggered recovery.
      const recovered = await Promise.all(
        Array.from({ length: recoveryCommands }, (_, index) =>
          h.exec.runCommand({ command: `echo recovered-${index}` }, ctx(h.workspaceRoot)),
        ),
      )
      const replacementKeeperId = await keeperId(docker, container)
      expect(recovered).toEqual(
        Array.from({ length: recoveryCommands }, (_, index) => ({
          exitCode: 0,
          stderr: "",
          stdout: `recovered-${index}\n`,
        })),
      )
      expect(
        replacementKeeperId,
        `keeper did not recycle; command results: ${JSON.stringify(recovered)}`,
      ).not.toBe(originalKeeperId)
      const persisted = await h.filesystem.readFile(sentinelPath, ctx(h.workspaceRoot))
      expect(persisted).toBe(sentinel)
    } finally {
      await p.destroy(threadId)
    }
  })

  test("read-only root blocks /etc writes; workspace + /tmp writable", {
    timeout: 120_000,
  }, async () => {
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `ro-${randomUUID()}`
    try {
      const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      const etc = await h.exec.runCommand(
        { command: "echo x > /etc/dawn-probe" },
        ctx(h.workspaceRoot),
      )
      expect(etc.exitCode).not.toBe(0)
      const ws = await h.exec.runCommand(
        { command: "echo x > /workspace/probe && echo ok" },
        ctx(h.workspaceRoot),
      )
      expect(ws.stdout).toContain("ok")
      const tmp = await h.exec.runCommand(
        { command: "echo x > /tmp/probe && echo ok" },
        ctx(h.workspaceRoot),
      )
      expect(tmp.stdout).toContain("ok")
    } finally {
      await p.destroy(threadId)
    }
  })

  test("runs as non-root by default", { timeout: 120_000 }, async () => {
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `nr-${randomUUID()}`
    try {
      const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      const r = await h.exec.runCommand({ command: "id -u" }, ctx(h.workspaceRoot))
      expect(r.stdout.trim()).toBe("1000")
    } finally {
      await p.destroy(threadId)
    }
  })

  test("per-command timeout kills the in-container process (exit 124)", {
    timeout: 120_000,
  }, async () => {
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `to-${randomUUID()}`
    try {
      const h = await p.acquire({
        threadId,
        policy: { network: { mode: "deny" }, resources: { timeoutMs: 500 } },
        signal: ctx("/").signal,
      })
      const r = await h.exec.runCommand({ command: "sleep 999" }, ctx(h.workspaceRoot))
      expect(r.exitCode).toBe(124)
      const ps = await h.exec.runCommand(
        { command: "ps -e -o args= 2>/dev/null | grep -c 'sleep 999' || true" },
        ctx(h.workspaceRoot),
      )
      expect(ps.stdout.trim()).toBe("0")
    } finally {
      await p.destroy(threadId)
    }
  })
})
