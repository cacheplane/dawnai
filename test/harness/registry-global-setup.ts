import {
  type LocalRegistry,
  publishWorkspace,
  REGISTRY_URL_ENV,
  startLocalRegistry,
} from "./local-registry.ts"

let registry: LocalRegistry | undefined
const NPM_REGISTRY_ENV = "npm_config_registry"

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
  // The scaffolded .npmrc (writeRegistryNpmrc) pins both the default registry and
  // the @dawn-ai scope, and clears an inherited default scope. Keep an environment-
  // level default-registry backstop for pnpm code paths that bypass project config
  // while resolving transitive dependencies. This does not override arbitrary
  // scope-specific registry mappings; the project @dawn-ai mapping handles Dawn
  // packages. Spawned installs inherit the backstop via process.env. A test that
  // manages its own registry (local-registry.test.ts) overrides it per command.
  process.env[NPM_REGISTRY_ENV] = registry.url
}

export async function teardown(): Promise<void> {
  await registry?.stop()
  delete process.env[REGISTRY_URL_ENV]
  delete process.env[NPM_REGISTRY_ENV]
}
