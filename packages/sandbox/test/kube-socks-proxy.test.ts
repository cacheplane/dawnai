import dns from "node:dns"
import { once } from "node:events"
import { readFileSync, realpathSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { createRequire } from "node:module"
import type { Server as NetServer } from "node:net"
import { createServer as createNetServer, Socket } from "node:net"
import { dirname, join, sep } from "node:path"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"

const loopback = "127.0.0.1"
const sentinelHostname = "dawn-kube-socks.invalid"
const expectedVersion = {
  buildDate: "2026-08-10T00:00:00Z",
  compiler: "gc",
  gitCommit: "0123456789abcdef",
  gitTreeState: "clean",
  gitVersion: "v1.35.0-test",
  goVersion: "go1.25.0",
  major: "1",
  minor: "35",
  platform: "linux/amd64",
}
const expectedBody = JSON.stringify(expectedVersion)
const proxyEnvironmentKeys = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const

const maxHandshakeBytes = 512
const maxHttpBodyBytes = 4 * 1024
const maxTunnelBytesPerDirection = 32 * 1024
const caseDeadlineMs = 5_000
const cleanupDeadlineMs = 1_000
const proxyCaseTestTimeoutMs = caseDeadlineMs + 2 * cleanupDeadlineMs + 1_000

type KubernetesClient = typeof import("@kubernetes/client-node")

interface PackageManifest {
  dependencies?: Record<string, string>
  name: string
  version: string
}

interface PackageIdentity {
  entryPath: string
  manifest: PackageManifest
  manifestPath: string
}

interface SocksChainOverrides {
  logicalClientManifestPath?: string
  sandboxManifest?: PackageManifest
}

interface ProxyObservation {
  address: string
  addressType: "domain" | "ipv4"
  port: number
  upstreamRemoteAddress: string
  upstreamRemoteFamily: string
}

interface TargetObservation {
  body: string
  host: string
  method: string
  url: string
}

let kubernetesClient: KubernetesClient | undefined

class ProxyEnvironmentGuard {
  private readonly saved = new Map<string, string | undefined>()
  private captured = false
  private restored = false

  constructor(private readonly environment: NodeJS.ProcessEnv) {}

  captureAndClear(): void {
    if (this.captured) {
      throw new Error("Proxy environment was captured more than once")
    }
    this.captured = true
    for (const key of proxyEnvironmentKeys) {
      this.saved.set(key, this.environment[key])
    }
    for (const key of proxyEnvironmentKeys) {
      delete this.environment[key]
    }
  }

  restore(): void {
    if (!this.captured || this.restored) {
      throw new Error("Proxy environment restoration must run exactly once")
    }
    this.restored = true
    for (const key of proxyEnvironmentKeys) {
      delete this.environment[key]
    }
    for (const key of proxyEnvironmentKeys) {
      const value = this.saved.get(key)
      if (value !== undefined) {
        this.environment[key] = value
      }
    }
  }

  restoreIfNeeded(): void {
    if (this.captured && !this.restored) {
      this.restore()
    }
  }
}

const proxyEnvironmentGuard = new ProxyEnvironmentGuard(process.env)

beforeAll(async () => {
  proxyEnvironmentGuard.captureAndClear()
  try {
    kubernetesClient = await import("@kubernetes/client-node")
  } catch (error) {
    proxyEnvironmentGuard.restore()
    throw error
  }
})

afterAll(() => {
  proxyEnvironmentGuard.restoreIfNeeded()
})

function readManifest(manifestPath: string): PackageManifest {
  const value: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error(`Invalid package manifest: ${manifestPath}`)
  }
  return value as PackageManifest
}

function packageIdentity(specifier: string, anchor: string | URL): PackageIdentity {
  const anchoredRequire = createRequire(anchor)
  const manifestPath = realpathSync(anchoredRequire.resolve(`${specifier}/package.json`))
  const entryPath = realpathSync(anchoredRequire.resolve(specifier))
  const packageRoot = `${dirname(manifestPath)}${sep}`
  if (!entryPath.startsWith(packageRoot)) {
    throw new Error(`${specifier} entry escaped its package root`)
  }
  return { entryPath, manifest: readManifest(manifestPath), manifestPath }
}

