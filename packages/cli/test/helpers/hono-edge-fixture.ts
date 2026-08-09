import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers"
import { expect } from "vitest"

import type { AimockFixture } from "../../../testing/dist/index.js"
import { runBuildCommand } from "../../src/commands/build.js"

// ---------------------------------------------------------------------------
// Shared machinery for the two suites that RUN the emitted `hono` artifacts:
//
//   • `hono-node-roundtrip.test.ts` — ungated, boots `app.mjs` under
//     `@hono/node-server` in a Node child process;
//   • `workerd-lane.test.ts` — gated on DAWN_TEST_WORKERD, boots the very same
//     `app.mjs` under real Cloudflare workerd via `wrangler dev --local`.
//
// They share a fixture app, a container pair, and the AG-UI plumbing precisely
// so the two runtimes are held to the SAME app and the SAME assertions. Keeping
// that here rather than copied twice is what stops the gated lane from quietly
// drifting into an easier test than the ungated one.
// ---------------------------------------------------------------------------

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")

/** The route the fixture serves, and the AG-UI key for it. */
export const ROUTE_KEY = encodeURIComponent("/chat#agent")

/** Requests driven through the emitted entry. Four is the floor, not a target. */
export const TURNS = ["turn one", "turn two", "turn three", "turn four"] as const

/**
 * The WebSocket-to-TCP proxy, pinned by digest rather than `:latest`.
 *
 * The round-trip lane is ungated — it runs on every CI run — so a floating tag
 * would let an upstream push red every pull request at once. The digest is the
 * multi-arch OCI index (linux/amd64 for CI, linux/arm64 for a developer's Mac),
 * verified 2026-08-07.
 */
export const WSPROXY_IMAGE =
  "ghcr.io/neondatabase/wsproxy@sha256:7f2e2149aa6a57ba382a140102fba44f5053f3e44389ccc18adcecf896054efb"

/**
 * Postgres 16-alpine, pinned the same way and for the same reason. The digest
 * is the multi-arch OCI index for the `16-alpine` tag, verified 2026-08-07.
 */
export const POSTGRES_IMAGE =
  "postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777"

// ---------------------------------------------------------------------------
// Docker availability
// ---------------------------------------------------------------------------

export interface DockerStatus {
  readonly available: boolean
  /** Why not, verbatim, so a skip is never a mystery. */
  readonly detail: string
}

/**
 * Is there a reachable Docker daemon?
 *
 * Asked so the ungated round-trip can SKIP rather than fail on a machine
 * without Docker: before this suite existed, `pnpm test` needed Docker for the
 * first time ever, and only the `*-docker` jobs were supposed to.
 *
 * A silent skip is its own hazard, though — a suite that stops running is
 * indistinguishable from one that passes. `DAWN_REQUIRE_DOCKER=1`, which CI
 * sets on the job that runs `pnpm test`, turns the skip back into a hard
 * failure, so the escape hatch cannot become a way to lose the coverage.
 */
export async function probeDocker(): Promise<DockerStatus> {
  try {
    const { stdout } = await promisify(execFile)(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      { timeout: 30_000 },
    )
    const version = stdout.trim()
    if (!version) return { available: false, detail: "`docker version` reported no server version" }
    return { available: true, detail: `docker server ${version}` }
  } catch (error) {
    return {
      available: false,
      detail: error instanceof Error ? error.message.trim() : String(error),
    }
  }
}

/** The message a skipped-but-required run fails with. */
export function requireDockerFailure(status: DockerStatus): Error {
  return new Error(
    "DAWN_REQUIRE_DOCKER=1 is set, so this suite may not skip — but no Docker daemon is " +
      `reachable, so it would have. Start Docker, or unset DAWN_REQUIRE_DOCKER to allow the ` +
      `skip locally. Probe said: ${status.detail}`,
  )
}

// ---------------------------------------------------------------------------
// Containers
//
// Postgres and a WebSocket-to-TCP proxy on one user-defined network. The proxy
// is not scaffolding for the test's convenience: the emitted `stores.mjs`
// connects with `@neondatabase/serverless`, which speaks the Postgres wire
// protocol over a WebSocket, and a stock Postgres does not accept one.
// ---------------------------------------------------------------------------

