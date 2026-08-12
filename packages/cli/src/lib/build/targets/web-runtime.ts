import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { DawnConfig, RouteManifest } from "@dawn-ai/core"
import { providerPackages } from "@dawn-ai/langchain"
import { type BuiltInModelProviderId, inferProvider } from "@dawn-ai/sdk"

import { findMiddlewareFile } from "../../dev/middleware-node.js"
import { loadDawnConfig } from "../../node-config.js"
import { CliError, writeLine } from "../../output.js"
import { scanRouteProviders } from "../../runtime/collect-route-providers.js"
import { assertEdgeCapabilities, collectEdgeDependencyNotice } from "./edge-capabilities.js"
import { edgeAppNamespace, emitEdgeModulesFile } from "./edge-modules-emitter.js"
import type { BuildEmitContext } from "./index.js"
import { collectRouteStaticDiscovery, type RouteStaticDiscovery } from "./modules-emitter.js"
import { assertNoThreadAccessPolicy } from "./thread-access-probe.js"

export interface WebRuntimeEmitOptions {
  readonly outputDir: string
  readonly targetName: "hono" | "vercel"
}

export interface WebRuntimeArtifacts {
  readonly appPath: string
  readonly artifacts: readonly string[]
  readonly modulesPath: string
  readonly storesPath: string
}

function deploymentBundleName(targetName: WebRuntimeEmitOptions["targetName"]): string {
  return targetName === "hono" ? "edge bundle" : "Vercel deployment bundle"
}

/** Emit the host-neutral runtime files shared by web deployment targets. */
export async function emitWebRuntimeArtifacts(
  ctx: BuildEmitContext,
  options: WebRuntimeEmitOptions,
): Promise<WebRuntimeArtifacts> {
  const { appRoot, io, manifest } = ctx
  const { outputDir, targetName } = options

  // Complete every capability, provider, and config preflight before creating
  // the target directory. A failed staged build must leave no deployable-looking
  // partial output behind.
  //
  // The thread-access probe sits HERE, not at each target's `emit`, because
  // every target routed through this emitter is bundled: none of them can
  // perform the boot-time filesystem probe the policy loader needs. Enumerating
  // the call sites is how `vercel` shipped able to emit a policy-carrying app
  // with every thread endpoint ungated — the guard belongs on the shared path
  // so a future web target inherits it instead of having to remember it.
  assertNoThreadAccessPolicy(appRoot, targetName)
  const config = await loadBuildConfig(appRoot)
  assertEdgeCapabilities({ appRoot, config, manifest }, targetName)
  const providerImports = await resolveProviderImports(manifest, config, targetName)
  const storesEntry = STORES_ENTRY(targetName)
  const appEntry = emitAppEntry({ appRoot, config, providerImports, targetName })

  // The runtime's own discovery functions, run once here at build time —
  // identical to what the node target does, so the two manifests can only
  // ever disagree about the three lines the edge flavor changes.
  const discoveries: RouteStaticDiscovery[] = []
  for (const route of manifest.routes) {
    discoveries.push(await collectRouteStaticDiscovery({ appRoot, route }))
  }
  // The same resolution the dynamic probe performs — shared, not re-derived,
  // so a present-but-unreadable middleware file cannot drop out of the edge
  // manifest and ship an ungated bundle. The manifest carries the result, and
  // `createRuntimeFetchHandler` prefers `modules.middleware` — which is how
  // app.mjs mounts app middleware without a filesystem probe it could not
  // perform on the edge.
  const middlewareFile = findMiddlewareFile(appRoot)

  const modulesPath = join(outputDir, "modules.edge.mjs")
  const modulesEntry = emitEdgeModulesFile(
    {
      appRoot,
      buildDir: outputDir,
      discoveries,
      ...(middlewareFile ? { middlewareFile } : {}),
    },
    targetName,
  )

  await mkdir(outputDir, { recursive: true })

  await writeFile(modulesPath, modulesEntry, "utf8")

  const storesPath = join(outputDir, "stores.mjs")
  await writeFile(storesPath, storesEntry, "utf8")

  const appPath = join(outputDir, "app.mjs")
  await writeFile(appPath, appEntry, "utf8")

  // stderr, matching the node target's `warnIfCliNotRuntimeDependency`: this
  // is a ⚠ about a deploy that will fail to resolve an import, not part of the
  // artifact report a caller parses off stdout.
  if (io) {
    const notice = await collectEdgeDependencyNotice(appRoot, targetName)
    if (notice) writeLine(io.stderr, notice)
  }

  return {
    appPath,
    artifacts: [modulesPath, storesPath, appPath],
    modulesPath,
    storesPath,
  }
}