function childPackageIdentity(parent: PackageIdentity, childName: string): PackageIdentity {
  const declaration = parent.manifest.dependencies?.[childName]
  if (typeof declaration !== "string" || declaration.length === 0) {
    throw new Error(`${parent.manifest.name} does not declare ${childName}`)
  }

  const child = packageIdentity(childName, parent.manifestPath)
  const pnpmMarker = `${sep}node_modules${sep}.pnpm${sep}`
  const snapshotStart = parent.manifestPath.indexOf(pnpmMarker)
  const snapshotNodeModulesStart = parent.manifestPath.indexOf(
    `${sep}node_modules${sep}`,
    snapshotStart + pnpmMarker.length,
  )
  if (snapshotStart < 0 || snapshotNodeModulesStart < 0) {
    throw new Error(`${parent.manifest.name} was not installed in the expected pnpm snapshot`)
  }
  const snapshotNodeModules = parent.manifestPath.slice(
    0,
    snapshotNodeModulesStart + `${sep}node_modules`.length,
  )
  const logicalManifestPath = realpathSync(
    join(snapshotNodeModules, ...childName.split("/"), "package.json"),
  )
  if (logicalManifestPath !== child.manifestPath) {
    throw new Error(`${parent.manifest.name} resolved ${childName} outside its own dependency link`)
  }
  return child
}

function resolveSocksDependencyChain(overrides: SocksChainOverrides = {}) {
  const sandboxAppRoot = realpathSync(new URL("..", import.meta.url))
  const sandboxManifestPath = realpathSync(new URL("../package.json", import.meta.url))
  const sandboxManifest = overrides.sandboxManifest ?? readManifest(sandboxManifestPath)
  const clientNode = packageIdentity("@kubernetes/client-node", sandboxManifestPath)
  const logicalClientManifestPath =
    overrides.logicalClientManifestPath ??
    realpathSync(join(sandboxAppRoot, "node_modules", "@kubernetes", "client-node", "package.json"))
  if (sandboxManifest.dependencies?.["@kubernetes/client-node"] !== "^1.4.0") {
    throw new Error("@dawn-ai/sandbox must declare @kubernetes/client-node as ^1.4.0")
  }
  if (
    sandboxManifest.name !== "@dawn-ai/sandbox" ||
    sandboxManifestPath !== join(sandboxAppRoot, "package.json")
  ) {
    throw new Error("sandbox manifest is not rooted at the sandbox app root")
  }
  if (
    clientNode.manifest.name !== "@kubernetes/client-node" ||
    logicalClientManifestPath !== clientNode.manifestPath
  ) {
    throw new Error("sandbox physical @kubernetes/client-node edge does not match")
  }
  const socksProxyAgent = childPackageIdentity(clientNode, "socks-proxy-agent")
  const socks = childPackageIdentity(socksProxyAgent, "socks")
  const ipAddress = childPackageIdentity(socks, "ip-address")
  return {
    clientNode,
    ipAddress,
    sandbox: {
      appRoot: sandboxAppRoot,
      logicalClientManifestPath,
      manifest: sandboxManifest,
      manifestPath: sandboxManifestPath,
    },
    socks,
    socksProxyAgent,
  }
}

function caseInsensitiveEnvironment(initial: Record<string, string>): NodeJS.ProcessEnv {
  const values = new Map<string, string>()
  for (const [key, value] of Object.entries(initial)) {
    values.set(key.toUpperCase(), value)
  }
  return new Proxy<NodeJS.ProcessEnv>(
    {},
    {
      deleteProperty(_target, property) {
        if (typeof property === "string") {
          values.delete(property.toUpperCase())
        }
        return true
      },
      get(_target, property) {
        return typeof property === "string" ? values.get(property.toUpperCase()) : undefined
      },
      set(_target, property, value) {
        if (typeof property !== "string") {
          return false
        }
        values.set(property.toUpperCase(), String(value))
        return true
      },
    },
  )
}