export interface EdgeContainers {
  readonly network: StartedNetwork
  readonly postgres: StartedPostgreSqlContainer
  readonly wsproxy: StartedTestContainer
  /** Everything Postgres has logged since it started, as it arrives. */
  readonly log: () => string
  readonly stop: () => Promise<void>
}

/**
 * Start the Postgres + wsproxy pair.
 *
 * `ALLOW_ADDR_REGEX` is wide open because the only thing reachable on this
 * network is the database container beside it. `APPEND_PORT` is deliberately
 * NOT set: it concatenates onto the client-supplied address and yields
 * `host:5432host:5432` → "too many colons in address".
 *
 * `log_statement=all` turns the server's own log into an observable for
 * "migrations ran once".
 */
export async function startEdgeContainers(): Promise<EdgeContainers> {
  const network = await new Network().start()
  const postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withNetwork(network)
    .withNetworkAliases("dawn-pg")
    .withCommand(["postgres", "-c", "log_statement=all"])
    .withStartupTimeout(180_000)
    .start()
  let log = ""
  const logs = await postgres.logs()
  logs.on("data", (chunk: unknown) => {
    log += String(chunk)
  })
  const wsproxy = await new GenericContainer(WSPROXY_IMAGE)
    .withNetwork(network)
    .withEnvironment({ ALLOW_ADDR_REGEX: ".*" })
    .withExposedPorts(80)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(180_000)
    .start()

  return {
    log: () => log,
    network,
    postgres,
    stop: async () => {
      await wsproxy.stop().catch(() => {})
      await postgres.stop().catch(() => {})
      await network.stop().catch(() => {})
    },
    wsproxy,
  }
}

/**
 * The bindings a deployed worker receives, built from a started container pair.
 *
 * `DATABASE_URL`'s host is the container-network ALIAS, because the proxy dials
 * it from inside that network; `DAWN_PG_WS_PROXY` is the host-mapped address,
 * because the runtime dials the proxy from outside it. Bare `host:port` with no
 * scheme — `@neondatabase/serverless` prefixes that itself.
 */