// ---------------------------------------------------------------------------
// stores.mjs
// ---------------------------------------------------------------------------

/**
 * The per-request store factory.
 *
 * Postgres over `@neondatabase/serverless`'s WebSocket pool is the only durable
 * combination proven on workerd (raw TCP `pg` needs Hyperdrive), so it is what
 * the scaffold emits. It is generated rather than hand-written because the
 * lifetime rule below is not obvious and getting it wrong fails intermittently.
 */
const STORES_ENTRY = (targetName: WebRuntimeEmitOptions["targetName"]): string => {
  const databaseUrlError =
    targetName === "hono"
      ? `"hono target: DATABASE_URL is not set on this worker's env, so no store can be built. " +
        "Add it as a Wrangler secret (\`wrangler secret put DATABASE_URL\`) or a [vars] entry — " +
        "or, on a host that passes no bindings (Node, Bun), set it in the environment."`
      : `"vercel target: DATABASE_URL is not set in the Vercel runtime environment, so no store can be built. " +
        "Add DATABASE_URL to this Vercel project's Environment Variables for the deployment environment, then redeploy."`
  const requestWithArticle = targetName === "hono" ? "an edge request" : "a Vercel function request"
  const runtimeLogTarget = targetName === "hono" ? "edge" : "vercel"

  return `// Generated by dawn build (${targetName} target). Regenerated on every build — do not edit.
//
// Every store ${requestWithArticle} needs, built fresh for that request and torn down
// when it settles. Wired into the runtime through \`requestStores\`, which
// disposes this only after the response body AND any run that outlived it have
// finished — never mid-stream.
import { readRuntimeEnv } from "@dawn-ai/cli/fetch"
import {
  createPostgresPermissionsStore,
  createPostgresThreadsStore,
  postgresCheckpointer,
} from "@dawn-ai/postgres-storage"
import { Client, Pool, types } from "@neondatabase/serverless"

/**
 * One binding, read the way Dawn reads every other knob.
 *
 * \`env\` is whatever the HOST passes as the fetch handler's second argument, and
 * only Workers makes that a bindings object. \`@hono/node-server\` passes
 * \`{ incoming, outgoing }\`, so \`env.DATABASE_URL\` is \`undefined\` there and a
 * Workers-shaped read would make this file Workers-ONLY — while the entry beside
 * it advertises Workers, Vercel and Bun.
 *
 * \`readRuntimeEnv\` closes that gap without reintroducing a \`process\` global: it
 * prefers \`globalThis.process?.env\` (a Node or Bun host, where the operator sets
 * DATABASE_URL in the environment) and otherwise falls back to the map app.mjs
 * seeded. On workerd \`env\` supplies the value and neither fallback is consulted.
 */
const binding = (env, name) => env?.[name] ?? readRuntimeEnv(name)

/**
 * Decode PostgreSQL's canonical hex BYTEA text without the driver's deprecated
 * Buffer constructor. Dawn's checkpoint serializer consumes Uint8Array, so the
 * result retains the driver's byte semantics without a process-global parser
 * override that could affect another request.
 */
const parseDawnByteaText = (value) => {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.charCodeAt(0) !== 92 ||
    value[1] !== "x"
  ) {
    throw new Error("postgres BYTEA text must use canonical hex format")
  }
  const hex = value.slice(2)
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("postgres BYTEA text contains malformed hex")
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16)
  }
  return bytes
}

/**
 * The pool's client class, carrying the local-wsproxy driver switches on the
 * INSTANCE — never on the \`neonConfig\` singleton.
 *
 * \`neonConfig\` is process-wide, and \`useSecureWebSocket\` defaults to TRUE. A
 * request that flipped it from its own \`DAWN_PG_WS_PROXY\` would therefore leave
 * every LATER request in the isolate connecting in PLAINTEXT, through a proxy it
 * never asked for — including requests carrying no such binding at all, and
 * including a production database, because that binding ships in every generated
 * stores.mjs and is one copied config away from being set by accident. It is
 * also the same cross-request leak app.mjs refuses to take with \`seedRuntimeEnv\`
 * two sections down, and TLS is a worse thing to take it with than configuration.
 *
 * So nothing global is written at all. The driver supports every one of these
 * switches per client (its CONFIG.md: "set options on individual \`Client\`
 * instances using their \`neonConfig\` property"), and \`Pool\` opens each
 * connection with \`new this.Client(this.options)\` — so a client class plus a
 * pool option is what carries a PER-REQUEST setting into a per-request pool,
 * with no shared state for a second request to inherit.
 *
 * Fails CLOSED if the driver ever stops routing through \`this.Client\`: an
 * override that does not apply leaves the secure defaults in place (TLS on, no
 * proxy), so the local wsproxy lane goes red rather than a deploy going quietly
 * plaintext.
 */
class DawnPgClient extends Client {
  constructor(config) {
    super(config)
    // Absent on every deploy that is not the local proxy lane — which is the
    // whole point: this branch is per instance, so NOT taking it is not
    // something a previous request can have decided.
    const wsProxy = config?.dawnWsProxy
    if (!wsProxy) return
    this.neonConfig.useSecureWebSocket = false
    this.neonConfig.pipelineTLS = false
    this.neonConfig.pipelineConnect = false
    this.neonConfig.wsProxy = (host, port) => \`\${wsProxy}/v1?address=\${host}:\${port}\`
  }
}

/**
 * Whether THIS ISOLATE has already migrated the database it talks to.
 *
 * Module scope is safe here in a way a module-scope POOL is not, and the
 * difference is the whole reason this is a boolean: a pool holds sockets bound
 * to the I/O context of the request that opened them, and reusing one across
 * requests hangs on workerd. A boolean holds nothing. Do not "fix" this by
 * hoisting the stores or the pool alongside it.
 *
 * Without it every request would re-run three migration transactions — each
 * taking \`pg_advisory_xact_lock\`, which also SERIALIZES concurrent requests on
 * the same component key — because a store memoizes its migration on the
 * INSTANCE, and instances here are per request.
 *
 * Only set after the migration actually succeeded, so a failed cold start does
 * not convince the next request the schema is there.
 */
let migrated = false

/**
 * One pool per request, closed on dispose.
 *
 * NOT module scope: an idle WebSocket returned to a module-scope pool belongs to
 * the PREVIOUS request's I/O context, and picking it up hangs for ~30s until
 * workerd cancels the request — alternating, so half of all requests fail
 * (verified against real workerd, 2026-08-07).
 *
 * Reads every knob through \`binding\` above, never off a bare \`process\` global:
 * \`process\` is not merely empty on workerd without the \`nodejs_compat\` flag
 * (which this target deliberately does not set) — it is undeclared, so touching
 * it is a ReferenceError.
 *
 * Owns the cleanup of a PARTIAL allocation: the runtime only ever disposes a
 * result this returned, so anything opened before a throw must be closed here.
 */
export async function createRequestStores(env) {
  const databaseUrl = binding(env, "DATABASE_URL")
  // Named here rather than surfacing as a driver-level connection error with no
  // hint of which binding is missing.
  if (!databaseUrl) {
    throw new Error(
      ${databaseUrlError},
    )
  }
  // The proxy is a per-request binding exactly like DATABASE_URL, so it is read
  // here and handed to the pool as an option rather than written anywhere shared.
  const pool = new Pool({
    connectionString: databaseUrl,
    dawnWsProxy: binding(env, "DAWN_PG_WS_PROXY"),
    types: {
      getTypeParser(id, format = "text") {
        if (id === 17 && format === "text") return parseDawnByteaText
        return types.getTypeParser(id, format)
      },
    },
  })
  // AFTER construction, not as a \`Client\` option: this driver's Pool overwrites
  // \`this.Client\` with its own class in its constructor. This assignment is what
  // makes \`dawnWsProxy\` above reach anything.
  pool.Client = DawnPgClient
  // Required, not defensive — and required HERE even though the pool is
  // per-request and short-lived.
  //
  // \`@neondatabase/serverless\` vendors \`pg-pool\`: its \`Pool\` re-emits an IDLE
  // client's failure on the POOL (\`makeIdleListener\` → \`pool.emit("error")\`),
  // exactly as node \`pg\` does. It also vendors the \`events\` polyfill rather than
  // importing \`node:events\` — and that shim throws on an 'error' with no
  // listener just like Node's does. So the hazard does NOT go away on an edge
  // runtime that lacks \`nodejs_compat\`; the shim is what is running.
  //
  // A client sits IDLE in this pool between every pair of queries the three
  // stores make, and a WebSocket dropped in that window (Neon autosuspend, a
  // proxy closing it, a blip) walks ws close → Client 'error' → pool 'error' →
  // throw, out of a socket event listener that no query promise is awaiting.
  // The throw therefore does not reject a query — it surfaces as an uncaught
  // exception and takes down the request, or the isolate.
  //
  // It also outlives \`dispose()\`: pg-pool's idle listener is not detached by
  // \`_remove\`, and its pool-level re-emit is not gated on \`ending\`, so a
  // half-open socket erroring during teardown can emit AFTER \`pool.end()\` —
  // when the response may already be sent. Attach once, never remove.
  //
  // Neon's own README prescribes this listener, and its \`Pool\` subclass
  // whitelists 'error' specifically so registering it does not disable
  // fetch-mode querying — the one listener it is safe to add.
  pool.on("error", (error) => {
    console.warn(\`[dawn:${runtimeLogTarget}] postgres pool client error (connection dropped): \${String(error)}\`)
  })
  try {
    const assumeMigrated = migrated
    const stores = {
      checkpointer: postgresCheckpointer({ pool, assumeMigrated }),
      dispose: () => pool.end(),
      permissionsStore: createPostgresPermissionsStore({ pool, assumeMigrated }),
      threadsStore: createPostgresThreadsStore({ pool, assumeMigrated }),
    }
    if (!assumeMigrated) {
      // The cold-start pass. Concurrent cold starts — across isolates AND
      // within this one — are exactly what the advisory lock inside each
      // \`ready()\` exists for; this flag only skips a pass already known to
      // have completed, it never runs a migration unlocked.
      await Promise.all([
        stores.checkpointer.ready(),
        stores.permissionsStore.ready(),
        stores.threadsStore.ready(),
      ])
      migrated = true
    }
    return stores
  } catch (error) {
    // Nothing was handed back, so nothing else will close this pool.
    void pool.end().catch(() => {})
    throw error
  }
}
`
}