class DeadlineTimers {
  readonly active = new Set<NodeJS.Timeout>()
  drainCalls = 0
  leakedAtDrain = 0

  arm(deadline: number, onDeadline: () => void, label: string): () => void {
    const delay = deadline - Date.now()
    if (delay <= 0) {
      throw new Error(`${label} exceeded its absolute deadline`)
    }

    let armed = true
    const timer = setTimeout(() => {
      if (!armed) {
        return
      }
      armed = false
      this.active.delete(timer)
      onDeadline()
    }, delay)
    this.active.add(timer)

    return () => {
      if (!armed) {
        return
      }
      armed = false
      clearTimeout(timer)
      this.active.delete(timer)
    }
  }

  drain(): void {
    this.drainCalls += 1
    if (this.drainCalls !== 1) {
      throw new Error("Deadline timers were drained more than once")
    }
    this.leakedAtDrain = this.active.size
    for (const timer of this.active) {
      clearTimeout(timer)
    }
    this.active.clear()
  }
}

async function onceBeforeDeadline(
  emitter: NodeJS.EventEmitter,
  event: string,
  deadline: number,
  timers: DeadlineTimers,
  label: string,
): Promise<unknown[]> {
  const controller = new AbortController()
  const disarm = timers.arm(
    deadline,
    () => controller.abort(new Error(`${label} exceeded its absolute deadline`)),
    label,
  )
  try {
    return await once(emitter, event, { signal: controller.signal })
  } finally {
    disarm()
  }
}

async function promiseBeforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  timers: DeadlineTimers,
  label: string,
): Promise<T> {
  let rejectDeadline: ((error: Error) => void) | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const disarm = timers.arm(
    deadline,
    () => rejectDeadline?.(new Error(`${label} exceeded its absolute deadline`)),
    label,
  )
  try {
    return await Promise.race([operation, timeout])
  } finally {
    disarm()
  }
}