export function edgeBindings(
  containers: EdgeContainers,
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const { postgres, wsproxy } = containers
  return {
    DATABASE_URL: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@dawn-pg:5432/${postgres.getDatabase()}`,
    DAWN_PG_WS_PROXY: `${wsproxy.getHost()}:${wsproxy.getMappedPort(80)}`,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Fixture app
// ---------------------------------------------------------------------------

/**
 * Packages the emitted files import by bare specifier, symlinked into the
 * fixture's own `node_modules`.
 *
 * Neither host under test uses vitest's resolver, so every one of these is
 * resolved for real, from `dist`. That is deliberate: it is the same resolution
 * a deployed bundle performs, and it means these suites fail if the published
 * entry points ever stop lining up with what the target emits.
 *
 * THIS LIST IS NOT THE SET OF PACKAGES UNDER TEST. Each entry drags in its own
 * `workspace:` dependencies through its own `node_modules` — `@dawn-ai/cli`
 * alone brings eight, `@dawn-ai/langchain` among them — and those resolve from
 * `dist` just as literally. {@link edgeDistPackages} is the honest inventory.
 */
const LINKED_PACKAGES: readonly (readonly [string, string])[] = [
  // app.mjs + modules.edge.mjs
  ["@dawn-ai/cli", join(repoRoot, "packages", "cli")],
  ["hono", join(repoRoot, "packages", "cli", "node_modules", "hono")],
  ["@hono/node-server", join(repoRoot, "packages", "cli", "node_modules", "@hono", "node-server")],
  // stores.mjs
  ["@dawn-ai/postgres-storage", join(repoRoot, "packages", "postgres-storage")],
  [
    "@neondatabase/serverless",
    join(repoRoot, "packages", "cli", "node_modules", "@neondatabase", "serverless"),
  ],
  // the route module, and the provider package app.mjs's static importer names
  ["@dawn-ai/sdk", join(repoRoot, "packages", "sdk")],
  [
    "@langchain/openai",
    join(repoRoot, "packages", "langchain", "node_modules", "@langchain", "openai"),
  ],
]

// ---------------------------------------------------------------------------
// Freshness of the linked `dist` — READ THIS BEFORE CHANGING ANYTHING BELOW.
//
// These suites run BUILT OUTPUT. `buildFixture` imports `runBuildCommand` from
// `../../src`, and this package's vitest config aliases every `@dawn-ai/*`
// specifier to `src` too — so the build LOGIC is always whatever vitest just
// transformed, while the runtime UNDER TEST is whatever `dist` happens to hold.
// The two can be arbitrarily far apart, and a stale `dist` yields either a red
// or a green that looks completely genuine.
//
// Not hypothetical: during review the workerd lane failed once and could not be
// reproduced. A `dist` built before dccae091 (the compiled-graph-cache fix)
// reproduces that exact failure 5/5, deterministically. Nothing warned.
//
// WHY THIS BUILDS INSTEAD OF ASSERTING ON mtimes. Both were measured:
//
//   • `tsc` rewrites only the outputs whose contents changed, so on a perfectly
//     current tree the OLDEST `dist` mtime is routinely older than the NEWEST
//     `src` mtime. The obvious assertion is red on a correct checkout.
//   • `touch`ing a source file without changing its contents leaves turbo's
//     hash unchanged, so `turbo run build` reports FULL TURBO and does not
//     rewrite `dist` at all. An mtime guard tripped by an editor save, a
//     `git stash pop`, or a reverted edit would tell the reader to run
//     `pnpm build` — and running it would not clear the failure. A guard that
//     its own remediation cannot satisfy gets deleted by the next person, which
//     is worse than no guard.
//
// Building is a guarantee rather than an inference, it has no false positive to
// misfire on, and it is cheap: ~200ms once turbo is warm, ~3.5s from cold.
// ---------------------------------------------------------------------------

/**
 * The packages these suites enter through. Everything else is reached from
 * here by following `workspace:` edges, which is the whole point — see
 * {@link edgeDistPackages}.
 */
const DIST_ROOT_PACKAGES: readonly string[] = [
  // Linked into the fixture by LINKED_PACKAGES, so the emitted files resolve
  // their `dist` for real.
  "@dawn-ai/cli",
  "@dawn-ai/postgres-storage",
  "@dawn-ai/sdk",
  // Imported straight out of `dist` by the suites themselves (aimock).
  "@dawn-ai/testing",
]

interface WorkspacePackage {
  /** Does it emit a `dist` at all? `config-*` do not. */
  readonly builds: boolean
  readonly deps: readonly string[]
  readonly dir: string
}

/** Every `packages/*` manifest, by package name. */
async function readWorkspacePackages(): Promise<Map<string, WorkspacePackage>> {
  const packagesDir = join(repoRoot, "packages")
  const entries = await readdir(packagesDir, { withFileTypes: true })
  const packages = new Map<string, WorkspacePackage>()
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = join(packagesDir, entry.name)
        const manifestPath = join(dir, "package.json")
        if (!existsSync(manifestPath)) return
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          dependencies?: Record<string, string>
          name?: unknown
          peerDependencies?: Record<string, string>
          scripts?: Record<string, unknown>
        }
        if (typeof manifest.name !== "string") return
        const deps = [
          ...Object.entries(manifest.dependencies ?? {}),
          ...Object.entries(manifest.peerDependencies ?? {}),
        ]
          .filter(([, range]) => range.startsWith("workspace:"))
          .map(([name]) => name)
        packages.set(manifest.name, {
          builds: typeof manifest.scripts?.build === "string",
          deps,
          dir,
        })
      }),
  )
  return packages
}