// ---------------------------------------------------------------------------
// app.mjs
// ---------------------------------------------------------------------------

/**
 * Generate the Hono entry point.
 *
 * The subtlety is that `env` arrives PER INVOCATION on Workers, and the two
 * things that need it have opposite lifetimes:
 *
 *  - `envByRequest`, a WeakMap keyed on `c.req.raw` — the exact object
 *    `requestStores` is later called with, so each request's pool is built from
 *    its own bindings and the entries collect with the Request. A closure over
 *    the first `c.env` would send every later request to the first request's
 *    database, invisible in any single-request test;
 *  - `seedRuntimeEnvOnce`, which fills Dawn's PROCESS-GLOBAL env fallback, and
 *    is therefore seeded once per isolate rather than per request. The emitted
 *    comment carries the full argument; the short form is that re-seeding
 *    global state per request races concurrent in-flight requests, and buys
 *    nothing where the seed is actually read (workerd, whose env is fixed per
 *    deployment version).
 */
function emitAppEntry(options: {
  readonly appRoot: string
  readonly config: DawnConfig
  readonly providerImports: readonly string[]
  readonly targetName: WebRuntimeEmitOptions["targetName"]
}): string {
  const namespace = edgeAppNamespace(options.appRoot)
  const serializable = toSerializableConfig(options.config)
  const bundleName = deploymentBundleName(options.targetName)
  const entryDescription =
    options.targetName === "hono"
      ? `// The edge entry point: a Hono app whose single catch-all hands every request to
// Dawn's web-standard fetch handler. Default-exported, the shape Workers, Vercel
// and Bun all accept — import these same pieces yourself to compose it into a
// larger Hono app.`
      : `// The Vercel Node function entry point: a Hono app whose single catch-all hands
// every request to Dawn's web-standard fetch handler. Default-exported for the
// deployment bundler; import these same pieces yourself to compose it into a
// larger Hono app.`
  const runtimeConfiguration =
    options.targetName === "hono"
      ? `// WHERE THE CONFIGURATION COMES FROM depends on the host, and this file works on
// both without a build flag:
//
//  • Workers/workerd hands the fetch handler a BINDINGS object as its second
//    argument. That is the \`env\` seeded and bound below, and it is where
//    DATABASE_URL, OPENAI_BASE_URL and the rest come from;
//  • every other host passes something else, or nothing. \`@hono/node-server\`'s
//    \`serve({ fetch: app.fetch })\` passes \`{ incoming, outgoing }\` — Node request
//    and response handles, with no bindings in them at all. There the values are
//    read from the process environment instead, because stores.mjs and Dawn's own
//    env reads both go through \`readRuntimeEnv\`, which prefers \`process.env\`.
//
// So: set bindings with wrangler on Workers, and ordinary environment variables
// everywhere else. Nothing here reads a bare \`process\` global, which is what
// keeps the Workers half working without \`nodejs_compat\`.`
      : `// The Vercel Node function reads runtime configuration through \`process.env\`.
// Configure DATABASE_URL, provider keys and provider base URLs in the Vercel
// project environment for the deployment environment, then redeploy.`
  const requestEnvironmentError =
    options.targetName === "hono"
      ? `"hono target: no Workers env is bound to this Request, so the database connection cannot " +
        "be resolved. The generated app binds env inside its own catch-all — reaching the Dawn " +
        "handler by another path (Hono's \`mount()\`, which constructs a new Request, or a " +
        "hand-rolled call) skips that. Mount this app with \`app.route(path, dawnApp)\`, which " +
        "preserves the Request, or call \`createRequestStores(env)\` yourself."`
      : `"vercel target: no request environment is bound to this Request, so the database connection cannot " +
        "be resolved. The generated Vercel function binds request context inside its own catch-all — " +
        "reaching the Dawn handler by another path (Hono's \`mount()\`, which constructs a new Request, " +
        "or a hand-rolled call) skips that. Route this app with \`app.route(path, dawnApp)\`, which " +
        "preserves the Request, or call \`createRequestStores({})\` yourself so the Vercel project environment can be read."`

  return `// Generated by dawn build (${options.targetName} target). Regenerated on every build — do not edit.
//
${entryDescription}
//
${runtimeConfiguration}
import { createRuntimeFetchHandler, seedModelImporter, seedRuntimeEnv } from "@dawn-ai/cli/fetch"
import { Hono } from "hono"

import modules from "./modules.edge.mjs"
import { createRequestStores } from "./stores.mjs"

// The app's namespace id, identical to the one modules.edge.mjs bakes in.
// Nothing resolves it on a filesystem — it keys threads and caches — but it is
// rooted at "/" because Dawn's pure path helpers reject a relative base.
const APP_ROOT = ${JSON.stringify(namespace)}

// The app's dawn.config.ts, inlined at build time minus every field that cannot
// cross a build boundary (functions, class instances, store handles). Store
// instances come from stores.mjs, per request. Encoded through JSON.parse rather
// than as an object literal: a quoted "__proto__" key in a literal performs a
// prototype assignment instead of defining a property.
const config = JSON.parse(${JSON.stringify(JSON.stringify(serializable))})

${emitProviderImporter(options.providerImports, options.targetName)}
// Model packages are loaded through the map above instead of the runtime's
// default \`import(specifier)\`: a bundler cannot follow a variable specifier, so
// the default would leave the provider package out of the ${bundleName} entirely.
seedModelImporter(providerImporter)

// Workers hands \`env\` to the fetch handler PER INVOCATION, so the store factory
// cannot close over one request's env — every later request would then reach the
// first request's database. Keying it on the incoming Request (the same object
// the runtime passes back to \`requestStores\`) binds each request to its own.
const envByRequest = new WeakMap()

// Dawn's own environment reads — \`OPENAI_BASE_URL\` above all, plus the
// DAWN_DEBUG_* flags — go through \`readRuntimeEnv\`, which prefers \`process.env\`
// and falls back to whatever this seeds. Without the seed an edge deploy has no
// way to set any of them: \`process\` does not exist on workerd without
// \`nodejs_compat\`, which this target deliberately omits.
//
// SEEDED ONCE PER ISOLATE, from the FIRST request's env. Not per request, and
// the difference is not stylistic:
//
//  • unlike \`envByRequest\` above, the seed is process-global. Re-seeding it on
//    request B while request A is awaiting a model call would hand A request B's
//    configuration mid-flight — the same silent cross-request swap a shared pool
//    produces, on configuration instead of sockets.
//  • seeding once is no less correct, because the seed is only ever CONSULTED
//    where there is no \`process\` (\`readRuntimeEnv\` prefers \`process.env\`). The
//    runtime this is for is workerd, where \`env\` carries the deployment's
//    bindings and vars and one isolate serves exactly one deployment version —
//    so every invocation it handles sees identical values. Where env genuinely
//    varies per request (a Node or Bun host, a test harness) \`process\` exists
//    and wins, so a stale seed is not observable.
//  • and what must be right PER request does not come through this seam at all:
//    \`DATABASE_URL\` is read straight off that request's own \`env\` in stores.mjs,
//    which is exactly why that one can vary safely.
//
// So do not "simplify" this into a per-request seed.
let runtimeEnvSeeded = false

const seedRuntimeEnvOnce = (env) => {
  if (runtimeEnvSeeded) return
  runtimeEnvSeeded = true
  // A RuntimeEnv is a map of strings. Only Workers hands the fetch handler a
  // bindings object — a Node adapter's second argument is something else
  // entirely (\`@hono/node-server\` passes { incoming, outgoing }), and those
  // handles have no business in process-global state.
  const values = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") values[key] = value
  }
  seedRuntimeEnv(values)
}

const requestStores = (request) => {
  const env = envByRequest.get(request)
  // A miss is never benign: it means this Request never passed through the
  // catch-all below, so there is no env to read DATABASE_URL from and the pool
  // would silently be built with \`connectionString: undefined\`. Composing this
  // app under Hono's \`mount()\` does exactly that — mount constructs a NEW
  // Request, which is a different WeakMap key than the one bound below.
  if (env === undefined) {
    throw new Error(
      ${requestEnvironmentError},
    )
  }
  return createRequestStores(env)
}

// Built once per isolate and reused: the handler is stateless and does no I/O
// to construct (static manifest, injected config). Only the STORES are per
// request. Lazy so nothing runs in global scope, where I/O is not permitted.
//
// The .catch clears the slot so a rejection is not cached for the isolate's
// life. Construction does no I/O today, so a failure here is deterministic and
// retrying would only re-fail — but that is a property of today's runtime, not
// a guarantee, and this costs nothing.
let handlerPromise

const app = new Hono()

app.all("*", async (c) => {
  const request = c.req.raw
  const env = c.env ?? {}
  // Both BEFORE dispatch: the runtime calls requestStores during fetch(), and
  // a route's model is constructed inside that call.
  envByRequest.set(request, env)
  seedRuntimeEnvOnce(env)
  handlerPromise ??= createRuntimeFetchHandler({
    appRoot: APP_ROOT,
    config,
    modules,
    requestStores,
  }).catch((error) => {
    handlerPromise = undefined
    throw error
  })
  const handler = await handlerPromise
  return handler.fetch(request)
})

export default app
`
}

