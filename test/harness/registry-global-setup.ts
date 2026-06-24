import {
  type LocalRegistry,
  publishWorkspace,
  REGISTRY_URL_ENV,
  startLocalRegistry,
} from "./local-registry.ts"

let registry: LocalRegistry | undefined

// Vitest runs globalSetup once per lane process, before workers fork. Setting the
// env var here propagates to forked workers (vitest default pool). Workers read it
// via getTestRegistryUrl().
export async function setup(): Promise<void> {
  registry = await startLocalRegistry()
  try {
    await publishWorkspace(registry.url)
  } catch (err) {
    await registry.stop()
    registry = undefined
    throw err
  }
  process.env[REGISTRY_URL_ENV] = registry.url
  // Pin every install spawned by this lane onto the test registry. The
  // scaffolded .npmrc (writeRegistryNpmrc) sets only the default `registry=`,
  // which pnpm bypasses when resolving transitive @dawn-ai/* deps — letting them
  // leak to npmjs. That is fatal mid-release: while a candidate version is only
  // partially published to npmjs, the leaked resolution fails (ERR_PNPM_NO_MATCHING_VERSION)
  // and deadlocks the very release that would make npmjs whole. npm_config_registry
  // is the highest-precedence npm config, so it forces ALL resolution (direct and
  // transitive) onto Verdaccio. Spawned installs inherit it via process.env. A
  // test that manages its own registry (local-registry.test.ts) overrides this
  // per-command with its own URL.
  process.env.npm_config_registry = registry.url
}

export async function teardown(): Promise<void> {
  await registry?.stop()
  delete process.env[REGISTRY_URL_ENV]
  delete process.env.npm_config_registry
}