/**
 * The workspace packages whose `dist` these suites actually execute: the roots
 * above plus the transitive closure of their `workspace:` dependencies.
 *
 * DERIVED RATHER THAN LISTED, on purpose. `@dawn-ai/langchain` appears nowhere
 * in {@link LINKED_PACKAGES} — it arrives through `packages/cli/node_modules`,
 * one edge down from `@dawn-ai/cli` — so a reader auditing that list would not
 * even know it is in play. It is also the package whose stale `dist` produced
 * the phantom review failure. A hand-maintained list would have missed it; a
 * closure cannot.
 */
export async function edgeDistPackages(): Promise<readonly { dir: string; name: string }[]> {
  const packages = await readWorkspacePackages()
  const reached = new Set<string>()
  const queue = [...DIST_ROOT_PACKAGES]
  while (queue.length > 0) {
    const name = queue.pop()
    if (name === undefined || reached.has(name)) continue
    const workspacePackage = packages.get(name)
    if (workspacePackage === undefined) {
      throw new Error(
        `${name} is depended on with the \`workspace:\` protocol but is not a package in ` +
          `${join(repoRoot, "packages")}. The dist-freshness guard cannot resolve the closure.`,
      )
    }
    reached.add(name)
    queue.push(...workspacePackage.deps)
  }

  // The invariant this guard exists for. If the closure ever stops reaching
  // langchain — a dropped dependency edge, a rewritten walk — the guard has
  // silently stopped covering the only case anyone has actually been burned by,
  // and would go on passing while doing nothing.
  if (!reached.has("@dawn-ai/langchain")) {
    throw new Error(
      "the dist-freshness closure no longer reaches @dawn-ai/langchain, whose stale `dist` is " +
        "the failure this guard was written for. Check the `workspace:` dependency edges from " +
        `${DIST_ROOT_PACKAGES.join(", ")}.`,
    )
  }

  return [...reached]
    .map((name) => ({ name, workspacePackage: packages.get(name) }))
    .filter((entry) => entry.workspacePackage?.builds === true)
    .map((entry) => ({ dir: entry.workspacePackage?.dir ?? "", name: entry.name }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Memoized per worker process: three suites, at most one build each. */
let linkedDistsFresh: Promise<void> | undefined

/**
 * Bring every `dist` these suites resolve up to date with `src`, so the runtime
 * under test is the code in the working tree.
 *
 * Called by {@link createFixtureApp}, which is the one door all three suites go
 * through, so no suite can forget it. A contributor who has never run
 * `pnpm build` gets a build rather than a failure; a contributor whose `src`
 * does not compile gets the compiler's own output and the command to re-run.
 */
export function ensureLinkedDistsFresh(): Promise<void> {
  linkedDistsFresh ??= buildLinkedDists()
  return linkedDistsFresh
}

async function buildLinkedDists(): Promise<void> {
  const packages = await edgeDistPackages()
  const turbo = join(repoRoot, "node_modules", ".bin", "turbo")
  if (!existsSync(turbo)) {
    throw new Error(`no turbo at ${turbo} — run \`pnpm install\` at the repo root.`)
  }

  // `--output-logs=errors-only` so a failure's message is the compiler's
  // diagnostics and nothing else: at full verbosity turbo replays the cached
  // logs of every task that PASSED, and the one line that matters ends up
  // buried thirty lines deep.
  const args = [
    "run",
    "build",
    "--output-logs=errors-only",
    ...packages.map(({ name }) => `--filter=${name}`),
  ]
  try {
    await promisify(execFile)(turbo, args, {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 900_000,
    })
  } catch (error) {
    const { stderr, stdout } = error as { stderr?: string; stdout?: string }
    const output = `${stdout ?? ""}${stderr ?? ""}`.trim().split("\n").slice(-40).join("\n")
    throw new Error(
      "these suites run BUILT OUTPUT, and building it failed — so there is no `dist` worth " +
        `testing. Fix the build, then re-run. Command: \`pnpm build\` (this ran \`turbo ` +
        `${args.join(" ")}\` from ${repoRoot}).\n\n${output}`,
    )
  }

  // Cheap cross-check that the filter really produced outputs, in case turbo's
  // `outputs` globs ever drift away from `dist/**`.
  for (const { dir, name } of packages) {
    if (!existsSync(join(dir, "dist"))) {
      throw new Error(
        `${name} reported a successful build but has no \`dist\` at ${join(dir, "dist")}. ` +
          "Run `pnpm build` at the repo root.",
      )
    }
  }
}

/**
 * Create a one-route Dawn app configured for the `hono` target, with every
 * runtime package linked in. Returns its root; the caller disposes it.
 */
export async function createFixtureApp(prefix: string): Promise<string> {
  // Before anything is linked: make the `dist` about to be linked current.
  await ensureLinkedDistsFresh()

  // realpath: macOS tmpdir sits behind a /var → /private/var symlink and the
  // loader resolves module URLs to real paths — keep every path resolved.
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), prefix)))

  const files: Record<string, string> = {
    "dawn.config.ts": 'export default { build: { targets: ["hono"] } }\n',
    "package.json": `${JSON.stringify({
      dependencies: {
        "@dawn-ai/cli": "workspace:*",
        "@dawn-ai/postgres-storage": "workspace:*",
        "@neondatabase/serverless": "^1.1.0",
        hono: "^4.12.28",
      },
      name: "hono-edge-fixture",
      type: "module",
    })}\n`,
    "src/app/chat/index.ts": `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "Answer questions.",
})
`,
  }
  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )

  for (const [name, target] of LINKED_PACKAGES) {
    if (!existsSync(target)) throw new Error(`fixture dependency not installed: ${target}`)
    const linkPath = join(appRoot, "node_modules", ...name.split("/"))
    await mkdir(dirname(linkPath), { recursive: true })
    await symlink(target, linkPath, "dir")
  }

  return appRoot
}