/**
 * Every model package this app can reach for at runtime, resolved to a sorted,
 * deduped list of literal specifiers — or a build failure naming what stopped
 * us working it out.
 *
 * EXHAUSTIVE is the requirement, not best-effort. Whatever is missing here is
 * missing from the bundle, and the runtime's own fallback message ("rebuild
 * with `dawn build`") would only reproduce the same gap, so every way the set
 * can come out narrower than reality has to fail the build instead:
 *
 *  - a route that will not import (`scanRouteProviders`'s `loadFailures`);
 *  - a route whose provider cannot be inferred from its model id;
 *  - `summarization.model`, which `defaultSummarize` resolves and imports on
 *    its own — an app with openai routes and an anthropic summarization model
 *    otherwise builds green and fails at runtime on `@langchain/anthropic`;
 *  - a provider with no entry in `providerPackages`.
 *
 * `memory.distill.model` is deliberately NOT included: distillation runs only
 * from `dawn memory consolidate`/`reflect`, never inside a request, and route
 * memory is gated off this target entirely.
 */
async function resolveProviderImports(
  manifest: RouteManifest,
  config: DawnConfig,
  targetName: WebRuntimeEmitOptions["targetName"],
): Promise<readonly string[]> {
  const scan = await scanRouteProviders(manifest)
  const bundleName = deploymentBundleName(targetName)

  if (scan.loadFailures.length > 0) {
    const lines = scan.loadFailures.map(
      ({ route, error }) =>
        `  • ${route.id} (${route.entryFile}): ${error instanceof Error ? error.message : String(error)}`,
    )
    throw new CliError(
      `${targetName} target: ${scan.loadFailures.length} route(s) could not be loaded, so the ${bundleName} ` +
        `cannot know which model package they need:\n\n${lines.join("\n")}\n\n` +
        `A build that skipped them would ship a bundle missing those packages and fail at request ` +
        `time. Fix the routes (\`dawn check\` reports import errors in full) and rebuild.`,
    )
  }

  if (scan.unresolved.length > 0) {
    const lines = scan.unresolved.map((route) => `  • ${route.id} (${route.entryFile})`)
    throw new CliError(
      `${targetName} target: ${scan.unresolved.length} agent route(s) use a model id Dawn cannot map to a ` +
        `provider, so the ${bundleName} cannot know which package to import:\n\n${lines.join("\n")}\n\n` +
        `Set \`provider\` explicitly on each agent().`,
    )
  }

  const providers = new Set<string>(scan.providers)

  const summarizationModel = config.summarization?.model
  if (summarizationModel !== undefined) {
    const provider = inferProvider(summarizationModel)
    if (!provider) {
      throw new CliError(
        `${targetName} target: \`summarization.model\` is "${summarizationModel}", which Dawn cannot map to ` +
          `a provider — so the ${bundleName} cannot know which package to import for it. Use a model ` +
          `id Dawn recognizes, or remove \`summarization.model\` to fall back to each route's own model.`,
      )
    }
    providers.add(provider)
  }

  return [...providers]
    .sort()
    .map((provider) => {
      const packageName = providerPackages[provider as BuiltInModelProviderId]
      if (!packageName) {
        throw new CliError(
          `${targetName} target: provider "${provider}" has no known model package, so the ` +
            `${bundleName} cannot import it. Known providers: ${Object.keys(providerPackages).sort().join(", ")}.`,
        )
      }
      return packageName
    })
    .sort()
}