async function observeBeforeDeadline(
  operation: Promise<unknown>,
  deadline: number,
  timers: DeadlineTimers,
  label: string,
): Promise<Error | undefined> {
  try {
    await promiseBeforeDeadline(operation, deadline, timers, label)
    return undefined
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

class TrackedServer {
  readonly activeSockets = new Set<Socket>()
  readonly allSockets = new Set<Socket>()
  closeCalls = 0
  port = 0

  constructor(
    readonly label: string,
    readonly server: NetServer,
    readonly errors: Error[],
  ) {
    server.on("connection", (socket) => this.trackSocket(socket))
    server.on("error", (error) => this.errors.push(error))
  }

  trackSocket(socket: Socket): void {
    if (this.allSockets.has(socket)) {
      return
    }
    this.allSockets.add(socket)
    this.activeSockets.add(socket)
    socket.on("error", (error) => this.errors.push(error))
    socket.once("close", () => this.activeSockets.delete(socket))
  }

  async listen(deadline: number, timers: DeadlineTimers): Promise<void> {
    const listening = onceBeforeDeadline(
      this.server,
      "listening",
      deadline,
      timers,
      `${this.label} listen`,
    )
    this.server.listen({ exclusive: true, host: loopback, port: 0 })
    await listening
    const address = this.server.address()
    if (typeof address !== "object" || address === null || address.address !== loopback) {
      throw new Error(`${this.label} did not bind to IPv4 loopback`)
    }
    this.port = address.port
  }

  async close(_operationDeadline: number, timers: DeadlineTimers): Promise<void> {
    this.closeCalls += 1
    if (this.closeCalls !== 1) {
      throw new Error(`${this.label} was closed more than once`)
    }

    const activeSockets = [...this.activeSockets]
    const closedSockets = activeSockets.map((socket) => once(socket, "close"))
    for (const socket of activeSockets) {
      socket.destroy()
    }

    let serverClosed: Promise<void> = Promise.resolve()
    if (this.server.listening) {
      serverClosed = new Promise<void>((resolve, reject) => {
        this.server.close((error) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      })
    }

    const cleanupDeadline = Date.now() + cleanupDeadlineMs
    const failures = (
      await Promise.all([
        ...closedSockets.map((closed, index) =>
          observeBeforeDeadline(
            closed,
            cleanupDeadline,
            timers,
            `${this.label} socket ${index + 1} cleanup`,
          ),
        ),
        observeBeforeDeadline(
          serverClosed,
          cleanupDeadline,
          timers,
          `${this.label} server cleanup`,
        ),
      ])
    ).filter((error): error is Error => error !== undefined)
    if (failures.length > 0) {
      throw new AggregateError(failures, `${this.label} cleanup did not settle`)
    }
  }
}

class BoundedSocketReader {
  private buffered = Buffer.alloc(0)
  private bytesSeen = 0
  private released = false

  constructor(
    private readonly socket: Socket,
    private readonly deadline: number,
    private readonly timers: DeadlineTimers,
  ) {
    socket.pause()
  }

  async read(length: number, label: string): Promise<Buffer> {
    if (this.released || !Number.isSafeInteger(length) || length < 0) {
      throw new Error(`Invalid bounded SOCKS read for ${label}`)
    }

    while (this.buffered.length < length) {
      const dataPromise = onceBeforeDeadline(this.socket, "data", this.deadline, this.timers, label)
      this.socket.resume()
      let values: unknown[]
      try {
        values = await dataPromise
      } finally {
        this.socket.pause()
      }
      const value = values[0]
      if (!Buffer.isBuffer(value)) {
        throw new Error(`${label} returned a non-buffer chunk`)
      }
      this.bytesSeen += value.length
      if (this.bytesSeen > maxHandshakeBytes) {
        throw new Error("SOCKS handshake exceeded its byte limit")
      }
      this.buffered = Buffer.concat([this.buffered, value])
    }

    const result = this.buffered.subarray(0, length)
    this.buffered = this.buffered.subarray(length)
    return result
  }

  release(): Buffer {
    if (this.released) {
      throw new Error("SOCKS reader was released more than once")
    }
    this.released = true
    return this.buffered
  }
}

async function writeBeforeDeadline(
  socket: Socket,
  chunk: Buffer,
  deadline: number,
  timers: DeadlineTimers,
  label: string,
): Promise<void> {
  if (socket.write(chunk)) {
    return
  }
  await onceBeforeDeadline(socket, "drain", deadline, timers, label)
}

function ipv4Address(bytes: Buffer): string {
  if (bytes.length !== 4) {
    throw new Error("Invalid SOCKS IPv4 address length")
  }
  return [...bytes].join(".")
}

function startBoundedTunnel(client: Socket, upstream: Socket, initialClientBytes: Buffer): void {
  let clientBytes = initialClientBytes.length
  let upstreamBytes = 0
  let listenersRemoved = false

  const failIfOverLimit = (direction: string, bytes: number) => {
    if (bytes > maxTunnelBytesPerDirection) {
      const error = new Error(`${direction} tunnel exceeded its byte limit`)
      client.destroy(error)
      upstream.destroy(error)
    }
  }
  const onClientData = (chunk: Buffer) => {
    clientBytes += chunk.length
    failIfOverLimit("client-to-target", clientBytes)
  }
  const onUpstreamData = (chunk: Buffer) => {
    upstreamBytes += chunk.length
    failIfOverLimit("target-to-client", upstreamBytes)
  }
  const removeListeners = () => {
    if (listenersRemoved) {
      return
    }
    listenersRemoved = true
    client.off("data", onClientData)
    upstream.off("data", onUpstreamData)
  }

  client.on("data", onClientData)
  upstream.on("data", onUpstreamData)
  client.once("close", removeListeners)
  upstream.once("close", removeListeners)
  if (initialClientBytes.length > 0) {
    upstream.write(initialClientBytes)
  }
  client.pipe(upstream)
  upstream.pipe(client)
}

function createSocksProxy(
  expectedAddress: string,
  targetPort: number,
  deadline: number,
  timers: DeadlineTimers,
) {
  const errors: Error[] = []
  const observations: ProxyObservation[] = []
  let tracked: TrackedServer
  const server = createNetServer((client) => {
    void (async () => {
      if (observations.length > 0) {
        throw new Error("SOCKS proxy received more than one connection")
      }

      const reader = new BoundedSocketReader(client, deadline, timers)
      const greeting = await reader.read(2, "SOCKS greeting header")
      if (greeting[0] !== 0x05 || greeting[1] === undefined || greeting[1] === 0) {
        throw new Error("Invalid SOCKS5 greeting")
      }
      const methods = await reader.read(greeting[1], "SOCKS greeting methods")
      if (!methods.includes(0x00)) {
        throw new Error("SOCKS client did not offer no-authentication")
      }
      await writeBeforeDeadline(
        client,
        Buffer.from([0x05, 0x00]),
        deadline,
        timers,
        "SOCKS greeting response",
      )

      const requestHeader = await reader.read(4, "SOCKS connect header")
      if (requestHeader[0] !== 0x05 || requestHeader[1] !== 0x01 || requestHeader[2] !== 0x00) {
        throw new Error("Invalid SOCKS5 CONNECT request")
      }

      let address: string
      let addressType: ProxyObservation["addressType"]
      if (requestHeader[3] === 0x01) {
        address = ipv4Address(await reader.read(4, "SOCKS IPv4 address"))
        addressType = "ipv4"
      } else if (requestHeader[3] === 0x03) {
        const length = (await reader.read(1, "SOCKS domain length"))[0]
        if (length === undefined || length === 0) {
          throw new Error("Invalid SOCKS domain length")
        }
        address = (await reader.read(length, "SOCKS domain")).toString("ascii")
        addressType = "domain"
      } else {
        throw new Error("SOCKS request attempted IPv6 or an unsupported address type")
      }

      const portBytes = await reader.read(2, "SOCKS destination port")
      const requestedPort = portBytes.readUInt16BE(0)
      if (address !== expectedAddress || requestedPort !== targetPort) {
        throw new Error(`Unexpected SOCKS destination ${address}:${requestedPort}`)
      }

      const upstream = new Socket()
      tracked.trackSocket(upstream)
      const connected = onceBeforeDeadline(
        upstream,
        "connect",
        deadline,
        timers,
        "SOCKS loopback upstream connect",
      )
      upstream.connect({ host: loopback, port: targetPort })
      await connected
      if (upstream.remoteAddress !== loopback || upstream.remoteFamily !== "IPv4") {
        throw new Error("SOCKS proxy upstream escaped IPv4 loopback")
      }

      observations.push({
        address,
        addressType,
        port: requestedPort,
        upstreamRemoteAddress: upstream.remoteAddress,
        upstreamRemoteFamily: upstream.remoteFamily,
      })
      await writeBeforeDeadline(
        client,
        Buffer.from([
          0x05,
          0x00,
          0x00,
          0x01,
          127,
          0,
          0,
          1,
          (targetPort >> 8) & 0xff,
          targetPort & 0xff,
        ]),
        deadline,
        timers,
        "SOCKS connect response",
      )
      startBoundedTunnel(client, upstream, reader.release())
    })().catch((error: unknown) => {
      errors.push(error instanceof Error ? error : new Error(String(error)))
      client.destroy()
    })
  })
  tracked = new TrackedServer("SOCKS proxy", server, errors)
  return { errors, observations, tracked }
}

function createKubernetesTarget(deadline: number) {
  const errors: Error[] = []
  const observations: TargetObservation[] = []
  const server = createHttpServer(
    {
      headersTimeout: Math.max(1, deadline - Date.now()),
      maxHeaderSize: maxHttpBodyBytes,
      requestTimeout: Math.max(1, deadline - Date.now()),
    },
    (request, response) => {
      const chunks: Buffer[] = []
      let bodyBytes = 0
      request.on("data", (chunk: Buffer) => {
        bodyBytes += chunk.length
        if (bodyBytes > maxHttpBodyBytes) {
          request.destroy(new Error("Kubernetes target request exceeded its byte limit"))
        } else {
          chunks.push(chunk)
        }
      })
      request.on("error", (error) => errors.push(error))
      request.on("end", () => {
        observations.push({
          body: Buffer.concat(chunks).toString("utf8"),
          host: request.headers.host ?? "",
          method: request.method ?? "",
          url: request.url ?? "",
        })
        if (observations.length !== 1 || request.method !== "GET" || request.url !== "/version") {
          response.writeHead(400, { Connection: "close" })
          response.end()
          return
        }
        response.writeHead(200, {
          Connection: "close",
          "Content-Length": Buffer.byteLength(expectedBody),
          "Content-Type": "application/json",
        })
        response.end(expectedBody)
      })
    },
  )
  const tracked = new TrackedServer("Kubernetes target", server, errors)
  return { errors, observations, tracked }
}

function blockAmbientDns() {
  const calls: string[] = []
  const originalDescriptor = Object.getOwnPropertyDescriptor(dns, "lookup")
  if (originalDescriptor === undefined) {
    throw new Error("node:dns.lookup descriptor is unavailable")
  }
  let restoreCalls = 0
  const blockedLookup = ((hostname: string, ...args: unknown[]) => {
    calls.push(hostname)
    const error = Object.assign(new Error(`Ambient DNS lookup blocked for ${hostname}`), {
      code: "ENOTFOUND",
    })
    const callback = args.at(-1)
    if (typeof callback === "function") {
      const lookupCallback = callback as (lookupError: NodeJS.ErrnoException) => void
      lookupCallback(error)
      return
    }
    throw error
  }) as typeof dns.lookup

  Object.defineProperty(dns, "lookup", { ...originalDescriptor, value: blockedLookup })
  return {
    calls,
    get restoreCalls() {
      return restoreCalls
    },
    restore() {
      restoreCalls += 1
      if (restoreCalls !== 1) {
        throw new Error("DNS guard restored more than once")
      }
      Object.defineProperty(dns, "lookup", originalDescriptor)
    },
  }
}

async function runProxyCase(targetHostname: string, addressType: ProxyObservation["addressType"]) {
  if (kubernetesClient === undefined) {
    throw new Error("@kubernetes/client-node was not imported after proxy environment cleanup")
  }

  const deadline = Date.now() + caseDeadlineMs
  const timers = new DeadlineTimers()
  const target = createKubernetesTarget(deadline)
  let proxy: ReturnType<typeof createSocksProxy> | undefined
  let dnsGuard: ReturnType<typeof blockAmbientDns> | undefined
  let caseError: unknown
  const cleanupErrors: unknown[] = []

  try {
    await target.tracked.listen(deadline, timers)
    proxy = createSocksProxy(targetHostname, target.tracked.port, deadline, timers)
    await proxy.tracked.listen(deadline, timers)

    const proxyUrl = `socks5h://${loopback}:${proxy.tracked.port}`
    const targetUrl = new URL(`http://${targetHostname}:${target.tracked.port}/version`)
    const config = new kubernetesClient.KubeConfig()
    config.loadFromOptions({
      clusters: [
        {
          name: "controlled-cluster",
          proxyUrl,
          server: targetUrl.origin,
          skipTLSVerify: true,
        },
      ],
      contexts: [
        {
          cluster: "controlled-cluster",
          name: "controlled-context",
          user: "controlled-user",
        },
      ],
      currentContext: "controlled-context",
      users: [{ name: "controlled-user" }],
    })
    expect(config.getCurrentCluster()).toEqual({
      name: "controlled-cluster",
      proxyUrl,
      server: targetUrl.origin,
      skipTLSVerify: true,
    })

    dnsGuard = blockAmbientDns()
    const versionApi = config.makeApiClient(kubernetesClient.VersionApi)
    const response = await promiseBeforeDeadline(
      versionApi.getCode(),
      deadline,
      timers,
      "Kubernetes VersionApi request",
    )
    expect(Buffer.byteLength(expectedBody)).toBeLessThanOrEqual(maxHttpBodyBytes)
    expect(response).toEqual(expectedVersion)
    expect(proxy.observations).toEqual([
      {
        address: targetHostname,
        addressType,
        port: target.tracked.port,
        upstreamRemoteAddress: loopback,
        upstreamRemoteFamily: "IPv4",
      },
    ])
    expect(target.observations).toEqual([
      {
        body: "",
        host: `${targetHostname}:${target.tracked.port}`,
        method: "GET",
        url: "/version",
      },
    ])
    expect(dnsGuard.calls).toEqual([])
    expect(proxy.errors).toEqual([])
    expect(target.errors).toEqual([])
  } catch (error) {
    caseError = error
  } finally {
    try {
      dnsGuard?.restore()
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (proxy !== undefined) {
      try {
        await proxy.tracked.close(deadline, timers)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await target.tracked.close(deadline, timers)
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      timers.drain()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (caseError !== undefined) {
    cleanupErrors.unshift(caseError)
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "SOCKS smoke or cleanup failed")
  }

  expect(dnsGuard?.restoreCalls).toBe(1)
  expect(proxy?.tracked.closeCalls).toBe(1)
  expect(target.tracked.closeCalls).toBe(1)
  expect(proxy?.tracked.activeSockets.size).toBe(0)
  expect(target.tracked.activeSockets.size).toBe(0)
  expect(timers.drainCalls).toBe(1)
  expect(timers.leakedAtDrain).toBe(0)
}

describe("Kubernetes SOCKS dependency path", () => {
  test("restores proxy aliases in a case-insensitive environment", () => {
    const original = {
      ALL_PROXY: "socks5h://all-proxy.invalid:1080",
      HTTPS_PROXY: "http://https-proxy.invalid:8080",
      HTTP_PROXY: "http://http-proxy.invalid:8080",
      NO_PROXY: "localhost,127.0.0.1",
    }
    const environment = caseInsensitiveEnvironment(original)
    const guard = new ProxyEnvironmentGuard(environment)

    guard.captureAndClear()
    for (const key of proxyEnvironmentKeys) {
      expect(environment[key]).toBeUndefined()
    }

    guard.restore()
    for (const [key, value] of Object.entries(original)) {
      expect(environment[key]).toBe(value)
      expect(environment[key.toLowerCase()]).toBe(value)
    }
  })

  test("rejects a stale sandbox to client-node declaration", () => {
    const sandboxManifest = readManifest(realpathSync(new URL("../package.json", import.meta.url)))
    expect(() =>
      resolveSocksDependencyChain({
        sandboxManifest: {
          ...sandboxManifest,
          dependencies: {
            ...sandboxManifest.dependencies,
            "@kubernetes/client-node": "^1.3.0",
          },
        },
      }),
    ).toThrow(/sandbox must declare @kubernetes\/client-node as \^1\.4\.0/)
  })

  test("rejects a phantom sandbox to client-node physical edge", () => {
    const chain = resolveSocksDependencyChain()
    expect(() =>
      resolveSocksDependencyChain({
        logicalClientManifestPath: join(
          chain.sandbox.appRoot,
          "node_modules",
          "phantom-client-node",
          "package.json",
        ),
      }),
    ).toThrow(/sandbox physical @kubernetes\/client-node edge does not match/)
  })

  test("destroys sockets and attempts server close after the operation deadline expires", async () => {
    const timers = new DeadlineTimers()
    const errors: Error[] = []
    const server = createNetServer()
    const tracked = new TrackedServer("expired-deadline fixture", server, errors)
    const client = new Socket()
    const closeServer = vi.spyOn(server, "close")
    let cleanupCompleted = false

    try {
      const setupDeadline = Date.now() + 2_000
      await tracked.listen(setupDeadline, timers)
      const connected = onceBeforeDeadline(
        client,
        "connect",
        setupDeadline,
        timers,
        "expired-deadline fixture connect",
      )
      const accepted = onceBeforeDeadline(
        server,
        "connection",
        setupDeadline,
        timers,
        "expired-deadline fixture accept",
      )
      client.connect({ host: loopback, port: tracked.port })
      await Promise.all([accepted, connected])
      expect(tracked.activeSockets.size).toBe(1)

      await tracked.close(Date.now() - 1, timers)
      cleanupCompleted = true
      expect(closeServer).toHaveBeenCalledTimes(1)
      expect([...tracked.allSockets].every((socket) => socket.destroyed)).toBe(true)
      expect(server.listening).toBe(false)
      expect(tracked.activeSockets.size).toBe(0)
      expect(errors).toEqual([])
    } finally {
      client.destroy()
      for (const socket of tracked.activeSockets) {
        socket.destroy()
      }
      if (!cleanupCompleted && server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      timers.drain()
      closeServer.mockRestore()
    }
  })

  test(
    "uses the public generated VersionApi operation",
    async () => {
      if (kubernetesClient === undefined) {
        throw new Error("@kubernetes/client-node was not imported")
      }
      const makeApiClient = vi.spyOn(kubernetesClient.KubeConfig.prototype, "makeApiClient")
      const getCode = vi.spyOn(kubernetesClient.VersionApi.prototype, "getCode")
      try {
        await runProxyCase(loopback, "ipv4")
        expect(makeApiClient).toHaveBeenCalledExactlyOnceWith(kubernetesClient.VersionApi)
        expect(getCode).toHaveBeenCalledTimes(1)
      } finally {
        getCode.mockRestore()
        makeApiClient.mockRestore()
      }
    },
    proxyCaseTestTimeoutMs,
  )

  test(
    "uses the real SOCKS path for a literal IPv4 Kubernetes target",
    async () => {
      await runProxyCase(loopback, "ipv4")
    },
    proxyCaseTestTimeoutMs,
  )

  test(
    "resolves a sentinel Kubernetes hostname only inside the SOCKS proxy",
    async () => {
      await runProxyCase(sentinelHostname, "domain")
    },
    proxyCaseTestTimeoutMs,
  )

  test("resolves the patched ip-address through the exact installed dependency chain", () => {
    for (const key of proxyEnvironmentKeys) {
      expect(process.env[key], `${key} must be unset before client imports`).toBeUndefined()
    }

    const chain = resolveSocksDependencyChain()
    expect(chain.sandbox.manifest.name).toBe("@dawn-ai/sandbox")
    expect(chain.sandbox.manifest.dependencies?.["@kubernetes/client-node"]).toBe("^1.4.0")
    expect(chain.sandbox.manifestPath).toBe(join(chain.sandbox.appRoot, "package.json"))
    expect(chain.sandbox.logicalClientManifestPath).toBe(chain.clientNode.manifestPath)
    expect({
      clientNode: {
        declaration: chain.clientNode.manifest.dependencies?.["socks-proxy-agent"],
        version: chain.clientNode.manifest.version,
      },
      socks: {
        declaration: chain.socks.manifest.dependencies?.["ip-address"],
        version: chain.socks.manifest.version,
      },
      socksProxyAgent: {
        declaration: chain.socksProxyAgent.manifest.dependencies?.socks,
        version: chain.socksProxyAgent.manifest.version,
      },
    }).toEqual({
      clientNode: { declaration: "^8.0.4", version: "1.4.0" },
      socks: { declaration: "^10.1.1", version: "2.8.9" },
      socksProxyAgent: { declaration: "^2.8.3", version: "8.0.5" },
    })
    expect(chain.ipAddress.manifest.name).toBe("ip-address")

    const socksRequire = createRequire(chain.socks.entryPath)
    expect(realpathSync(socksRequire.resolve("ip-address"))).toBe(chain.ipAddress.entryPath)
    expect(socksRequire.cache[chain.ipAddress.entryPath]).toBeDefined()
    expect(chain.ipAddress.manifest.version).toBe("10.5.0")
  })
})