export const removeFixtureApp = (appRoot: string): Promise<void> =>
  rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 })

/** Build the fixture with the `hono` target, returning `.dawn/build`. */
export async function buildFixture(appRoot: string): Promise<string> {
  await runBuildCommand({ clean: true, cwd: appRoot }, { stderr: () => {}, stdout: () => {} })
  const buildDir = join(appRoot, ".dawn", "build")
  for (const name of ["app.mjs", "stores.mjs", "modules.edge.mjs"]) {
    expect(existsSync(join(buildDir, name))).toBe(true)
  }
  return buildDir
}

// ---------------------------------------------------------------------------
// Driving turns
// ---------------------------------------------------------------------------

export const AGUI_HEADERS = {
  accept: "text/event-stream",
  "content-type": "application/json",
} as const

/** One AG-UI turn's request body. */
export function aguiBody(threadId: string, userMessage: string, index: number): string {
  return JSON.stringify({
    context: [],
    forwardedProps: {},
    messages: [{ content: userMessage, id: `u${index}`, role: "user" }],
    runId: `rn-${index}`,
    state: {},
    threadId,
    tools: [],
  })
}

/** Parse an SSE body (`data: <json>\n\n` frames) into event payloads. */
export function parseSseEvents(text: string): unknown[] {
  return text
    .split("\n\n")
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join(""),
    )
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data) as unknown)
}

export function eventTypes(sse: string): string[] {
  return parseSseEvents(sse).map((event) =>
    typeof (event as { type?: unknown }).type === "string"
      ? (event as { type: string }).type
      : "<no-type>",
  )
}

/** The reply aimock is told to give for a turn — and what the SSE must carry. */
export const replyFor = (userMessage: string): string => `ack ${userMessage}`

/** One aimock reply per turn, matched on the message that turn sends. */
export function turnFixtures(): AimockFixture[] {
  return TURNS.map((userMessage, index) => ({
    match: { turnIndex: index, userMessage },
    response: { content: replyFor(userMessage) },
  }))
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** A port nothing is listening on right now. */
export async function freePort(): Promise<number> {
  return await new Promise<number>((settle, fail) => {
    const server = createServer()
    server.once("error", fail)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close(() => fail(new Error("no port assigned")))
        return
      }
      const { port } = address
      server.close(() => settle(port))
    })
  })
}