/**
 * The static provider→package importer, covering exactly the packages
 * {@link resolveProviderImports} found.
 *
 * Every specifier is a literal so a bundler can see it; an app that adds a
 * provider must rebuild, which is also when the gating and the bundle would
 * have to change anyway.
 */
function emitProviderImporter(
  packageNames: readonly string[],
  targetName: WebRuntimeEmitOptions["targetName"],
): string {
  const bundleName = deploymentBundleName(targetName)
  const bundleWithArticle = targetName === "hono" ? "an edge bundle" : "a Vercel deployment bundle"
  const cases = [...new Set(packageNames)]
    .sort()
    .map((packageName) =>
      [
        `    case ${JSON.stringify(packageName)}:`,
        `      return import(${JSON.stringify(packageName)})`,
      ].join("\n"),
    )

  return `/** Static provider imports — the only kind ${bundleWithArticle} can resolve. */
const providerImporter = async (specifier) => {
  switch (specifier) {
${cases.join("\n")}
    default:
      throw new Error(
        \`This build has no ${bundleName} for "\${specifier}". Rebuild with \\\`dawn build\\\` after \` +
          "changing a model or provider — an agent's, or \`summarization.model\`. (The build fails " +
          "rather than narrowing this map, so a rebuild genuinely does re-derive it.)",
      )
  }
}
`
}

/** Load `dawn.config.ts` for inlining. A missing/broken config inlines `{}`. */
async function loadBuildConfig(appRoot: string): Promise<DawnConfig> {
  try {
    return (await loadDawnConfig({ appRoot })).config
  } catch {
    // Same posture as build.ts's own target-list read: no config is a valid
    // app, and a broken one is reported by `dawn check`, not here.
    return {}
  }
}

/**
 * Everything in the config that survives a build boundary.
 *
 * Drops functions, class instances, and any other non-JSON value wherever they
 * appear — which is exactly the set of fields that cannot be inlined: store
 * handles (`checkpointer`, `threadsStore`, `permissions.store`, `memory.store`),
 * backends, tokenizers, embedders, `resolveScope`. A plain object left EMPTY by
 * that stripping is dropped too, so a config carrying only a store handle does
 * not inline as a bare `{}` that reads like a configured store.
 *
 * Deliberately structural rather than a field blocklist: a new non-serializable
 * config field must not silently start being inlined as `null`.
 */
function toSerializableConfig(config: DawnConfig): Record<string, unknown> {
  return (stripNonSerializable(config) as Record<string, unknown> | undefined) ?? {}
}

/** `undefined` for anything that cannot be represented in JSON. */
function stripNonSerializable(value: unknown, seen = new Set<object>()): unknown {
  if (value === null) return null
  const kind = typeof value
  if (kind === "string" || kind === "boolean") return value
  if (kind === "number") return Number.isFinite(value as number) ? value : undefined
  if (kind !== "object") return undefined
  const object = value as object
  // Tracks the current ancestor chain only: a value referenced from two sibling
  // positions is legal JSON; only a true cycle is not.
  if (seen.has(object)) return undefined
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      // Holes and dropped entries become null, matching JSON.stringify.
      return object.map((entry) => stripNonSerializable(entry, seen) ?? null)
    }
    const proto = Object.getPrototypeOf(object)
    // Date, Map, Set, class instances (a checkpointer, a store) — JSON mutates
    // or empties them all, so none of them survives a build.
    if (proto !== Object.prototype && proto !== null) return undefined
    const entries = Object.entries(object)
    const kept: Record<string, unknown> = {}
    for (const [key, entry] of entries) {
      const stripped = stripNonSerializable(entry, seen)
      if (stripped !== undefined) kept[key] = stripped
    }
    if (entries.length > 0 && Object.keys(kept).length === 0) return undefined
    return kept
  } finally {
    seen.delete(object)
  }
}
